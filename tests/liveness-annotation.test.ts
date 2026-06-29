// tests/liveness-annotation.test.ts
// Unit tests for the liveness annotation added to listPeers (broker.ts).
//
// Coverage:
//   1. same-host live pid  → liveness = "alive"
//   2. same-host dead pid  → liveness = "dead"
//   3. cross-host peer     → liveness = "unknown" AND canSignalPid is NEVER called
//   4. host=null peer      → liveness = "unknown" AND canSignalPid is NEVER called

import { test, expect, beforeEach, afterEach } from "bun:test";
import { initDb, registerPeer, listPeers } from "../broker.ts";
import type { Database } from "bun:sqlite";
import type { SignalProbe } from "../shared/parent-liveness.ts";
import { unlinkSync, existsSync } from "node:fs";

let db: Database;
let TEST_DB: string;

const LOCAL_HOST = "test-host-local";

beforeEach(() => {
  TEST_DB = `/tmp/agent-peers-liveness-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  db = initDb(TEST_DB);
});
afterEach(() => {
  db.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

function reg(opts: {
  name?: string;
  host?: string | null;
  pid?: number;
}) {
  return registerPeer(db, {
    peer_type: "claude",
    pid: opts.pid ?? 1,
    cwd: "/x",
    git_root: null,
    tty: null,
    host: opts.host,
    summary: "",
    ...(opts.name ? { name: opts.name } : {}),
  });
}

test("same-host peer with live pid → liveness = alive", () => {
  const { id } = reg({ host: LOCAL_HOST, pid: 9991 });
  const liveProbe: SignalProbe = (_pid) => true; // always alive
  const peers = listPeers(db, { scope: "machine", cwd: "/x", git_root: null, exclude_id: undefined }, LOCAL_HOST, liveProbe);
  const peer = peers.find((p) => p.id === id);
  expect(peer).toBeDefined();
  expect(peer?.liveness).toBe("alive");
});

test("same-host peer with dead pid → liveness = dead", () => {
  const { id } = reg({ host: LOCAL_HOST, pid: 9992 });
  const deadProbe: SignalProbe = (_pid) => false; // always dead
  const peers = listPeers(db, { scope: "machine", cwd: "/x", git_root: null }, LOCAL_HOST, deadProbe);
  const peer = peers.find((p) => p.id === id);
  expect(peer).toBeDefined();
  expect(peer?.liveness).toBe("dead");
});

test("cross-host peer → liveness = unknown AND signalProbe is never called", () => {
  const { id } = reg({ host: "remote-host-other", pid: 9993 });
  let signalCallCount = 0;
  const spyProbe: SignalProbe = (_pid) => {
    signalCallCount++;
    throw new Error("canSignalPid must NEVER be called for cross-host peers");
  };
  const peers = listPeers(db, { scope: "machine", cwd: "/x", git_root: null }, LOCAL_HOST, spyProbe);
  const peer = peers.find((p) => p.id === id);
  expect(peer).toBeDefined();
  expect(peer?.liveness).toBe("unknown");
  expect(signalCallCount).toBe(0);
});

test("peer with null host → liveness = unknown AND signalProbe is never called", () => {
  const { id } = reg({ host: null, pid: 9994 });
  let signalCallCount = 0;
  const spyProbe: SignalProbe = (_pid) => {
    signalCallCount++;
    throw new Error("canSignalPid must NEVER be called for null-host peers");
  };
  const peers = listPeers(db, { scope: "machine", cwd: "/x", git_root: null }, LOCAL_HOST, spyProbe);
  const peer = peers.find((p) => p.id === id);
  expect(peer).toBeDefined();
  expect(peer?.liveness).toBe("unknown");
  expect(signalCallCount).toBe(0);
});

test("mixed batch: same-host live, same-host dead, cross-host all annotated correctly", () => {
  const { id: idLive }   = reg({ name: "local-live",   host: LOCAL_HOST,     pid: 9001 });
  const { id: idDead }   = reg({ name: "local-dead",   host: LOCAL_HOST,     pid: 9002 });
  const { id: idRemote } = reg({ name: "remote-peer",  host: "other-host",   pid: 9003 });

  // probe returns alive for pid 9001, dead for 9002; must NEVER be called for 9003
  const probe: SignalProbe = (pid) => {
    if (pid === 9003) throw new Error("must not probe cross-host pid");
    return pid === 9001;
  };

  const peers = listPeers(db, { scope: "machine", cwd: "/x", git_root: null }, LOCAL_HOST, probe);
  const byId = Object.fromEntries(peers.map((p) => [p.id, p]));

  expect(byId[idLive]?.liveness).toBe("alive");
  expect(byId[idDead]?.liveness).toBe("dead");
  expect(byId[idRemote]?.liveness).toBe("unknown");
});
