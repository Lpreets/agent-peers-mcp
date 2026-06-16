import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { __setTmuxWakeAdapterForTest, wakePeerIfIdle } from "../shared/tmux-wake.ts";
import type { WakeTarget } from "../shared/types.ts";

type PaneInfo = {
  tty: string;
  pane_id: string;
  command: string;
  cwd: string;
  title: string;
};

function target(overrides: Partial<WakeTarget> = {}): WakeTarget {
  return {
    peer_id: "peer-1",
    peer_type: "codex",
    name: "zesty-codex",
    cwd: "/repo",
    git_root: "/repo",
    tty: "pts/9",
    reason_id: "msg-1",
    ...overrides,
  };
}

function installFakeTmux(opts: {
  panes?: PaneInfo[];
  captures?: string[];
  failSendKeys?: boolean;
}) {
  const sent: string[] = [];
  const literals: string[] = [];
  const captures = [...(opts.captures ?? [])];
  __setTmuxWakeAdapterForTest({
    async listPanes() {
      return opts.panes ?? [];
    },
    async capturePane() {
      return captures.shift() ?? "";
    },
    async sendKeys(_paneId: string, ...keys: string[]) {
      if (opts.failSendKeys) throw new Error("send failed");
      sent.push(...keys);
    },
    async sendLiteral(_paneId: string, text: string) {
      literals.push(text);
    },
    async sleep() {
      return;
    },
  });
  return { sent, literals };
}

afterEach(() => {
  __setTmuxWakeAdapterForTest(null);
});

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/idle-active/${name}`, import.meta.url), "utf8");
}

const CODEX_IDLE = fixture("codex-0.137-idle.txt");
const CODEX_ACTIVE = fixture("codex-0.137-active.txt");
const CLAUDE_2170_IDLE = fixture("claude-2.1.170-idle.txt");
const CLAUDE_2170_ACTIVE = fixture("claude-2.1.170-active.txt");
const CONTAMINATED_HISTORY_WITH_IDLE_FOOTER = `
Bash(ls) Running...
esc to interrupt
old transcript that must not mark the current pane active
history filler 01
history filler 02
history filler 03
history filler 04
history filler 05
history filler 06
history filler 07
history filler 08
history filler 09
❯
Opus 4.8 Low · v2.1.170 · Context 51% Left · 5h 100% 7d 97% · 407 in 2 out · MSAASA master
⏵⏵ bypass permissions on (shift+tab to cycle)`;

test("off mode does not inspect tmux or send keys", async () => {
  const { sent, literals } = installFakeTmux({
    panes: [{ tty: "pts/9", pane_id: "%1", command: "codex", cwd: "/repo", title: "peer:zesty-codex" }],
    captures: [CODEX_IDLE, CODEX_IDLE],
  });
  const res = await wakePeerIfIdle(target(), "off");
  expect(res.result).toBe("skipped_not_idle");
  expect(res.idle_proof).toBe("wake mode off");
  expect(sent).toEqual([]);
  expect(literals).toEqual([]);
});

test("log-only validates idle target and sends zero keys", async () => {
  const { sent, literals } = installFakeTmux({
    panes: [{ tty: "pts/9", pane_id: "%1", command: "codex", cwd: "/repo/subdir", title: "peer:zesty-codex" }],
    captures: [CODEX_IDLE, CODEX_IDLE],
  });
  const res = await wakePeerIfIdle(target(), "log-only");
  expect(res.result).toBe("would_wake");
  expect(res.idle_proof).toContain("2 stable codex idle samples");
  expect(sent).toEqual([]);
  expect(literals).toEqual([]);
});

test("on mode sends content-free Codex F4 plus fixed prompt and delayed Enter", async () => {
  const { sent, literals } = installFakeTmux({
    panes: [{ tty: "/dev/pts/9", pane_id: "%1", command: "codex", cwd: "/repo", title: "peer:zesty-codex" }],
    captures: [CODEX_IDLE, CODEX_IDLE, CODEX_IDLE],
  });
  const res = await wakePeerIfIdle(target({ tty: "/dev/pts/9" }), "on");
  expect(res.result).toBe("woke");
  expect(sent).toEqual(["F4", "Enter"]);
  expect(literals).toEqual(["Check agent-peers now."]);
});

test("on mode sends fixed prompt only for Claude", async () => {
  const { sent, literals } = installFakeTmux({
    panes: [{ tty: "pts/4", pane_id: "%4", command: "claude", cwd: "/repo", title: "peer:zany-claude" }],
    captures: [CLAUDE_2170_IDLE, CLAUDE_2170_IDLE, CLAUDE_2170_IDLE],
  });
  const res = await wakePeerIfIdle(target({
    peer_type: "claude",
    name: "zany-claude",
    tty: "pts/4",
  }), "on");
  expect(res.result).toBe("woke");
  expect(sent).toEqual(["Enter"]);
  expect(literals).toEqual(["Check agent-peers now."]);
});

test("Claude 2.1.170 structural idle footer is accepted, but active spinner is not", async () => {
  const { sent: idleSent, literals: idleLiterals } = installFakeTmux({
    panes: [{ tty: "pts/4", pane_id: "%4", command: "claude", cwd: "/repo", title: "peer:zany-claude" }],
    captures: [CLAUDE_2170_IDLE, CLAUDE_2170_IDLE],
  });
  const idle = await wakePeerIfIdle(target({
    peer_type: "claude",
    name: "zany-claude",
    tty: "pts/4",
  }), "log-only");
  expect(idle.result).toBe("would_wake");
  expect(idle.idle_proof).toContain("2 stable claude idle samples");
  expect(idleSent).toEqual([]);
  expect(idleLiterals).toEqual([]);

  const { sent: activeSent, literals: activeLiterals } = installFakeTmux({
    panes: [{ tty: "pts/4", pane_id: "%4", command: "claude", cwd: "/repo", title: "peer:zany-claude" }],
    captures: [CLAUDE_2170_ACTIVE, CLAUDE_2170_ACTIVE],
  });
  const active = await wakePeerIfIdle(target({
    peer_type: "claude",
    name: "zany-claude",
    tty: "pts/4",
  }), "on");
  expect(active.result).toBe("skipped_not_idle");
  expect(activeSent).toEqual([]);
  expect(activeLiterals).toEqual([]);
});

test("old active transcript above the bottom band does not contaminate current idle proof", async () => {
  installFakeTmux({
    panes: [{ tty: "pts/4", pane_id: "%4", command: "claude", cwd: "/repo", title: "peer:zany-claude" }],
    captures: [CONTAMINATED_HISTORY_WITH_IDLE_FOOTER, CONTAMINATED_HISTORY_WITH_IDLE_FOOTER],
  });
  const res = await wakePeerIfIdle(target({
    peer_type: "claude",
    name: "zany-claude",
    tty: "pts/4",
  }), "log-only");
  expect(res.result).toBe("would_wake");
});

test("TOCTOU recheck skips if pane becomes active after idle proof but before nudge", async () => {
  const { sent, literals } = installFakeTmux({
    panes: [{ tty: "pts/9", pane_id: "%1", command: "codex", cwd: "/repo", title: "peer:zesty-codex" }],
    captures: [CODEX_IDLE, CODEX_IDLE, "esc to interrupt\nBash(date) Running..."],
  });
  const res = await wakePeerIfIdle(target(), "on");
  expect(res.result).toBe("skipped_active");
  expect(res.idle_proof).toContain("active before nudge");
  expect(sent).toEqual([]);
  expect(literals).toEqual([]);
});

test("active marker skips and injects no keys", async () => {
  const { sent, literals } = installFakeTmux({
    panes: [{ tty: "pts/9", pane_id: "%1", command: "codex", cwd: "/repo", title: "peer:zesty-codex" }],
    captures: [CODEX_ACTIVE, CODEX_IDLE],
  });
  const res = await wakePeerIfIdle(target(), "on");
  expect(res.result).toBe("skipped_not_idle");
  expect(sent).toEqual([]);
  expect(literals).toEqual([]);
});

test("out-of-scope cwd skips fail-closed", async () => {
  installFakeTmux({
    panes: [{ tty: "pts/9", pane_id: "%1", command: "codex", cwd: "/other", title: "peer:zesty-codex" }],
    captures: [CODEX_IDLE, CODEX_IDLE],
  });
  const res = await wakePeerIfIdle(target(), "log-only");
  expect(res.result).toBe("skipped_scope_mismatch");
});

test("duplicate tty candidates skip ambiguous", async () => {
  installFakeTmux({
    panes: [
      { tty: "pts/9", pane_id: "%1", command: "codex", cwd: "/repo", title: "peer:zesty-codex" },
      { tty: "/dev/pts/9", pane_id: "%2", command: "codex", cwd: "/repo", title: "peer:zesty-codex" },
    ],
    captures: [CODEX_IDLE, CODEX_IDLE],
  });
  const res = await wakePeerIfIdle(target(), "log-only");
  expect(res.result).toBe("skipped_ambiguous");
});

test("low-confidence identity only would-wakes in log-only", async () => {
  installFakeTmux({
    panes: [{ tty: "pts/9", pane_id: "%1", command: "codex", cwd: "/repo", title: "" }],
    captures: [CODEX_IDLE, CODEX_IDLE],
  });
  const logOnly = await wakePeerIfIdle(target(), "log-only");
  expect(logOnly.result).toBe("would_wake_low_confidence");

  installFakeTmux({
    panes: [{ tty: "pts/9", pane_id: "%1", command: "codex", cwd: "/repo", title: "" }],
    captures: [CODEX_IDLE, CODEX_IDLE],
  });
  const on = await wakePeerIfIdle(target(), "on");
  expect(on.result).toBe("skipped_ambiguous");
});

test("adapter errors are returned as non-fatal telemetry", async () => {
  __setTmuxWakeAdapterForTest({
    async listPanes() {
      throw new Error("tmux exploded");
    },
    async capturePane() {
      return "";
    },
    async sendKeys() {},
    async sendLiteral() {},
    async sleep() {},
  });
  const res = await wakePeerIfIdle(target(), "on");
  expect(res.result).toBe("error");
  expect(res.idle_proof).toContain("tmux exploded");
});
