import { expect, test } from "bun:test";
import { startWakeWorker, readWakeMode, type GetPeerFn } from "../shared/wake-worker.ts";
import type { Database } from "bun:sqlite";
import type { Peer, WakeDecision, WakeTarget, WakeMode } from "../shared/types.ts";

// A controllable clock + a recording wake mechanism let us prove the worker's
// queue/debounce/decoupling behaviour without any tmux or real DB.
function makePeer(over: Partial<Peer> = {}): Peer {
  return {
    id: "peer-1", name: "zappy-yak", peer_type: "codex", pid: 4242,
    cwd: "/home/x/proj", git_root: "/home/x/proj", tty: "/dev/pts/9",
    summary: "", registered_at: "2026-06-07T00:00:00.000Z",
    last_seen: "2026-06-07T00:00:00.000Z", ...over,
  };
}

const fakeDb = {} as unknown as Database;
const getPeer = (peer: Peer | null): GetPeerFn => () => peer;

// Recording wakeFn — captures every call + its returned decision.
function recordingWake(result: WakeDecision["result"] = "woke") {
  const calls: WakeTarget[] = [];
  const fn = async (target: WakeTarget, mode: WakeMode): Promise<WakeDecision> => {
    calls.push(target);
    return {
      peer_id: target.peer_id, name: target.name, peer_type: target.peer_type,
      tty: target.tty, cwd: target.cwd, result, reason_id: target.reason_id,
      mode, idle_proof: "test", at: "2026-06-07T00:00:00.000Z",
    };
  };
  return { fn, calls };
}

test("readWakeMode defaults to off and only accepts known values", () => {
  expect(readWakeMode({})).toBe("off");
  expect(readWakeMode({ AGENT_PEERS_WAKE_MODE: "bogus" })).toBe("off");
  expect(readWakeMode({ AGENT_PEERS_WAKE_MODE: "log-only" })).toBe("log-only");
  expect(readWakeMode({ AGENT_PEERS_WAKE_MODE: "ON" })).toBe("on");
});

test("off mode: enqueue is a no-op, mechanism never called, nothing pending", async () => {
  const wake = recordingWake();
  const w = startWakeWorker(fakeDb, { mode: "off", getPeer: getPeer(makePeer()), wakeFn: wake.fn });
  w.enqueue("peer-1", "msg-1");
  w.enqueue("peer-1", "msg-2");
  await w.drainOnce();
  expect(w.pendingCount()).toBe(0);
  expect(wake.calls.length).toBe(0);
  w.stop();
});

test("debounce: a burst of N messages to one peer coalesces to a single wake", async () => {
  let t = 1000;
  const wake = recordingWake();
  const logs: WakeDecision[] = [];
  const w = startWakeWorker(fakeDb, {
    mode: "on", getPeer: getPeer(makePeer()), wakeFn: wake.fn,
    logger: (d) => logs.push(d), now: () => t,
    quietWindowMs: 100, maxWaitMs: 10_000, drainMs: 1_000_000,
  });
  // 5 messages within the quiet window — not yet due.
  for (let i = 0; i < 5; i++) { w.enqueue("peer-1", `msg-${i}`); t += 10; }
  await w.drainOnce();
  expect(wake.calls.length).toBe(0);      // still coalescing
  expect(w.pendingCount()).toBe(1);
  // Quiet window elapses → exactly one wake for the whole burst.
  t += 200;
  await w.drainOnce();
  expect(wake.calls.length).toBe(1);
  expect(wake.calls[0]!.reason_id).toBe("msg-4"); // most recent in burst
  expect(logs.length).toBe(1);
  w.stop();
});

test("max-wait cap: a never-quiet flood still wakes once the cap is hit", async () => {
  let t = 0;
  const wake = recordingWake();
  const w = startWakeWorker(fakeDb, {
    mode: "on", getPeer: getPeer(makePeer()), wakeFn: wake.fn,
    now: () => t, quietWindowMs: 100, maxWaitMs: 500, drainMs: 1_000_000,
  });
  // Keep enqueuing so the quiet window never elapses...
  for (let i = 0; i < 10; i++) { w.enqueue("peer-1", `m-${i}`); t += 60; await w.drainOnce(); }
  // firstQueuedAt=0, now=600 > maxWaitMs=500 → forced due on the last drain.
  expect(wake.calls.length).toBe(1);
  w.stop();
});

test("delivery-independence: a throwing mechanism never throws out, logs result=error", async () => {
  let t = 0;
  const throwingWake = async (): Promise<WakeDecision> => { throw new Error("tmux exploded"); };
  const logs: WakeDecision[] = [];
  const w = startWakeWorker(fakeDb, {
    mode: "on", getPeer: getPeer(makePeer()), wakeFn: throwingWake,
    logger: (d) => logs.push(d), now: () => t, quietWindowMs: 0, drainMs: 1_000_000,
  });
  w.enqueue("peer-1", "msg-9");
  t += 10;
  await w.drainOnce(); // must not reject
  expect(logs.length).toBe(1);
  expect(logs[0]!.result).toBe("error");
  expect(logs[0]!.idle_proof).toContain("tmux exploded");
  w.stop();
});

test("peer gone at wake time: skipped_no_pane, mechanism not called", async () => {
  let t = 0;
  const wake = recordingWake();
  const logs: WakeDecision[] = [];
  const w = startWakeWorker(fakeDb, {
    mode: "on", getPeer: getPeer(null), wakeFn: wake.fn,
    logger: (d) => logs.push(d), now: () => t, quietWindowMs: 0, drainMs: 1_000_000,
  });
  w.enqueue("ghost", "msg-1");
  t += 10;
  await w.drainOnce();
  expect(wake.calls.length).toBe(0);
  expect(logs[0]!.result).toBe("skipped_no_pane");
  w.stop();
});

test("target is built from the FRESH peer row (tty/cwd/name), not the queued snapshot", async () => {
  let t = 0;
  const wake = recordingWake();
  const w = startWakeWorker(fakeDb, {
    mode: "log-only",
    getPeer: getPeer(makePeer({ tty: "/dev/pts/42", cwd: "/repo/sub", name: "fresh-name" })),
    wakeFn: wake.fn, now: () => t, quietWindowMs: 0, drainMs: 1_000_000,
  });
  w.enqueue("peer-1", "msg-1");
  t += 10;
  await w.drainOnce();
  expect(wake.calls[0]!.tty).toBe("/dev/pts/42");
  expect(wake.calls[0]!.cwd).toBe("/repo/sub");
  expect(wake.calls[0]!.name).toBe("fresh-name");
  w.stop();
});

test("WakeDecision telemetry carries no message body field (structural privacy guarantee)", async () => {
  let t = 0;
  const wake = recordingWake();
  const logs: WakeDecision[] = [];
  const w = startWakeWorker(fakeDb, {
    mode: "on", getPeer: getPeer(makePeer()), wakeFn: wake.fn,
    logger: (d) => logs.push(d), now: () => t, quietWindowMs: 0, drainMs: 1_000_000,
  });
  w.enqueue("peer-1", "msg-1");
  t += 10;
  await w.drainOnce();
  // The decision object never includes "text" or "message" keys.
  expect(Object.keys(logs[0]!)).not.toContain("text");
  expect(Object.keys(logs[0]!)).not.toContain("message");
  w.stop();
});
