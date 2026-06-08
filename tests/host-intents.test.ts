import { expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";
import { initDb, registerPeer } from "../broker.ts";
import {
  ackHostIntent,
  enqueueHostIntent,
  pollHostIntents,
} from "../shared/host-intents.ts";

let db: Database;
let TEST_DB: string;

beforeEach(() => {
  TEST_DB = `/tmp/agent-peers-host-intents-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  db = initDb(TEST_DB);
});

afterEach(() => {
  db.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

function peer(host = "lpreet-pc") {
  return registerPeer(db, {
    peer_type: "codex",
    host,
    pid: 1,
    cwd: "/repo",
    git_root: null,
    tty: "pts/9",
    summary: "",
  });
}

test("enqueueHostIntent writes a pending remote wake intent and coalesces active wake rows", () => {
  const target = peer();

  const first = enqueueHostIntent(db, {
    type: "wake",
    host_id: "lpreet-pc",
    target_peer_id: target.id,
    reason_id: "msg-1",
  });
  const second = enqueueHostIntent(db, {
    type: "wake",
    host_id: "lpreet-pc",
    target_peer_id: target.id,
    reason_id: "msg-2",
  });

  expect(second.id).toBe(first.id);
  const rows = db.query<{ reason_id: string; status: string }, []>(
    "SELECT reason_id, status FROM host_intents"
  ).all();
  expect(rows).toEqual([{ reason_id: "msg-2", status: "pending" }]);
});

test("pollHostIntents leases only one host and redelivers after lease expiry", () => {
  const pc = peer("lpreet-pc");
  const server = peer("lpreet-server");
  enqueueHostIntent(db, { type: "wake", host_id: "lpreet-pc", target_peer_id: pc.id, reason_id: "pc-msg" });
  enqueueHostIntent(db, { type: "wake", host_id: "lpreet-server", target_peer_id: server.id, reason_id: "server-msg" });

  const leased = pollHostIntents(db, {
    host_id: "lpreet-pc",
    now: "2026-06-08T08:00:00.000Z",
    lease_duration_ms: 1000,
  });
  expect(leased).toHaveLength(1);
  expect(leased[0]!.host_id).toBe("lpreet-pc");
  expect(leased[0]!.lease_token).toBeTruthy();

  expect(pollHostIntents(db, {
    host_id: "lpreet-pc",
    now: "2026-06-08T08:00:00.500Z",
    lease_duration_ms: 1000,
  })).toHaveLength(0);

  const redelivered = pollHostIntents(db, {
    host_id: "lpreet-pc",
    now: "2026-06-08T08:00:01.001Z",
    lease_duration_ms: 1000,
  });
  expect(redelivered).toHaveLength(1);
  expect(redelivered[0]!.id).toBe(leased[0]!.id);

  const untouched = db.query<{ c: number }, []>(
    "SELECT COUNT(*) AS c FROM host_intents WHERE host_id = 'lpreet-server' AND status = 'pending'"
  ).get()!.c;
  expect(untouched).toBe(1);
});

test("ackHostIntent marks leased rows done or failed only with the matching lease token", () => {
  const target = peer();
  enqueueHostIntent(db, { type: "wake", host_id: "lpreet-pc", target_peer_id: target.id, reason_id: "msg-1" });
  const [leased] = pollHostIntents(db, {
    host_id: "lpreet-pc",
    now: "2026-06-08T08:00:00.000Z",
    lease_duration_ms: 1000,
  });
  expect(leased).toBeDefined();

  const wrong = ackHostIntent(db, {
    id: leased!.id,
    lease_token: "wrong",
    status: "done",
    result: "woke",
  });
  expect(wrong.acked).toBe(0);

  const ok = ackHostIntent(db, {
    id: leased!.id,
    lease_token: leased!.lease_token!,
    status: "done",
    result: "woke",
    idle_proof: "test",
  });
  expect(ok.acked).toBe(1);
  const row = db.query<{ status: string; result: string; idle_proof: string }, []>(
    "SELECT status, result, idle_proof FROM host_intents WHERE id = 1"
  ).get();
  expect(row).toEqual({ status: "done", result: "woke", idle_proof: "test" });
});

test("completed wake intents no longer occupy the active coalescing slot", () => {
  const target = peer();
  const first = enqueueHostIntent(db, { type: "wake", host_id: "lpreet-pc", target_peer_id: target.id, reason_id: "msg-1" });
  const [leased] = pollHostIntents(db, {
    host_id: "lpreet-pc",
    now: "2026-06-08T08:00:00.000Z",
    lease_duration_ms: 1000,
  });
  ackHostIntent(db, { id: leased!.id, lease_token: leased!.lease_token!, status: "done", result: "woke" });

  const second = enqueueHostIntent(db, { type: "wake", host_id: "lpreet-pc", target_peer_id: target.id, reason_id: "msg-2" });
  expect(second.id).not.toBe(first.id);
});

