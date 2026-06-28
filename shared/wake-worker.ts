// shared/wake-worker.ts
// S310 Fix 1 — broker-daemon-side idle-safe wake worker.
//
// Root cause this addresses: agent-peers is poll-based — an idle peer never
// takes a turn, never polls, and so never sees a delivered message until it is
// externally tmux-woken (broker.ts sendMessage is a pure durable insert;
// pollMessages is the only writer of last_seen). The wake must originate from
// the broker daemon (the only long-lived process that knows every peer's tty),
// because neither client can wake itself on a post-idle message arrival
// (claude-server.ts:91, codex-server.ts:126).
//
// SAFETY ARCHITECTURE (do not weaken without re-ratification — HIGH-BLAST):
//   1. Decoupled from delivery: enqueue() is fire-and-forget, called AFTER
//      sendMessage commits. A wake failure can NEVER roll back or delay a
//      message — delivery already returned ok to the sender.
//   2. Feature-flagged: AGENT_PEERS_WAKE_MODE = off (default) | log-only | on.
//      In "off", enqueue() is a literal no-op — zero overhead, behaviour
//      identical to pre-Fix-1.
//   3. The actual idle-proof + keystroke decision lives in the injected
//      wakePeerIfIdle mechanism (shared/tmux-wake.ts). This worker only
//      decides WHEN to attempt (queue + debounce/coalesce) and records the
//      structured WakeDecision telemetry (never message body / secrets).

import type { Database } from "bun:sqlite";
import type {
  Peer, PeerId, WakeMode, WakeTarget, WakeDecision, WakePeerIfIdle,
} from "./types.ts";
import { wakePeerIfIdle as defaultWakeFn } from "./tmux-wake.ts";

// ---- Tunables (env-overridable for tests) ----
export const WAKE_DRAIN_MS = parseInt(process.env.AGENT_PEERS_WAKE_DRAIN_MS ?? "1000", 10);
// A target is woken once it has been "quiet" (no new message) for this long —
// coalesces a burst of N messages into a single wake.
export const WAKE_QUIET_WINDOW_MS = parseInt(process.env.AGENT_PEERS_WAKE_QUIET_MS ?? "1500", 10);
// Hard cap so a never-quiet flood can't starve the wake forever.
export const WAKE_MAX_WAIT_MS = parseInt(process.env.AGENT_PEERS_WAKE_MAX_WAIT_MS ?? "8000", 10);

export function readWakeMode(env: Record<string, string | undefined> = process.env): WakeMode {
  const v = (env.AGENT_PEERS_WAKE_MODE ?? "off").trim().toLowerCase();
  return v === "on" || v === "log-only" ? (v as WakeMode) : "off";
}

export function readWakeClaude(env: Record<string, string | undefined> = process.env): "off" | "on" {
  return (env.AGENT_PEERS_WAKE_CLAUDE ?? "off").trim().toLowerCase() === "on" ? "on" : "off";
}

interface QueueEntry {
  peer_id: PeerId;
  firstQueuedAt: number;
  lastQueuedAt: number;
  count: number;
  reason_id: string; // correlation id of the most recent message in the burst
}

// Structured telemetry sink — defaults to stderr (broker convention), but is
// injectable for tests. Logs carry identity + decision only, never body.
export type WakeLogger = (decision: WakeDecision) => void;

const defaultLogger: WakeLogger = (d) => {
  // One line, machine-greppable, NO message text.
  console.error(
    `[wake] result=${d.result} peer=${d.name}(${d.peer_type}) tty=${d.tty ?? "-"} ` +
    `mode=${d.mode} reason=${d.reason_id}` + (d.idle_proof ? ` proof="${d.idle_proof}"` : ""),
  );
};

export type GetPeerFn = (db: Database, id: PeerId) => Peer | null;

export interface WakeWorkerOptions {
  // getPeer is injected from the broker call site (it lives in broker.ts) to
  // avoid a broker<->wake-worker import cycle. Required on enabled modes;
  // ignored when mode is off.
  getPeer: GetPeerFn;
  mode?: WakeMode;            // default: readWakeMode()
  wakeFn?: WakePeerIfIdle;    // default: the real shared/tmux-wake.ts mechanism
  hostId?: string | null;     // when set, non-null peer.host != hostId routes to remote intent hook
  enqueueRemoteIntent?: (peer: Peer, reason_id: string) => void | Promise<void>;
  logger?: WakeLogger;        // default: stderr
  drainMs?: number;
  quietWindowMs?: number;
  maxWaitMs?: number;
  now?: () => number;         // injectable clock for deterministic tests
}

export interface WakeWorker {
  enqueue(to_id: PeerId, reason_id: string): void;
  // Drain due entries once. Exposed for deterministic testing; the interval
  // calls this internally.
  drainOnce(): Promise<void>;
  stop(): void;
  readonly mode: WakeMode;
  // Visible for tests/inspection — size of the pending coalesce queue.
  pendingCount(): number;
}

/**
 * Start the wake worker. Returns a handle wired into startBroker():
 *   - enqueue() is called fire-and-forget from the /send-message route.
 *   - stop() is called from broker cleanup (SIGINT/SIGTERM).
 * When mode === "off", this returns an inert worker whose enqueue() is a no-op.
 */
export function startWakeWorker(db: Database, opts: WakeWorkerOptions): WakeWorker {
  const mode: WakeMode = opts.mode ?? readWakeMode();
  const drainMs = opts.drainMs ?? WAKE_DRAIN_MS;
  const quietWindowMs = opts.quietWindowMs ?? WAKE_QUIET_WINDOW_MS;
  const maxWaitMs = opts.maxWaitMs ?? WAKE_MAX_WAIT_MS;
  const logger = opts.logger ?? defaultLogger;
  const now = opts.now ?? (() => Date.now());

  // OFF: fully inert. No queue, no timer, no getPeer/wakeFn resolution.
  if (mode === "off") {
    return {
      enqueue() { /* no-op: wake layer disabled */ },
      async drainOnce() { /* no-op */ },
      stop() { /* no-op */ },
      mode,
      pendingCount() { return 0; },
    };
  }

  const getPeer = opts.getPeer;
  const wakeFn = opts.wakeFn ?? defaultWakeFn;

  const queue = new Map<PeerId, QueueEntry>();
  let draining = false;

  function enqueue(to_id: PeerId, reason_id: string): void {
    const t = now();
    const existing = queue.get(to_id);
    if (existing) {
      existing.lastQueuedAt = t;
      existing.count += 1;
      existing.reason_id = reason_id;
    } else {
      queue.set(to_id, { peer_id: to_id, firstQueuedAt: t, lastQueuedAt: t, count: 1, reason_id });
    }
  }

  function isDue(e: QueueEntry, t: number): boolean {
    // Quiet long enough (burst settled) OR waited past the starvation cap.
    return (t - e.lastQueuedAt) >= quietWindowMs || (t - e.firstQueuedAt) >= maxWaitMs;
  }

  async function drainOnce(): Promise<void> {
    if (draining) return; // never overlap drains
    draining = true;
    try {
      const t = now();
      const due: QueueEntry[] = [];
      for (const e of queue.values()) {
        if (isDue(e, t)) due.push(e);
      }
      for (const e of due) {
        // Remove BEFORE awaiting so concurrent enqueues during the await start
        // a fresh coalesce window rather than being lost.
        queue.delete(e.peer_id);
        const decision = await runWake(e);
        if (decision) logger(decision);
      }
    } finally {
      draining = false;
    }
  }

  async function runWake(e: QueueEntry): Promise<WakeDecision | null> {
    // Resolve the peer fresh at wake time — the stored row is the source of
    // truth for tty/cwd/name; never trust the queued snapshot.
    let peer: Peer | null = null;
    try {
      peer = getPeer(db, e.peer_id);
    } catch {
      peer = null;
    }
    if (!peer) {
      return {
        peer_id: e.peer_id, name: "(gone)", peer_type: "claude",
        tty: null, cwd: "", result: "skipped_no_pane",
        reason_id: e.reason_id, mode, idle_proof: "peer row gone at wake time",
        at: new Date(now()).toISOString(),
      };
    }
    if (peer.host && opts.hostId && peer.host !== opts.hostId && opts.enqueueRemoteIntent) {
      try {
        await opts.enqueueRemoteIntent(peer, e.reason_id);
        return {
          peer_id: peer.id, name: peer.name, peer_type: peer.peer_type,
          tty: peer.tty, cwd: peer.cwd, result: "queued_remote",
          reason_id: e.reason_id, mode,
          idle_proof: `queued host-local intent for ${peer.host}`,
          at: new Date(now()).toISOString(),
        };
      } catch (err) {
        return {
          peer_id: peer.id, name: peer.name, peer_type: peer.peer_type,
          tty: peer.tty, cwd: peer.cwd, result: "error",
          reason_id: e.reason_id, mode,
          idle_proof: `remote intent enqueue threw: ${err instanceof Error ? err.message : String(err)}`,
          at: new Date(now()).toISOString(),
        };
      }
    }
    const target: WakeTarget = {
      peer_id: peer.id,
      peer_type: peer.peer_type,
      name: peer.name,
      cwd: peer.cwd,
      git_root: peer.git_root,
      tty: peer.tty,
      reason_id: e.reason_id,
    };
    try {
      // The mechanism is contract-bound to catch internally and return
      // result:"error"; this try is belt-and-suspenders so a thrown mechanism
      // can NEVER crash the daemon or affect delivery.
      return await wakeFn(target, mode);
    } catch (err) {
      return {
        peer_id: peer.id, name: peer.name, peer_type: peer.peer_type,
        tty: peer.tty, cwd: peer.cwd, result: "error",
        reason_id: e.reason_id, mode,
        idle_proof: `mechanism threw: ${err instanceof Error ? err.message : String(err)}`,
        at: new Date(now()).toISOString(),
      };
    }
  }

  const timer = setInterval(() => { void drainOnce(); }, drainMs);
  // Don't keep the process alive solely for the wake timer.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  return {
    enqueue,
    drainOnce,
    stop() { clearInterval(timer); queue.clear(); },
    mode,
    pendingCount() { return queue.size; },
  };
}
