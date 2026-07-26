// tests/gc-reclaim-race.test.ts
//
// S348 — reclaim must deterministically beat GC (Codex RV landing condition).
//
// gcStalePeers used STALE_THRESHOLD_MS, the SAME 60s boundary as
// STALE_RECLAIM_THRESHOLD_MS. So at the exact moment a rotated successor became
// able to reclaim its predecessor's row, GC became able to delete it. Whoever
// won decided whether the successor kept the peer's uuid/name/inbox or came up
// as a brand-new peer — silently orphaning every message addressed to the old
// uuid. "Eventually registered" is not sufficient; it must be reclaimed.
//
// Covers Codex RV assertions 3-5 at the broker-contract level: reclaim after
// the window retains identity, invalidates the old session, preserves the
// inbox — and a still-live holder is never replaced.

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  registerPeer,
  heartbeatPeer,
  gcStalePeers,
  getPeer,
  sendMessage,
  pollMessages,
  SessionExpiredError,
  LiveHolderConflictError,
  STALE_RECLAIM_THRESHOLD_MS,
  PEER_GC_RETENTION_MS,
} from "../broker.ts";
import type { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";

let db: Database;
let TEST_DB: string;

beforeEach(() => {
  TEST_DB = `/tmp/agent-peers-s348-gc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  db = initDb(TEST_DB);
});
afterEach(() => {
  db.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

/** Same physical identity tuple a rotated pane reuses: (peer_type, cwd, tty). */
const TUPLE = { peer_type: "codex" as const, cwd: "/w/rotating-pane", tty: "pts/99" };

function regRotationPeer(over: Record<string, unknown> = {}) {
  return registerPeer(db, {
    ...TUPLE, pid: 4242, git_root: null, summary: "", ...over,
  } as Parameters<typeof registerPeer>[1]);
}

function backdate(id: string, ms: number) {
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run(new Date(Date.now() - ms).toISOString(), id);
}

test("INVARIANT: GC retention is strictly greater than the reclaim threshold", () => {
  // If these are ever equalised again, the race below silently returns.
  expect(PEER_GC_RETENTION_MS).toBeGreaterThan(STALE_RECLAIM_THRESHOLD_MS);
});

test("a row past the reclaim threshold is still present for the successor to reclaim", () => {
  const holder = regRotationPeer({ name: "msaasa-codex" });
  // Predecessor killed by respawn-pane; its row ages past the reclaim window.
  backdate(holder.id, STALE_RECLAIM_THRESHOLD_MS + 10_000);

  // GC runs every 30s — it must NOT remove the row the successor needs.
  expect(gcStalePeers(db)).toBe(0);
  expect(getPeer(db, holder.id)).not.toBeNull();
});

test("successor RECLAIMS after the window: same uuid+name, old session dead, inbox survives", () => {
  const sender = registerPeer(db, {
    peer_type: "claude", cwd: "/w/other", tty: "pts/1", pid: 1,
    git_root: null, summary: "", name: "msaasa-claude",
  } as Parameters<typeof registerPeer>[1]);
  const holder = regRotationPeer({ name: "msaasa-codex" });

  // A message arrives for the peer and is never read before the rotation.
  sendMessage(db, {
    from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: "msaasa-codex", text: "survives the rotation",
  });

  backdate(holder.id, STALE_RECLAIM_THRESHOLD_MS + 10_000);
  expect(gcStalePeers(db)).toBe(0); // reclaim wins the race

  const successor = regRotationPeer({ pid: 5555 });

  // Identity continuity — NOT a new peer.
  expect(successor.id).toBe(holder.id);
  expect(successor.name).toBe("msaasa-codex");
  expect(successor.session_token).not.toBe(holder.session_token);

  // Old session token is invalid.
  expect(() => heartbeatPeer(db, holder.id, holder.session_token))
    .toThrow(SessionExpiredError);

  // The undelivered message is still addressed to the SAME uuid and readable.
  const inbox = pollMessages(db, successor.id, successor.session_token);
  expect(inbox.length).toBe(1);
  expect(inbox[0]!.text).toBe("survives the rotation");
});

test("NEGATIVE: a still-live holder is never replaced", () => {
  const holder = regRotationPeer({ name: "msaasa-codex" });
  // Holder keeps heartbeating — exactly the case retry must NOT defeat.
  heartbeatPeer(db, holder.id, holder.session_token);

  expect(() => regRotationPeer({ pid: 6666 })).toThrow(LiveHolderConflictError);

  // And it is still the original holder, untouched.
  const row = getPeer(db, holder.id);
  expect(row).not.toBeNull();
  expect(row!.name).toBe("msaasa-codex");
});

test("GC still reaps rows past the retention horizon", () => {
  // Retention delays deletion; it must not disable it.
  const holder = regRotationPeer({ name: "msaasa-codex" });
  backdate(holder.id, PEER_GC_RETENTION_MS + 10_000);
  expect(gcStalePeers(db)).toBe(1);
  expect(getPeer(db, holder.id)).toBeNull();
});
