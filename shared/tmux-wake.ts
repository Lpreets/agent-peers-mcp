import { execFileSync } from "node:child_process";
import type { WakeDecision, WakeMode, WakePeerIfIdle, WakeTarget } from "./types.ts";

type PaneInfo = {
  tty: string;
  pane_id: string;
  command: string;
  cwd: string;
  title: string;
};

type TmuxWakeAdapter = {
  listPanes(): Promise<PaneInfo[]>;
  capturePane(paneId: string): Promise<string>;
  sendKeys(paneId: string, ...keys: string[]): Promise<void>;
  sendLiteral(paneId: string, text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
};

const ACTIVE_MARKERS =
  /esc to interrupt|Working \(|tool_use|Bash\(|Running|Thinking|Messages to be submitted|Do you want to/i;
const CODEX_EXTRA_ACTIVE = /Update available|Update now|new Codex version|Hooks need review/i;
const CLAUDE_IDLE = /bypass permissions on|Context [0-9]+%( [Ll]eft)?/;
const CODEX_IDLE = /gpt-5[\s\S]*Context [0-9]+%( [Ll]eft)?/;
const WAKE_TEXT = "Check agent-peers now.";

function normalizeTty(tty: string | null): string | null {
  if (!tty) return null;
  return tty.replace(/^\/dev\//, "");
}

function execTmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const defaultAdapter: TmuxWakeAdapter = {
  async listPanes() {
    const out = execTmux([
      "list-panes",
      "-a",
      "-F",
      "#{pane_tty}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}",
    ]);
    return out.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [tty = "", pane_id = "", command = "", cwd = "", title = ""] = line.split("\t");
        return { tty: normalizeTty(tty) ?? "", pane_id, command, cwd, title };
      });
  },
  async capturePane(paneId: string) {
    return execTmux(["capture-pane", "-p", "-S", "-5", "-t", paneId]);
  },
  async sendKeys(paneId: string, ...keys: string[]) {
    execTmux(["send-keys", "-t", paneId, ...keys]);
  },
  async sendLiteral(paneId: string, text: string) {
    execTmux(["send-keys", "-t", paneId, "-l", text]);
  },
  async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
};

let adapter: TmuxWakeAdapter = defaultAdapter;

export function __setTmuxWakeAdapterForTest(next: TmuxWakeAdapter | null): void {
  adapter = next ?? defaultAdapter;
}

function decision(
  target: WakeTarget,
  mode: WakeMode,
  result: WakeDecision["result"],
  idle_proof?: string,
): WakeDecision {
  return {
    peer_id: target.peer_id,
    name: target.name,
    peer_type: target.peer_type,
    tty: target.tty,
    cwd: target.cwd,
    result,
    reason_id: target.reason_id,
    mode,
    ...(idle_proof ? { idle_proof } : {}),
    at: new Date().toISOString(),
  };
}

function isPathInScope(path: string, target: WakeTarget): boolean {
  const root = target.git_root || target.cwd;
  if (!root) return false;
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function commandMatches(command: string, peerType: WakeTarget["peer_type"]): boolean {
  return command === peerType;
}

function isHighConfidenceIdentity(pane: PaneInfo, target: WakeTarget): boolean {
  return pane.title === `peer:${target.name}`;
}

function hasActiveMarker(text: string, peerType: WakeTarget["peer_type"]): boolean {
  if (ACTIVE_MARKERS.test(text)) return true;
  return peerType === "codex" && CODEX_EXTRA_ACTIVE.test(text);
}

function hasIdleMarker(text: string, peerType: WakeTarget["peer_type"]): boolean {
  return peerType === "codex" ? CODEX_IDLE.test(text) : CLAUDE_IDLE.test(text);
}

function summarizeIdleProof(text: string, peerType: WakeTarget["peer_type"]): string {
  const context = text.match(/Context [0-9]+%( [Ll]eft)?/)?.[0] ?? "Context unknown";
  return `2 stable ${peerType} idle samples; footer=${context}`;
}

async function twoSampleIdleProof(paneId: string, peerType: WakeTarget["peer_type"]): Promise<string | null> {
  const first = await adapter.capturePane(paneId);
  if (hasActiveMarker(first, peerType) || !hasIdleMarker(first, peerType)) return null;
  await adapter.sleep(1000);
  const second = await adapter.capturePane(paneId);
  if (hasActiveMarker(second, peerType) || !hasIdleMarker(second, peerType)) return null;
  return summarizeIdleProof(second, peerType);
}

async function nudge(paneId: string, peerType: WakeTarget["peer_type"]): Promise<boolean> {
  const latest = await adapter.capturePane(paneId);
  if (hasActiveMarker(latest, peerType) || !hasIdleMarker(latest, peerType)) return false;
  if (peerType === "codex") {
    try {
      await adapter.sendKeys(paneId, "F4");
    } catch {
      // F4 is best-effort legacy Codex wake canon. The fixed prompt is still the actual nudge.
    }
    await adapter.sendLiteral(paneId, WAKE_TEXT);
    await adapter.sleep(1000);
    await adapter.sendKeys(paneId, "Enter");
    return true;
  }
  await adapter.sendLiteral(paneId, WAKE_TEXT);
  await adapter.sendKeys(paneId, "Enter");
  return true;
}

export const wakePeerIfIdle: WakePeerIfIdle = async (target, mode) => {
  try {
    if (mode === "off") {
      return decision(target, mode, "skipped_not_idle", "wake mode off");
    }

    const tty = normalizeTty(target.tty);
    if (!tty) return decision(target, mode, "skipped_no_pane", "target has no tty");

    const panes = (await adapter.listPanes()).filter((pane) => normalizeTty(pane.tty) === tty);
    if (panes.length === 0) return decision(target, mode, "skipped_no_pane", `tty ${tty} has no live pane`);
    if (panes.length > 1) return decision(target, mode, "skipped_ambiguous", `tty ${tty} matched ${panes.length} panes`);

    const pane = panes[0]!;
    if (!isPathInScope(pane.cwd, target)) {
      return decision(target, mode, "skipped_scope_mismatch", `pane cwd outside scope; tty=${tty}`);
    }
    if (!commandMatches(pane.command, target.peer_type)) {
      return decision(target, mode, "skipped_ambiguous", `pane command ${pane.command} does not match ${target.peer_type}`);
    }

    const highConfidence = isHighConfidenceIdentity(pane, target);
    const proof = await twoSampleIdleProof(pane.pane_id, target.peer_type);
    if (!proof) return decision(target, mode, "skipped_not_idle", `no positive idle proof; tty=${tty}`);

    if (!highConfidence) {
      if (mode === "log-only") {
        return decision(target, mode, "would_wake_low_confidence", `${proof}; title/name missing`);
      }
      return decision(target, mode, "skipped_ambiguous", `${proof}; missing second identity signal`);
    }

    if (mode === "log-only") return decision(target, mode, "would_wake", proof);

    if (!(await nudge(pane.pane_id, target.peer_type))) {
      return decision(target, mode, "skipped_active", `${proof}; active before nudge`);
    }
    return decision(target, mode, "woke", proof);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return decision(target, mode, "error", `tmux wake error: ${message.slice(0, 160)}`);
  }
};

export default wakePeerIfIdle;
