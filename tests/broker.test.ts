// Comprehensive unit tests for broker.ts — covers every in-process primitive.

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  registerPeer,
  heartbeatPeer,
  unregisterPeer,
  setPeerSummary,
  getPeer,
  getPeerByName,
  listPeers,
  sendMessage,
  pollMessages,
  ackMessages,
  renamePeer,
  gcStalePeers,
  listOrphanedMessages,
  SessionExpiredError,
} from "../broker.ts";
import * as broker from "../broker.ts";
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";

let db: Database;
let TEST_DB: string;

beforeEach(() => {
  TEST_DB = `/tmp/agent-peers-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  db = initDb(TEST_DB);
});
afterEach(() => {
  db.close();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

// Helper: register and return a full auth handle.
function reg(opts: {
  name?: string;
  peer_type?: "claude" | "codex";
  host?: string | null;
  cwd?: string;
  git_root?: string | null;
  tty?: string | null;
  summary?: string;
  pid?: number;
}) {
  return registerPeer(db, {
    peer_type: opts.peer_type ?? "claude",
    pid: opts.pid ?? 1,
    cwd: opts.cwd ?? "/x",
    git_root: opts.git_root ?? null,
    tty: opts.tty ?? null,
    host: opts.host,
    summary: opts.summary ?? "",
    ...(opts.name ? { name: opts.name } : {}),
  });
}

type BrokerRuntime = Record<string, unknown>;
type IdentityRegisterResult = {
  id?: string;
  name?: string;
  session_token?: string;
  error?: string;
};

const brokerRuntime: BrokerRuntime = broker as BrokerRuntime;
const HEARTBEAT_INTERVAL_NS = 30_000_000_000n;
const LEASE_TTL_NS = 120_000_000_000n;
const LEASE_MISS_LIMIT = 3n;
const WALL_CLOCK_BASE = "2099-01-01T00:00:00.000Z";
const WALL_CLOCK_PLUS_2H = "2099-01-01T02:00:00.000Z";

function registerWithIdentity(req: Record<string, unknown>): IdentityRegisterResult {
  const fn = brokerRuntime.registerPeer as ((db: Database, req: Record<string, unknown>) => IdentityRegisterResult) | undefined;
  if (!fn) throw new Error("registerPeer export missing");
  return fn(db, req);
}

function requireBrokerFn<T>(name: string): T | undefined {
  return brokerRuntime[name] as T | undefined;
}

// Fixture-only verifier material. Assertions deliberately treat both fields as
// opaque so this seed does not freeze a production verifier format/algorithm.
function deriveCredentialVerifier(credential: string): { salt: string; verifier: string } {
  const salt = randomBytes(16).toString("hex");
  const verifier = createHash("sha256").update(salt).update("\0").update(credential).digest("hex");
  return { salt, verifier };
}

function setIdentityChallenge(peerId: string, identityKey: string, credential: string, lastSeenISO: string): void {
  ensurePeerColumns([
    "stable_identity_key TEXT",
    "authenticated_host_namespace TEXT",
    "identity_epoch INTEGER",
    "identity_state TEXT",
    "credential_salt TEXT",
    "credential_verifier TEXT",
    "last_auth_method TEXT",
  ]);
  const { salt, verifier } = deriveCredentialVerifier(credential);
  db.query(
    `UPDATE peers
       SET stable_identity_key = ?, authenticated_host_namespace = ?, identity_epoch = ?,
           identity_state = ?, credential_salt = ?, credential_verifier = ?,
           last_auth_method = ?, last_seen = ?
       WHERE id = ?`
  ).run(
    identityKey,
    "host:lpreet-pco",
    7,
    "current",
    salt,
    verifier,
    "fresh_enrollment",
    lastSeenISO,
    peerId,
  );
}

function ensurePeerColumns(columns: string[]): void {
  const existing = new Set(
    db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('peers')").all().map((r) => r.name),
  );
  for (const col of columns) {
    const name = col.split(/\s+/, 1)[0]!;
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE peers ADD COLUMN ${col}`);
      existing.add(name);
    }
  }
}

function ensureMessageColumns(columns: string[]): void {
  const existing = new Set(
    db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('messages')").all().map((r) => r.name),
  );
  for (const col of columns) {
    const name = col.split(/\s+/, 1)[0]!;
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE messages ADD COLUMN ${col}`);
      existing.add(name);
    }
  }
}

function setLeaseState(peerId: string, state: {
  lastSeenMonoNs: bigint;
  expiresMonoNs: bigint;
  persistedMisses: number;
  generation?: number;
  ownerTokenHash?: string;
  wallLastSeen?: string;
}): void {
  ensurePeerColumns([
    "lease_last_seen_mono_ns INTEGER",
    "lease_expires_mono_ns INTEGER",
    "lease_consecutive_misses INTEGER",
    "lease_generation INTEGER",
    "lease_owner_token_hash TEXT",
  ]);
  db.query(
    `UPDATE peers
       SET lease_last_seen_mono_ns = ?, lease_expires_mono_ns = ?,
           lease_consecutive_misses = ?, lease_generation = ?,
           lease_owner_token_hash = ?, last_seen = ?
     WHERE id = ?`
  ).run(
    state.lastSeenMonoNs.toString(),
    state.expiresMonoNs.toString(),
    state.persistedMisses,
    state.generation ?? 11,
    state.ownerTokenHash ?? "opaque-owner-token-hash",
    state.wallLastSeen ?? WALL_CLOCK_PLUS_2H,
    peerId,
  );
}

function identityRequest(opts: {
  name: string;
  pid: number;
  cwd: string;
  identityKey: string;
  credential?: string;
  tty?: string | null;
}): Record<string, unknown> {
  return {
    peer_type: "codex",
    name: opts.name,
    pid: opts.pid,
    cwd: opts.cwd,
    git_root: null,
    tty: opts.tty ?? null,
    summary: "",
    stable_identity_key: opts.identityKey,
    authenticated_host_namespace: "host:lpreet-pco",
    ...(opts.credential === undefined ? {} : { credential_secret: opts.credential }),
  };
}

function readLeaseState(peerId: string): {
  lastSeenMonoNs: bigint;
  expiresMonoNs: bigint;
  misses: number;
  generation: number;
  ownerTokenHash: string | null;
} {
  const row = db.query<{
    lease_last_seen_mono_ns: string;
    lease_expires_mono_ns: string;
    lease_consecutive_misses: number;
    lease_generation: number;
    lease_owner_token_hash: string | null;
  }, [string]>(
    `SELECT CAST(lease_last_seen_mono_ns AS TEXT) AS lease_last_seen_mono_ns,
            CAST(lease_expires_mono_ns AS TEXT) AS lease_expires_mono_ns,
            lease_consecutive_misses, lease_generation, lease_owner_token_hash
       FROM peers WHERE id = ?`
  ).get(peerId);
  expect(row).not.toBeNull();
  return {
    lastSeenMonoNs: BigInt(row!.lease_last_seen_mono_ns),
    expiresMonoNs: BigInt(row!.lease_expires_mono_ns),
    misses: row!.lease_consecutive_misses,
    generation: row!.lease_generation,
    ownerTokenHash: row!.lease_owner_token_hash,
  };
}

// ---------- schema ----------

test("initDb creates tables and indices with WAL", () => {
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map((r) => r.name);
  expect(tables).toContain("peers");
  expect(tables).toContain("messages");

  const pragma = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  expect(pragma?.journal_mode.toLowerCase()).toBe("wal");
});

// ---------- peer CRUD ----------

test("registerPeer creates peer with UUID + name + session_token", () => {
  const { id, name, session_token } = reg({});
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(session_token).toMatch(/^[a-f0-9-]{36}$/);
  expect(name.length).toBeGreaterThan(0);
  const peer = getPeer(db, id);
  expect(peer?.name).toBe(name);
});

test("registerPeer honors explicit name if unique", () => {
  const { name } = reg({ name: "frontend-tab", peer_type: "codex" });
  expect(name).toBe("frontend-tab");
});

test("registerPeer appends -2 on name collision with live peer", () => {
  const a = reg({ name: "dup" });
  const b = reg({ name: "dup" });
  expect(a.name).toBe("dup");
  expect(b.name).toBe("dup-2");
});

test("registerPeer reclaims stale peer with same name, preserving UUID and issuing NEW session_token", () => {
  const first = reg({ name: "persistent" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", first.id);
  const second = reg({ name: "persistent", pid: 222, cwd: "/new" });
  expect(second.id).toBe(first.id);
  expect(second.name).toBe("persistent");
  expect(second.session_token).not.toBe(first.session_token); // rotated
  const row = db.query<{ pid: number; cwd: string }, [string]>(
    "SELECT pid, cwd FROM peers WHERE id = ?"
  ).get(second.id)!;
  expect(row.pid).toBe(222);
  expect(row.cwd).toBe("/new");
});

test("registerPeer on reclaim clears stale leases so new session sees backlog immediately", () => {
  // Sender stays alive; receiver "dies" mid-delivery and is reclaimed.
  const sender = reg({ name: "sender" });
  const dying = reg({ name: "doomed" });

  // Sender sends two messages; receiver leases one (but crashes before ack).
  const s1 = sendMessage(db, {
    from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: "doomed", text: "hi",
  });
  expect(s1.ok).toBe(true);
  const leased = pollMessages(db, dying.id, dying.session_token);
  expect(leased.length).toBe(1);
  expect(leased[0]!.text).toBe("hi");
  // A second message arrives AFTER the lease — still unleased.
  const s2 = sendMessage(db, {
    from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: "doomed", text: "second",
  });
  expect(s2.ok).toBe(true);

  // Receiver dies (go stale) without acking the lease.
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", dying.id);

  // Another session reclaims the name. Reclaim should clear the stuck lease
  // so the new session's first poll returns BOTH messages immediately.
  const reclaimed = reg({ name: "doomed", pid: 777 });
  expect(reclaimed.id).toBe(dying.id);

  const backlog = pollMessages(db, reclaimed.id, reclaimed.session_token);
  expect(backlog.length).toBe(2);
  expect(backlog.map((m) => m.text).sort()).toEqual(["hi", "second"]);
});

test("registerPeer does NOT reclaim a LIVE peer, falls through to suffix", () => {
  const live = reg({ name: "active" });
  const second = reg({ name: "active" });
  expect(second.id).not.toBe(live.id);
  expect(second.name).toBe("active-2");
});

test("registerPeer replaces live peer in same tty cwd and type, preserving id and name", () => {
  const first = reg({ peer_type: "codex", cwd: "/repo", tty: "pts/9", pid: 101 });
  const second = reg({ peer_type: "codex", cwd: "/repo", tty: "pts/9", pid: 202 });

  expect(second.id).toBe(first.id);
  expect(second.name).toBe(first.name);
  expect(second.session_token).not.toBe(first.session_token);
  expect(listPeers(db, { scope: "machine", cwd: "/any", git_root: null, peer_type: "codex" })).toHaveLength(1);

  const row = db.query<{ pid: number; cwd: string; tty: string; peer_type: string }, [string]>(
    "SELECT pid, cwd, tty, peer_type FROM peers WHERE id = ?"
  ).get(second.id)!;
  expect(row).toEqual({ pid: 202, cwd: "/repo", tty: "pts/9", peer_type: "codex" });

  expect(() => heartbeatPeer(db, first.id, first.session_token)).toThrow(SessionExpiredError);
  expect(getPeer(db, second.id)?.pid).toBe(202);
});

test("registerPeer same tty cwd and type clears stale leases for replaced row", () => {
  const sender = reg({ name: "sender" });
  const first = reg({ name: "receiver", peer_type: "codex", cwd: "/repo", tty: "pts/9" });

  sendMessage(db, {
    from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: "receiver", text: "leased",
  });
  const leased = pollMessages(db, first.id, first.session_token);
  expect(leased).toHaveLength(1);

  const second = reg({ name: "new-name", peer_type: "codex", cwd: "/repo", tty: "pts/9", pid: 303 });
  expect(second.id).toBe(first.id);
  expect(second.name).toBe("receiver");

  const backlog = pollMessages(db, second.id, second.session_token);
  expect(backlog.map((m) => m.text)).toEqual(["leased"]);
});

test("registerPeer same tty cwd and type replaces named live peer instead of suffixing", () => {
  const first = reg({ name: "stable", peer_type: "codex", cwd: "/repo", tty: "pts/9", pid: 101 });
  const second = reg({ name: "stable", peer_type: "codex", cwd: "/repo", tty: "pts/9", pid: 202 });

  expect(second.id).toBe(first.id);
  expect(second.name).toBe("stable");
  expect(second.session_token).not.toBe(first.session_token);
  expect(getPeerByName(db, "stable-2")).toBeNull();
});

test("registerPeer keeps distinct peers for different tty cwd or empty tty", () => {
  const base = reg({ name: "base", peer_type: "codex", cwd: "/repo", tty: "pts/9" });
  const otherTty = reg({ name: "base", peer_type: "codex", cwd: "/repo", tty: "pts/10" });
  const otherCwd = reg({ name: "base", peer_type: "codex", cwd: "/other", tty: "pts/9" });
  const emptyA = reg({ name: "empty", peer_type: "codex", cwd: "/repo", tty: "" });
  const emptyB = reg({ name: "empty", peer_type: "codex", cwd: "/repo", tty: "" });
  const nullA = reg({ name: "nulltty", peer_type: "codex", cwd: "/repo", tty: null });
  const nullB = reg({ name: "nulltty", peer_type: "codex", cwd: "/repo", tty: null });
  const otherType = reg({ name: "base", peer_type: "claude", cwd: "/repo", tty: "pts/9" });

  expect(otherTty.id).not.toBe(base.id);
  expect(otherTty.name).toBe("base-2");
  expect(otherCwd.id).not.toBe(base.id);
  expect(otherCwd.name).toBe("base-3");
  expect(emptyA.id).not.toBe(emptyB.id);
  expect(emptyB.name).toBe("empty-2");
  expect(nullA.id).not.toBe(nullB.id);
  expect(nullB.name).toBe("nulltty-2");
  expect(otherType.id).not.toBe(base.id);
  expect(otherType.name).toBe("base-4");
});

test("registerPeer keeps same cwd tty type distinct across different hosts", () => {
  const pco = reg({ name: "pco-peer", peer_type: "codex", host: "lpreet-pco", cwd: "/repo", tty: "pts/9" });
  const pc = reg({ name: "pc-peer", peer_type: "codex", host: "lpreet-pc", cwd: "/repo", tty: "pts/9" });

  expect(pc.id).not.toBe(pco.id);
  const peers = listPeers(db, { scope: "machine", cwd: "/any", git_root: null, peer_type: "codex" });
  expect(peers).toHaveLength(2);
  expect(peers.map((p) => p.host).sort()).toEqual(["lpreet-pc", "lpreet-pco"]);
});

test("registerPeer replaces same host cwd tty type and normalizes host", () => {
  const first = reg({ name: "stable-host", peer_type: "codex", host: "Lpreet-PCO", cwd: "/repo", tty: "pts/9", pid: 101 });
  const second = reg({ name: "stable-host", peer_type: "codex", host: " lpreet-pco ", cwd: "/repo", tty: "pts/9", pid: 202 });

  expect(second.id).toBe(first.id);
  expect(second.name).toBe("stable-host");
  expect(second.session_token).not.toBe(first.session_token);
  const row = getPeer(db, second.id)!;
  expect(row.host).toBe("lpreet-pco");
  expect(row.pid).toBe(202);
});

test("registerPeer legacy null host dedupes as today", () => {
  const first = reg({ name: "legacy-hostless", peer_type: "codex", host: null, cwd: "/repo", tty: "pts/9", pid: 101 });
  const second = reg({ name: "legacy-hostless", peer_type: "codex", host: null, cwd: "/repo", tty: "pts/9", pid: 202 });

  expect(second.id).toBe(first.id);
  expect(getPeer(db, second.id)?.host).toBeNull();
});

test("registerPeer null host and populated host are distinct during transition", () => {
  const legacy = reg({ name: "transition", peer_type: "codex", host: null, cwd: "/repo", tty: "pts/9", pid: 101 });
  const qualified = reg({ name: "transition", peer_type: "codex", host: "lpreet-pco", cwd: "/repo", tty: "pts/9", pid: 202 });

  expect(qualified.id).not.toBe(legacy.id);
  expect(qualified.name).toBe("transition-2");
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", legacy.id);
  expect(gcStalePeers(db)).toBe(1);
  expect(listPeers(db, { scope: "machine", cwd: "/any", git_root: null, peer_type: "codex" })).toHaveLength(1);
});

test("stale peers stay absent from machine/directory/repo and from unrelated re-registration", () => {
  const staleMachine = reg({
    name: "stale-public-machine",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/stale-cwd-machine",
    git_root: "/stale-repo",
    tty: "pts/9",
    pid: 222,
  });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", staleMachine.id);
  const controlMachine = reg({
    name: "control-public-machine",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/stale-cwd-machine",
    git_root: "/stale-repo",
    tty: "pts/10",
    pid: 223,
  });

  const machinePeers = listPeers(db, { scope: "machine", cwd: "/any", git_root: null, peer_type: "codex" });
  expect(machinePeers.some((peer) => peer.id === staleMachine.id)).toBe(false);
  expect(machinePeers.some((peer) => peer.id === controlMachine.id)).toBe(true);

  const staleDirectory = reg({
    name: "stale-public-directory",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/stale-cwd-directory",
    git_root: "/stale-directory-repo",
    tty: "pts/1",
    pid: 224,
  });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", staleDirectory.id);
  const controlDirectory = reg({
    name: "control-public-directory",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/stale-cwd-directory",
    git_root: "/stale-directory-repo",
    tty: "pts/2",
    pid: 225,
  });

  const directoryPeers = listPeers(db, {
    scope: "directory",
    cwd: "/stale-cwd-directory",
    git_root: null,
    peer_type: "codex",
  });
  expect(directoryPeers.some((peer) => peer.id === staleDirectory.id)).toBe(false);
  expect(directoryPeers.some((peer) => peer.id === controlDirectory.id)).toBe(true);

  const staleRepo = reg({
    name: "stale-public-repo",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/stale-cwd-repo",
    git_root: "/stale-repo-anchor",
    tty: "pts/3",
    pid: 226,
  });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", staleRepo.id);
  const controlRepo = reg({
    name: "control-public-repo",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/stale-cwd-repo",
    git_root: "/stale-repo-anchor",
    tty: "pts/4",
    pid: 227,
  });

  const repoPeers = listPeers(db, {
    scope: "repo",
    cwd: "/stale-cwd-repo",
    git_root: "/stale-repo-anchor",
    peer_type: "codex",
  });
  expect(repoPeers.some((peer) => peer.id === staleRepo.id)).toBe(false);
  expect(repoPeers.some((peer) => peer.id === controlRepo.id)).toBe(true);
});

test("current unauthenticated stale-name reclaim preserves identity + mailbox while denying old session", () => {
  const sender = reg({
    name: "mailbox-sender",
    peer_type: "claude",
    host: "lpreet-pco",
    cwd: "/legacy-queue-stale",
    tty: "pts/2",
    pid: 333,
    git_root: "/legacy-queue",
  });
  const stale = reg({
    name: "stale-reclaimer",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/legacy-queue-stale",
    tty: "pts/3",
    pid: 444,
    git_root: "/legacy-queue",
  });

  const leased = sendMessage(db, {
    from_id: sender.id, session_token: sender.session_token, to_id_or_name: stale.name, text: "inflight",
  });
  expect(leased.ok).toBe(true);
  expect(pollMessages(db, stale.id, stale.session_token).length).toBe(1);

  const backlog = sendMessage(db, {
    from_id: sender.id, session_token: sender.session_token, to_id_or_name: stale.name, text: "backlog",
  });
  expect(backlog.ok).toBe(true);

  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", stale.id);

  const reclaimed = reg({
    name: stale.name,
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/legacy-queue-new",
    tty: "pts/4",
    pid: 555,
    git_root: "/legacy-queue",
  });
  expect(reclaimed.id).toBe(stale.id);
  expect(reclaimed.name).toBe(stale.name);
  expect(reclaimed.session_token).not.toBe(stale.session_token);

  const reclaimedBacklog = pollMessages(db, reclaimed.id, reclaimed.session_token);
  expect(reclaimedBacklog.map((message) => message.text).sort()).toEqual(["backlog", "inflight"]);
  expect(() => heartbeatPeer(db, reclaimed.id, reclaimed.session_token)).not.toThrow();
  expect(() => setPeerSummary(db, reclaimed.id, reclaimed.session_token, "new-holder-summary")).not.toThrow();

  const fresh = sendMessage(db, {
    from_id: sender.id,
    session_token: sender.session_token,
    to_id_or_name: reclaimed.name,
    text: "fresh-inbound",
  });
  expect(fresh.ok).toBe(true);
  const freshInbox = pollMessages(db, reclaimed.id, reclaimed.session_token);
  expect(freshInbox.map((message) => message.text).sort()).toEqual(["backlog", "fresh-inbound", "inflight"]);
  const ack = ackMessages(db, {
    id: reclaimed.id,
    session_token: reclaimed.session_token,
    lease_tokens: freshInbox.map((message) => message.lease_token),
  });
  expect(ack.acked).toBe(3);

  expect(() => heartbeatPeer(db, stale.id, stale.session_token)).toThrow(SessionExpiredError);
  expect(() => setPeerSummary(db, stale.id, stale.session_token, "old-holder")).toThrow(SessionExpiredError);
  const staleSendAttempt = sendMessage(db, {
    from_id: stale.id, session_token: stale.session_token, to_id_or_name: sender.id, text: "should be denied",
  });
  expect(staleSendAttempt.ok).toBe(false);
  expect(staleSendAttempt.error).toMatch(/^unauthorized sender:/);
  expect(staleSendAttempt.error).not.toContain(stale.session_token);
  expect(staleSendAttempt.error).not.toContain("should be denied");
});

test("registerPeer is atomic under simulated interleaving", () => {
  db.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, session_token, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "external-id", "race", "claude", 99, "/ext", null, null, "",
    "external-session", new Date().toISOString(), new Date().toISOString(),
  );
  const res = reg({ name: "race" });
  expect(res.name).toBe("race-2");
});

test("registerPeer rejects missing and wrong stale-reclaim credentials without owner mutation", () => {
  const stale = reg({ name: "stale-unauthed", peer_type: "codex", cwd: "/cred", tty: null });
  const original = db.query<{ session_token: string; pid: number }, [string]>(
    "SELECT session_token, pid FROM peers WHERE id = ?"
  ).get(stale.id);
  expect(original).not.toBeNull();

  const identity = "identity-key-stale";
  const credential = "stale-secret";
  setIdentityChallenge(stale.id, identity, credential, WALL_CLOCK_PLUS_2H);
  const nowMonoNs = process.hrtime.bigint();
  setLeaseState(stale.id, {
    lastSeenMonoNs: nowMonoNs - (HEARTBEAT_INTERVAL_NS * LEASE_MISS_LIMIT),
    expiresMonoNs: nowMonoNs - 1n,
    persistedMisses: 0,
  });

  const stored = db.query<{ credential_salt: string; credential_verifier: string; stable_identity_key: string }, [string]>(
    "SELECT stable_identity_key, credential_salt, credential_verifier FROM peers WHERE id = ?"
  ).get(stale.id);
  expect(stored?.stable_identity_key).toBe(identity);
  expect(stored?.credential_salt).not.toContain(identity);
  expect(stored?.credential_salt).not.toContain(credential);
  expect(stored?.credential_verifier).not.toBe(credential);
  expect(stored?.credential_verifier).not.toContain(credential);
  const peerColumns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('peers')").all();
  expect(peerColumns.map(({ name }) => name)).not.toContain("reclaim_credential");

  const missing = registerWithIdentity(identityRequest({
    name: "stale-unauthed",
    pid: 902,
    cwd: "/cred",
    identityKey: identity,
  }));
  expect(missing.error).toBe("IDENTITY_CREDENTIAL_REQUIRED");

  const wrong = registerWithIdentity(identityRequest({
    name: "stale-unauthed",
    pid: 903,
    cwd: "/cred",
    identityKey: identity,
    credential: "wrong-secret",
  }));
  expect(wrong.error).toBe("IDENTITY_CREDENTIAL_INVALID");

  const after = db.query<{ session_token: string; pid: number }, [string]>(
    "SELECT session_token, pid FROM peers WHERE id = ?"
  ).get(stale.id);
  expect(after?.session_token).toBe(original!.session_token);
  expect(after?.pid).toBe(original!.pid);
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM peers WHERE name = 'stale-unauthed'").get()?.c).toBe(1);
});

test("registerPeer rejects reclaim against a live owner with a valid credential", () => {
  const live = reg({ name: "live-identity", peer_type: "codex", cwd: "/cred", tty: null });
  const identity = "identity-live-key";
  const credential = "live-secret";
  setIdentityChallenge(live.id, identity, credential, WALL_CLOCK_PLUS_2H);
  const nowMonoNs = process.hrtime.bigint();
  setLeaseState(live.id, {
    lastSeenMonoNs: nowMonoNs,
    expiresMonoNs: nowMonoNs + LEASE_TTL_NS,
    persistedMisses: 0,
  });

  const result = registerWithIdentity(identityRequest({
    name: "live-identity",
    pid: 903,
    cwd: "/cred",
    identityKey: identity,
    credential,
  }));
  expect(result.error).toBe("IDENTITY_LIVE_OWNER");
  const rowCount = db.query<{ c: number }, []>(
    "SELECT COUNT(*) AS c FROM peers WHERE name LIKE 'live-identity%'"
  ).get()!;
  expect(rowCount.c).toBe(1);
});

test("two concurrent stale reclaim attempts produce one winner and one typed loser", () => {
  const stale = reg({ name: "stale-race", peer_type: "codex", cwd: "/cred-race", tty: null });
  const identity = "identity-race";
  const credential = "race-secret";
  setIdentityChallenge(stale.id, identity, credential, WALL_CLOCK_PLUS_2H);
  const nowMonoNs = process.hrtime.bigint();
  setLeaseState(stale.id, {
    lastSeenMonoNs: nowMonoNs - (HEARTBEAT_INTERVAL_NS * LEASE_MISS_LIMIT),
    expiresMonoNs: nowMonoNs - 1n,
    persistedMisses: 0,
  });
  const before = db.query<{ session_token: string; identity_epoch: number }, [string]>(
    "SELECT session_token, identity_epoch FROM peers WHERE id = ?"
  ).get(stale.id)!;

  const winner = registerWithIdentity(identityRequest({
    name: "stale-race",
    pid: 904,
    cwd: "/cred-race",
    identityKey: identity,
    credential,
  }));
  const loser = registerWithIdentity(identityRequest({
    name: "stale-race",
    pid: 905,
    cwd: "/cred-race",
    identityKey: identity,
    credential,
  }));

  expect(loser.error).toBe("IDENTITY_RECLAIM_RACE_LOST");
  expect(winner.error).toBeUndefined();
  expect(winner.id).toBe(stale.id);
  const after = db.query<{ session_token: string; identity_epoch: number }, [string]>(
    "SELECT session_token, identity_epoch FROM peers WHERE id = ?"
  ).get(stale.id)!;
  expect(after.session_token).toBe(winner.session_token!);
  expect(after.session_token).not.toBe(before.session_token);
  expect(after.identity_epoch).toBe(before.identity_epoch + 1);
});

test("same tty and cwd cannot replace a live identity owner", () => {
  const live = reg({ name: "live-tty", peer_type: "codex", cwd: "/tty", tty: "pts/7" });
  const identity = "identity-tty";
  const credential = "tty-secret";
  setIdentityChallenge(live.id, identity, credential, WALL_CLOCK_PLUS_2H);
  const nowMonoNs = process.hrtime.bigint();
  setLeaseState(live.id, {
    lastSeenMonoNs: nowMonoNs,
    expiresMonoNs: nowMonoNs + LEASE_TTL_NS,
    persistedMisses: 0,
  });
  const before = db.query<{ session_token: string; pid: number }, [string]>(
    "SELECT session_token, pid FROM peers WHERE id = ?"
  ).get(live.id)!;

  const result = registerWithIdentity(identityRequest({
    name: "live-tty",
    pid: 906,
    cwd: "/tty",
    tty: "pts/7",
    identityKey: identity,
    credential,
  }));
  expect(result.error).toBe("IDENTITY_LIVE_OWNER");

  const row = db.query<{ session_token: string; pid: number }, [string]>(
    "SELECT session_token, pid FROM peers WHERE id = ?"
  ).get(live.id);
  expect(row).toEqual(before);
});

test("release-seat clears only the authenticated owner lease and increments its generation", () => {
  const releaseSeat = requireBrokerFn<(db: Database, req: {
    id: string;
    session_token: string;
    credential_secret: string;
    stable_identity_key: string;
    authenticated_host_namespace: string;
    lease_owner_token: string;
  }) => { ok: boolean; lease_generation?: number }>("releaseSeat");
  expect(typeof releaseSeat).toBe("function");
  if (!releaseSeat) return;

  const owner = reg({ name: "release-seat-owner", peer_type: "codex", cwd: "/release", tty: "pts/8" });
  const identity = "release-seat-identity";
  const credential = "release-seat-secret";
  setIdentityChallenge(owner.id, identity, credential, WALL_CLOCK_PLUS_2H);
  const nowMonoNs = process.hrtime.bigint();
  setLeaseState(owner.id, {
    lastSeenMonoNs: nowMonoNs,
    expiresMonoNs: nowMonoNs + LEASE_TTL_NS,
    persistedMisses: 2,
    generation: 41,
    ownerTokenHash: createHash("sha256").update("owner-token").digest("hex"),
  });

  const unaffected = reg({ name: "other-peer", peer_type: "codex", cwd: "/release", tty: "pts/9" });

  const result = releaseSeat(db, {
    id: owner.id,
    session_token: owner.session_token,
    credential_secret: credential,
    stable_identity_key: identity,
    authenticated_host_namespace: "host:lpreet-pco",
    lease_owner_token: "owner-token",
  });
  expect(result.ok).toBe(true);

  const ownerRow = db.query<{ lease_generation: number; lease_owner_token_hash: string | null; lease_consecutive_misses: number } , [string]>("SELECT lease_generation, lease_owner_token_hash, lease_consecutive_misses FROM peers WHERE id = ?").get(owner.id);
  const otherRow = db.query<{ lease_generation: number | null; lease_owner_token_hash: string | null } , [string]>("SELECT lease_generation, lease_owner_token_hash FROM peers WHERE id = ?").get(unaffected.id);
  expect(ownerRow?.lease_generation).toBe(42);
  expect(ownerRow?.lease_owner_token_hash).toBeNull();
  expect(ownerRow?.lease_consecutive_misses).toBe(0);
  expect(otherRow?.lease_generation ?? null).toBeNull();
  expect(otherRow?.lease_owner_token_hash ?? null).toBeNull();
});

test("background heartbeat receipts keep ownership live during a slow no-model-turn window", async () => {
  const owner = reg({ name: "slow-turn-owner", peer_type: "codex", cwd: "/lease", tty: null });
  const identity = "identity-slow-turn";
  const credential = "slow-turn-secret";
  setIdentityChallenge(owner.id, identity, credential, WALL_CLOCK_BASE);
  const capturedMonoNs = process.hrtime.bigint();
  setLeaseState(owner.id, {
    lastSeenMonoNs: capturedMonoNs - (HEARTBEAT_INTERVAL_NS * 2n),
    expiresMonoNs: capturedMonoNs + HEARTBEAT_INTERVAL_NS,
    persistedMisses: 2,
    generation: 23,
    ownerTokenHash: "slow-turn-owner-token-hash",
    wallLastSeen: WALL_CLOCK_BASE,
  });

  // Only the dedicated heartbeat boundary runs across this simulated slow turn:
  // no poll, summary, rename, or other model-mediated broker call refreshes it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  heartbeatPeer(db, owner.id, owner.session_token);
  const first = readLeaseState(owner.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  heartbeatPeer(db, owner.id, owner.session_token);
  const second = readLeaseState(owner.id);

  expect(first.lastSeenMonoNs).toBeGreaterThan(capturedMonoNs);
  expect(first.expiresMonoNs - first.lastSeenMonoNs).toBe(LEASE_TTL_NS);
  expect(first.misses).toBe(0);
  expect(second.lastSeenMonoNs).toBeGreaterThanOrEqual(first.lastSeenMonoNs);
  expect(second.expiresMonoNs).toBeGreaterThanOrEqual(first.expiresMonoNs);
  expect(second.generation).toBe(23);
  expect(second.ownerTokenHash).toBe("slow-turn-owner-token-hash");

  const reclaim = registerWithIdentity(identityRequest({
    name: owner.name,
    pid: 907,
    cwd: "/lease",
    identityKey: identity,
    credential,
  }));
  expect(reclaim.error).toBe("IDENTITY_LIVE_OWNER");
});

test("lease truth table: miss limit alone keeps the owner live without a sweep", () => {
  const owner = reg({ name: "lease-misses-only", peer_type: "codex", cwd: "/lease", tty: null });
  const identity = "identity-misses-only";
  const credential = "misses-only-secret";
  setIdentityChallenge(owner.id, identity, credential, WALL_CLOCK_PLUS_2H);
  const nowMonoNs = process.hrtime.bigint();
  setLeaseState(owner.id, {
    lastSeenMonoNs: nowMonoNs - (HEARTBEAT_INTERVAL_NS * LEASE_MISS_LIMIT),
    expiresMonoNs: nowMonoNs + HEARTBEAT_INTERVAL_NS,
    persistedMisses: 0,
  });

  // No gc/miss-sweep call: reclaim must compute misses inline, then apply AND.
  const result = registerWithIdentity(identityRequest({
    name: owner.name,
    pid: 908,
    cwd: "/lease",
    identityKey: identity,
    credential,
  }));
  expect(result.error).toBe("IDENTITY_LIVE_OWNER");
  expect(db.query<{ session_token: string }, [string]>("SELECT session_token FROM peers WHERE id = ?").get(owner.id)?.session_token)
    .toBe(owner.session_token);
});

test("lease truth table: expiry alone keeps the owner live despite two-hour advisory timestamp skew", () => {
  const owner = reg({ name: "lease-expiry-only", peer_type: "codex", cwd: "/lease", tty: null });
  const sender = reg({ name: "lease-wall-clock-sender", peer_type: "claude", cwd: "/lease" });
  const identity = "identity-expiry-only";
  const credential = "expiry-only-secret";
  setIdentityChallenge(owner.id, identity, credential, WALL_CLOCK_PLUS_2H);
  const nowMonoNs = process.hrtime.bigint();
  setLeaseState(owner.id, {
    lastSeenMonoNs: nowMonoNs - (HEARTBEAT_INTERVAL_NS * 2n),
    expiresMonoNs: nowMonoNs - 1n,
    persistedMisses: Number(LEASE_MISS_LIMIT),
  });
  expect(sendMessage(db, {
    from_id: sender.id,
    session_token: sender.session_token,
    to_id_or_name: owner.id,
    text: "advisory-sent-at-does-not-authorize",
  }).ok).toBe(true);
  db.query("UPDATE messages SET sent_at = ? WHERE to_id = ?")
    .run(WALL_CLOCK_BASE, owner.id);

  const result = registerWithIdentity(identityRequest({
    name: owner.name,
    pid: 909,
    cwd: "/lease",
    identityKey: identity,
    credential,
  }));
  expect(result.error).toBe("IDENTITY_LIVE_OWNER");
  expect(db.query<{ session_token: string }, [string]>("SELECT session_token FROM peers WHERE id = ?").get(owner.id)?.session_token)
    .toBe(owner.session_token);
});

test("lease truth table: reclaim succeeds inline only after miss limit and expiry both cross", () => {
  const owner = reg({ name: "lease-both-stale", peer_type: "codex", cwd: "/lease", tty: null });
  const sender = reg({ name: "lease-both-stale-sender", peer_type: "claude", cwd: "/lease" });
  const identity = "identity-both-stale";
  const credential = "both-stale-secret";
  setIdentityChallenge(owner.id, identity, credential, WALL_CLOCK_PLUS_2H);
  const nowMonoNs = process.hrtime.bigint();
  setLeaseState(owner.id, {
    lastSeenMonoNs: nowMonoNs - (HEARTBEAT_INTERVAL_NS * LEASE_MISS_LIMIT),
    expiresMonoNs: nowMonoNs - 1n,
    persistedMisses: 0,
  });
  expect(sendMessage(db, {
    from_id: sender.id,
    session_token: sender.session_token,
    to_id_or_name: owner.id,
    text: "both-stale-advisory-sent-at",
  }).ok).toBe(true);
  db.query("UPDATE messages SET sent_at = ? WHERE to_id = ?")
    .run(WALL_CLOCK_BASE, owner.id);

  // No sweep updates persistedMisses. The +2h last_seen/sent_at disagreement
  // is advisory; the monotonic receipt/deadline pair alone makes this stale.
  const result = registerWithIdentity(identityRequest({
    name: owner.name,
    pid: 910,
    cwd: "/lease",
    identityKey: identity,
    credential,
  }));
  expect(result.error).toBeUndefined();
  expect(result.id).toBe(owner.id);
  expect(result.session_token).not.toBe(owner.session_token);
});

test("duplicate heartbeat receipts are deterministic and do not rotate lease ownership", () => {
  const owner = reg({ name: "duplicate-heartbeat", peer_type: "codex", cwd: "/heartbeat", tty: null });
  setIdentityChallenge(owner.id, "identity-duplicate-heartbeat", "duplicate-heartbeat-secret", WALL_CLOCK_PLUS_2H);
  const nowMonoNs = process.hrtime.bigint();
  setLeaseState(owner.id, {
    lastSeenMonoNs: nowMonoNs - HEARTBEAT_INTERVAL_NS,
    expiresMonoNs: nowMonoNs + LEASE_TTL_NS,
    persistedMisses: 1,
    generation: 29,
    ownerTokenHash: "duplicate-owner-token-hash",
  });

  expect(() => heartbeatPeer(db, owner.id, owner.session_token)).not.toThrow();
  const first = readLeaseState(owner.id);
  expect(() => heartbeatPeer(db, owner.id, owner.session_token)).not.toThrow();
  const duplicate = readLeaseState(owner.id);

  expect(first.misses).toBe(0);
  expect(duplicate.misses).toBe(0);
  expect(duplicate.generation).toBe(first.generation);
  expect(duplicate.generation).toBe(29);
  expect(duplicate.ownerTokenHash).toBe(first.ownerTokenHash);
  expect(duplicate.ownerTokenHash).toBe("duplicate-owner-token-hash");
  expect(duplicate.lastSeenMonoNs).toBeGreaterThanOrEqual(first.lastSeenMonoNs);
  expect(duplicate.expiresMonoNs).toBeGreaterThanOrEqual(first.expiresMonoNs);
  expect(pollMessages(db, owner.id, owner.session_token)).toEqual([]);
});

test("broker restart advances persisted broker_epoch and rejects stale lease tokens", () => {
  ensurePeerColumns([
    "broker_epoch INTEGER",
    "lease_owner_token_hash TEXT",
    "stable_identity_key TEXT",
    "credential_salt TEXT",
    "credential_verifier TEXT",
  ]);
  const owner = reg({ name: "epoch-peer", peer_type: "codex", cwd: "/epoch", tty: "pts/12" });
  const identity = "identity-epoch";
  const credential = "epoch-secret";
  setIdentityChallenge(owner.id, identity, credential, WALL_CLOCK_PLUS_2H);
  db.query("UPDATE peers SET broker_epoch = 1, lease_owner_token_hash = ? WHERE id = ?").run("stale-owner-token", owner.id);

  const initialEpoch = db.query<{ broker_epoch: number }, [string]>(
    "SELECT broker_epoch FROM peers WHERE id = ?"
  ).get(owner.id)?.broker_epoch;
  expect(initialEpoch).toBe(1);

  db.close();
  db = initDb(TEST_DB);
  const epochNow = db.query<{ broker_epoch: number }, [string]>(
    "SELECT broker_epoch FROM peers WHERE id = ?"
  ).get(owner.id)?.broker_epoch;
  expect(epochNow).toBeGreaterThan(1);

  const staleOwnerResult = registerWithIdentity(identityRequest({
    name: "epoch-peer",
    pid: 1210,
    cwd: "/epoch",
    tty: "pts/12",
    identityKey: identity,
    credential,
  }));
  expect(staleOwnerResult.error).toBe("IDENTITY_LEASE_EPOCH_STALE");
});

test("send-time sender snapshots stay immutable and poll reports transitioned after authenticated reclaim", () => {
  ensureMessageColumns([
    "provenance_version TEXT",
    "sender_epoch_at_send INTEGER",
    "sender_stable_identity_key_at_send TEXT",
    "sender_authenticated_host_namespace_at_send TEXT",
    "sender_name_at_send TEXT",
    "sender_peer_type_at_send TEXT",
    "sender_cwd_at_send TEXT",
    "sender_summary_at_send TEXT",
  ]);
  const sender = reg({
    name: "snapshot-sender",
    peer_type: "claude",
    cwd: "/snap",
    tty: null,
    summary: "sender-at-send",
  });
  const senderIdentity = "identity-snapshot-sender";
  const senderCredential = "snapshot-sender-secret";
  setIdentityChallenge(sender.id, senderIdentity, senderCredential, WALL_CLOCK_PLUS_2H);
  const receiver = reg({
    name: "snapshot-receiver",
    peer_type: "codex",
    cwd: "/snap",
    tty: "pts/3",
    summary: "receiver-first",
  });

  expect(sendMessage(db, {
    from_id: sender.id,
    session_token: sender.session_token,
    to_id_or_name: receiver.name,
    text: "immutable-snapshot",
  }).ok).toBe(true);

  const stored = db.query<{
    provenance_version: string | null;
    sender_epoch_at_send: number | null;
    sender_stable_identity_key_at_send: string | null;
    sender_authenticated_host_namespace_at_send: string | null;
    sender_name_at_send: string | null;
    sender_peer_type_at_send: string | null;
    sender_cwd_at_send: string | null;
    sender_summary_at_send: string | null;
  }, [string]>(
    `SELECT provenance_version, sender_epoch_at_send,
            sender_stable_identity_key_at_send, sender_authenticated_host_namespace_at_send,
            sender_name_at_send, sender_peer_type_at_send,
            sender_cwd_at_send, sender_summary_at_send
       FROM messages WHERE text = ?`
  ).get("immutable-snapshot")!;
  expect(stored.provenance_version).not.toBeNull();
  expect(stored.sender_epoch_at_send).toBe(7);
  expect(stored.sender_stable_identity_key_at_send).toBe(senderIdentity);
  expect(stored.sender_authenticated_host_namespace_at_send).toBe("host:lpreet-pco");
  expect(stored.sender_name_at_send).toBe("snapshot-sender");
  expect(stored.sender_peer_type_at_send).toBe("claude");
  expect(stored.sender_cwd_at_send).toBe("/snap");
  expect(stored.sender_summary_at_send).toBe("sender-at-send");

  const nowMonoNs = process.hrtime.bigint();
  setLeaseState(sender.id, {
    lastSeenMonoNs: nowMonoNs - (HEARTBEAT_INTERVAL_NS * LEASE_MISS_LIMIT),
    expiresMonoNs: nowMonoNs - 1n,
    persistedMisses: 0,
  });
  const reclaimedSender = registerWithIdentity({
    ...identityRequest({
      name: sender.name,
      pid: 1203,
      cwd: "/snapshot-modified",
      identityKey: senderIdentity,
      credential: senderCredential,
    }),
    peer_type: "claude",
    summary: "sender-after-send",
  });
  expect(reclaimedSender.error).toBeUndefined();
  expect(reclaimedSender.id).toBe(sender.id);
  expect(reclaimedSender.session_token).not.toBe(sender.session_token);
  expect(renamePeer(db, {
    id: sender.id,
    session_token: reclaimedSender.session_token!,
    new_name: "snapshot-sender-renamed",
  }).ok).toBe(true);

  const inbox = pollMessages(db, receiver.id, receiver.session_token);
  expect(inbox).toHaveLength(1);
  const message = inbox[0]! as typeof inbox[number] & { sender_registry_state?: string };
  expect(message.from_name).toBe("snapshot-sender");
  expect(message.from_summary).toBe("sender-at-send");
  expect(message.from_peer_type).toBe("claude");
  expect(message.from_cwd).toBe("/snap");
  expect(message.sender_registry_state).toBe("transitioned");
});

test("credentialed stale reclaim preserves the addressed UUID and unread backlog", () => {
  const owner = reg({ name: "credentialed-backlog", peer_type: "codex", cwd: "/backlog", tty: null });
  const sender = reg({ name: "credentialed-backlog-sender", peer_type: "claude", cwd: "/backlog" });
  const identity = "identity-credentialed-backlog";
  const credential = "credentialed-backlog-secret";
  setIdentityChallenge(owner.id, identity, credential, WALL_CLOCK_PLUS_2H);
  expect(sendMessage(db, {
    from_id: sender.id,
    session_token: sender.session_token,
    to_id_or_name: owner.name,
    text: "addressed-before-authenticated-reclaim",
  }).ok).toBe(true);

  const before = db.query<{ session_token: string; identity_epoch: number }, [string]>(
    "SELECT session_token, identity_epoch FROM peers WHERE id = ?"
  ).get(owner.id)!;
  const nowMonoNs = process.hrtime.bigint();
  setLeaseState(owner.id, {
    lastSeenMonoNs: nowMonoNs - (HEARTBEAT_INTERVAL_NS * LEASE_MISS_LIMIT),
    expiresMonoNs: nowMonoNs - 1n,
    persistedMisses: 0,
  });

  const reclaimed = registerWithIdentity(identityRequest({
    name: owner.name,
    pid: 1204,
    cwd: "/backlog",
    identityKey: identity,
    credential,
  }));
  expect(reclaimed.error).toBeUndefined();
  expect(reclaimed.id).toBe(owner.id);
  expect(reclaimed.session_token).not.toBe(before.session_token);

  const after = db.query<{ identity_epoch: number; last_auth_method: string }, [string]>(
    "SELECT identity_epoch, last_auth_method FROM peers WHERE id = ?"
  ).get(owner.id)!;
  expect(after.identity_epoch).toBe(before.identity_epoch + 1);
  expect(after.last_auth_method).toBe("authenticated_reclaim");
  expect(db.query<{ c: number }, [string]>(
    "SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND acked = 0"
  ).get(owner.id)?.c).toBe(1);

  const inbox = pollMessages(db, reclaimed.id!, reclaimed.session_token!);
  expect(inbox.map(({ text }) => text)).toEqual(["addressed-before-authenticated-reclaim"]);
});

test("forced-fresh quarantines backlog and appends a token-free transition receipt", () => {
  const forceFresh = requireBrokerFn<(db: Database, req: Record<string, unknown>) => {
    ok: boolean;
    new_peer_id?: string;
    error?: string;
  }>("forceFresh");
  expect(typeof forceFresh).toBe("function");
  if (!forceFresh) return;

  ensurePeerColumns(["identity_state TEXT", "identity_epoch INTEGER"]);
  const old = reg({ name: "forced-fresh-owner", peer_type: "codex", cwd: "/forced", tty: "pts/20" });
  const sender = reg({ name: "forced-fresh-sender", peer_type: "claude" });
  const plantedCredential = "PLANTED_CREDENTIAL_MUST_NOT_LEAK_7f4c";
  const plantedGrant = "PLANTED_ONE_TIME_GRANT_MUST_NOT_LEAK_91aa";
  const plantedBody = "PLANTED_MESSAGE_BODY_MUST_NOT_LEAK_3d2e";
  expect(sendMessage(db, {
    from_id: sender.id,
    session_token: sender.session_token,
    to_id_or_name: old.name,
    text: plantedBody,
  }).ok).toBe(true);

  const request: Record<string, unknown> = {
    peer_type: "codex",
    name: old.name,
    host: "lpreet-pco",
    authenticated_host_namespace: "host:lpreet-pco",
    reason: "S337 deterministic RED contract",
    credential_secret: plantedCredential,
    stable_identity_key: "forced-fresh-new-identity",
    operator_grant: plantedGrant,
  };
  const result = forceFresh(db, request);
  expect(result.ok).toBe(true);
  expect(result.new_peer_id).toBeDefined();
  expect(result.new_peer_id).not.toBe(old.id);

  const oldRow = db.query<{ identity_state: string }, [string]>("SELECT identity_state FROM peers WHERE id = ?").get(old.id);
  expect(oldRow?.identity_state).toBe("quarantined");
  const inherited = db.query<{ c: number }, [string, string]>(
    "SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND text = ?"
  ).get(result.new_peer_id!, plantedBody);
  expect(inherited?.c).toBe(0);
  const quarantined = db.query<{ c: number }, [string, string]>(
    "SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND text = ?"
  ).get(old.id, plantedBody);
  expect(quarantined?.c).toBe(1);

  const transitionColumns = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('identity_transitions')"
  ).all().map(({ name }) => name);
  expect(transitionColumns.length).toBeGreaterThan(0);
  expect(transitionColumns.some((name) => /token|credential|verifier|salt|secret|body/i.test(name))).toBe(false);

  const receiptsBeforeReplay = db.query<Record<string, string | number | null>, []>(
    "SELECT * FROM identity_transitions ORDER BY rowid"
  ).all();
  expect(receiptsBeforeReplay.length).toBeGreaterThan(0);
  const firstReceipt = receiptsBeforeReplay[0]!;
  const firstReceiptText = JSON.stringify(firstReceipt);
  expect(firstReceiptText).toContain(old.id);
  expect(firstReceiptText).toContain(result.new_peer_id!);
  expect(firstReceiptText).toContain("forced_fresh");
  expect(firstReceiptText).toContain("quarantined_not_inherited");
  for (const plantedSecret of [
    plantedCredential,
    plantedGrant,
    plantedBody,
    old.session_token,
  ]) {
    expect(firstReceiptText).not.toContain(plantedSecret);
  }

  const replay = forceFresh(db, request);
  expect(replay.ok).toBe(false);
  expect(replay.error).toBe("IDENTITY_FORCED_FRESH_GRANT_REPLAYED");
  const receiptsAfterReplay = db.query<Record<string, string | number | null>, []>(
    "SELECT * FROM identity_transitions ORDER BY rowid"
  ).all();
  expect(receiptsAfterReplay[0]).toEqual(firstReceipt);
  for (const receipt of receiptsAfterReplay) {
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(plantedCredential);
    expect(serialized).not.toContain(plantedGrant);
    expect(serialized).not.toContain(plantedBody);
    expect(serialized).not.toContain(old.session_token);
  }
});

test("heartbeatPeer bumps last_seen with valid token", async () => {
  const a = reg({});
  const initial = getPeer(db, a.id)!.last_seen;
  await new Promise((r) => setTimeout(r, 20));
  heartbeatPeer(db, a.id, a.session_token);
  expect(getPeer(db, a.id)!.last_seen > initial).toBe(true);
});

test("heartbeatPeer with WRONG token throws typed session loss", async () => {
  const a = reg({});
  const initial = getPeer(db, a.id)!.last_seen;
  await new Promise((r) => setTimeout(r, 20));
  expect(() => heartbeatPeer(db, a.id, "wrong-token")).toThrow(SessionExpiredError);
  expect(getPeer(db, a.id)!.last_seen).toBe(initial);
});

test("setPeerSummary updates summary with valid token", () => {
  const a = reg({});
  setPeerSummary(db, a.id, a.session_token, "Working on X");
  expect(getPeer(db, a.id)?.summary).toBe("Working on X");
});

test("setPeerSummary with wrong token throws typed session loss", () => {
  const a = reg({});
  expect(() => setPeerSummary(db, a.id, "wrong", "MALICIOUS")).toThrow(SessionExpiredError);
  expect(getPeer(db, a.id)?.summary).toBe("");
});

test("unregisterPeer removes peer row with valid token, preserves messages", () => {
  const a = reg({ name: "a" });
  const b = reg({ name: "b" });
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "b", text: "hi" });
  unregisterPeer(db, b.id, b.session_token);
  expect(getPeer(db, b.id)).toBeNull();
  const remaining = db.query<{ c: number }, [string]>(
    "SELECT COUNT(*) AS c FROM messages WHERE to_id = ?"
  ).get(b.id);
  expect(remaining?.c).toBe(1);
});

test("unregisterPeer with wrong token throws typed session loss and cannot delete another peer", () => {
  const a = reg({ name: "a" });
  const b = reg({ name: "b" });
  // 'a' tries to unregister 'b' using a's token
  expect(() => unregisterPeer(db, b.id, a.session_token)).toThrow(SessionExpiredError);
  expect(getPeer(db, b.id)).not.toBeNull();
});

// ---------- listPeers ----------

test("listPeers scope=machine returns all minus excluded", () => {
  const a = reg({});
  const b = reg({ peer_type: "codex" });
  const peers = listPeers(db, { scope: "machine", cwd: "/any", git_root: null, exclude_id: a.id });
  expect(peers.map((p) => p.id)).toEqual([b.id]);
});

test("listPeers scope=directory filters by cwd", () => {
  const a = reg({ cwd: "/x" });
  reg({ cwd: "/y" });
  const peers = listPeers(db, { scope: "directory", cwd: "/x", git_root: null });
  expect(peers.map((p) => p.id)).toEqual([a.id]);
});

test("listPeers scope=repo filters by git_root", () => {
  const a = reg({ cwd: "/x/sub", git_root: "/x" });
  reg({ cwd: "/y", git_root: "/y" });
  const peers = listPeers(db, { scope: "repo", cwd: "/x", git_root: "/x" });
  expect(peers.map((p) => p.id)).toEqual([a.id]);
});

test("listPeers filters out stale peers (closed-tab ghosts disappear immediately)", () => {
  const a = reg({ name: "alive" });
  const b = reg({ name: "ghost" });
  // Backdate ghost to simulate a session whose tab was closed
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", b.id);
  const peers = listPeers(db, { scope: "machine", cwd: "/any", git_root: null });
  // Stale ghost is filtered; only live peer shows up.
  expect(peers.map((p) => p.name)).toEqual(["alive"]);
  expect(peers.map((p) => p.id)).not.toContain(b.id);
});

test("listPeers NEVER returns session_token (critical auth regression)", () => {
  // Codex adversarial review caught this: a prior SELECT * leaked every
  // peer's session_token into the discovery response, letting any caller
  // impersonate/rename/unregister others. The fix is explicit column
  // projection. This test is a hard gate against regression.
  const a = reg({ name: "alpha" });
  reg({ name: "beta" });
  const peers = listPeers(db, { scope: "machine", cwd: "/any", git_root: null });
  expect(peers.length).toBe(2);
  for (const p of peers) {
    // TypeScript already says Peer has no session_token, but the runtime row
    // could still carry it if we regressed to SELECT *. Explicit runtime check.
    expect(Object.prototype.hasOwnProperty.call(p, "session_token")).toBe(false);
    // Spot-check: fields we DO expect are present.
    expect(p.id).toBeTruthy();
    expect(p.name).toBeTruthy();
  }
  // Also verify getPeer / getPeerByName never include session_token.
  const byId = getPeer(db, a.id);
  expect(byId).not.toBeNull();
  expect(Object.prototype.hasOwnProperty.call(byId, "session_token")).toBe(false);
  const byName = getPeerByName(db, "alpha");
  expect(byName).not.toBeNull();
  expect(Object.prototype.hasOwnProperty.call(byName, "session_token")).toBe(false);
});

test("host propagates through getPeer getPeerByName and listPeers without session_token leak", () => {
  const registered = reg({ name: "hosted", host: "Lpreet-PCO", cwd: "/repo", tty: "pts/1" });
  const byId = getPeer(db, registered.id)!;
  const byName = getPeerByName(db, "hosted")!;
  const listed = listPeers(db, { scope: "machine", cwd: "/any", git_root: null })[0]!;

  expect(byId.host).toBe("lpreet-pco");
  expect(byName.host).toBe("lpreet-pco");
  expect(listed.host).toBe("lpreet-pco");
  for (const peer of [byId, byName, listed] as unknown as Record<string, unknown>[]) {
    expect(Object.prototype.hasOwnProperty.call(peer, "session_token")).toBe(false);
  }
});

test("listPeers peer_type filter", () => {
  reg({});
  const c = reg({ peer_type: "codex" });
  const peers = listPeers(db, {
    scope: "machine", cwd: "/any", git_root: null, peer_type: "codex",
  });
  expect(peers.map((p) => p.id)).toEqual([c.id]);
});

// ---------- sendMessage ----------

test("sendMessage by id with valid session stores message", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  const res = sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: b.id, text: "hi",
  });
  expect(res.ok).toBe(true);
  expect(typeof res.message_id).toBe("number");
});

test("sendMessage by name resolves to id", () => {
  const a = reg({ name: "alpha" });
  reg({ name: "beta" });
  const res = sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "hi",
  });
  expect(res.ok).toBe(true);
});

test("sendMessage unknown target returns ok=false", () => {
  const a = reg({ name: "alpha" });
  const res = sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: "nobody", text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/unknown peer/i);
});

test("sendMessage with forged from_id is rejected (auth)", () => {
  const b = reg({ name: "beta" });
  const res = sendMessage(db, {
    from_id: "not-a-real-id", session_token: "fake", to_id_or_name: b.name, text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/unauthorized|unknown/i);
});

test("sendMessage with WRONG session_token for real from_id is rejected (auth)", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  const res = sendMessage(db, {
    from_id: a.id, session_token: "wrong", to_id_or_name: b.name, text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/unauthorized/i);
});

test("sendMessage allows refresh guard precheck target to reply after same-tty token rotation", () => {
  const guard = reg({
    name: "refresh-msaasa",
    peer_type: "codex",
    cwd: "/repo",
    summary: "refresh-pair dispatcher guard for MSAASA test",
  });
  const target = reg({
    name: "target-codex",
    peer_type: "codex",
    cwd: "/repo",
    tty: "pts/9",
    pid: 101,
  });
  const precheck = sendMessage(db, {
    from_id: guard.id,
    session_token: guard.session_token,
    to_id_or_name: target.name,
    text: "ADDR refresh-pair precheck test: reply ROTATION_OK ROTATION-test-generation",
  });
  expect(precheck.ok).toBe(true);

  const replacement = reg({
    name: "target-codex",
    peer_type: "codex",
    cwd: "/repo",
    tty: "pts/9",
    pid: 202,
  });
  expect(replacement.id).toBe(target.id);
  expect(replacement.session_token).not.toBe(target.session_token);

  const directStale = sendMessage(db, {
    from_id: target.id,
    session_token: target.session_token,
    to_id_or_name: "beta",
    text: "not authorized",
  });
  expect(directStale.ok).toBe(false);
  expect(directStale.error).toMatch(/unauthorized/i);

  const reply = sendMessage(db, {
    from_id: target.id,
    session_token: target.session_token,
    to_id_or_name: guard.id,
    text: "ROTATION_OK ROTATION-test-generation",
  });
  expect(reply.ok).toBe(true);
  const guardInbox = pollMessages(db, guard.id, guard.session_token);
  expect(guardInbox.some((m) => m.text === "ROTATION_OK ROTATION-test-generation")).toBe(true);
  expect(guardInbox.every((m) => m.to_id === guard.id)).toBe(true);
});

test("sendMessage refresh guard stale-token exception requires the precheck nonce", () => {
  const guard = reg({
    name: "refresh-msaasa",
    peer_type: "codex",
    cwd: "/repo",
    summary: "refresh-pair dispatcher guard for MSAASA test",
  });
  const target = reg({
    name: "target-codex",
    peer_type: "codex",
    cwd: "/repo",
    tty: "pts/9",
    pid: 101,
  });
  expect(sendMessage(db, {
    from_id: guard.id,
    session_token: guard.session_token,
    to_id_or_name: target.name,
    text: "ADDR refresh-pair precheck test: reply ROTATION_OK ROTATION-good-nonce",
  }).ok).toBe(true);

  const replacement = reg({
    name: "target-codex",
    peer_type: "codex",
    cwd: "/repo",
    tty: "pts/9",
    pid: 202,
  });
  expect(replacement.id).toBe(target.id);
  expect(replacement.session_token).not.toBe(target.session_token);

  const wrongNonce = sendMessage(db, {
    from_id: target.id,
    session_token: target.session_token,
    to_id_or_name: guard.id,
    text: "ROTATION_OK ROTATION-wrong-nonce",
  });
  expect(wrongNonce.ok).toBe(false);
  expect(wrongNonce.error).toMatch(/unauthorized/i);

  const freeform = sendMessage(db, {
    from_id: target.id,
    session_token: target.session_token,
    to_id_or_name: guard.id,
    text: "ROTATION_OK",
  });
  expect(freeform.ok).toBe(false);
  expect(freeform.error).toMatch(/unauthorized/i);

  const block = sendMessage(db, {
    from_id: target.id,
    session_token: target.session_token,
    to_id_or_name: guard.id,
    text: "ROTATION_BLOCK ROTATION-good-nonce: shell still running",
  });
  expect(block.ok).toBe(true);
});

test("sendMessage refresh guard reply exception is scoped to the precheck target", () => {
  const guard = reg({
    name: "refresh-msaasa",
    peer_type: "codex",
    cwd: "/repo",
    summary: "refresh-pair dispatcher guard for MSAASA test",
  });
  const target = reg({ name: "target-codex", peer_type: "codex", cwd: "/repo", tty: "pts/9" });
  const outsider = reg({ name: "outsider", peer_type: "codex", cwd: "/repo", tty: "pts/10" });
  expect(sendMessage(db, {
    from_id: guard.id,
    session_token: guard.session_token,
    to_id_or_name: target.name,
    text: "ADDR refresh-pair precheck test: reply ROTATION_OK ROTATION-scoped",
  }).ok).toBe(true);

  const forged = sendMessage(db, {
    from_id: outsider.id,
    session_token: "wrong-token",
    to_id_or_name: guard.id,
    text: "ROTATION_OK forged",
  });
  expect(forged.ok).toBe(false);
  expect(forged.error).toMatch(/unauthorized/i);
});

test("sendMessage with stale sender is rejected", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", a.id);
  const res = sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: b.name, text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/sender stale/i);
});

test("sendMessage to stale target is rejected", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", b.id);
  const res = sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "hi",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/target peer stale/i);
});

// ---------- pollMessages ----------

function pair() {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  return { a, b };
}

test("pollMessages with WRONG session_token throws typed session loss without draining", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "secret" });
  expect(() => pollMessages(db, b.id, "wrong-token")).toThrow(SessionExpiredError);
  // Legitimate owner still can
  expect(pollMessages(db, b.id, b.session_token).length).toBe(1);
});

test("pollMessages with unknown peer id throws typed session loss", () => {
  expect(() => pollMessages(db, "00000000-0000-0000-0000-000000000000", "any"))
    .toThrow(SessionExpiredError);
});

test("pollMessages returns leased messages with enriched fields", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "ping" });
  const out = pollMessages(db, b.id, b.session_token);
  expect(out.length).toBe(1);
  expect(out[0]!.text).toBe("ping");
  expect(out[0]!.from_name).toBe("alpha");
  expect(out[0]!.from_peer_type).toBe("claude");
  expect(out[0]!.lease_token).toMatch(/^[a-f0-9-]{36}$/);
});

test("pollMessages twice re-delivers to same recipient while lease active", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "once" });
  const first = pollMessages(db, b.id, b.session_token);
  expect(first.length).toBe(1);
  const second = pollMessages(db, b.id, b.session_token);
  expect(second.length).toBe(1);
  expect(second[0]!.id).toBe(first[0]!.id);
  expect(second[0]!.lease_token).not.toBe(first[0]!.lease_token);
});

test("pollMessages re-delivers after lease expiry", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "once" });
  const first = pollMessages(db, b.id, b.session_token);
  expect(first.length).toBe(1);
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", first[0]!.id);
  const second = pollMessages(db, b.id, b.session_token);
  expect(second.length).toBe(1);
  expect(second[0]!.lease_token).not.toBe(first[0]!.lease_token);
});

test("pollMessages heartbeat is rolled back if tx throws", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "once" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", b.id);
  const before = db.query<{ last_seen: string }, [string]>(
    "SELECT last_seen FROM peers WHERE id = ?"
  ).get(b.id)!.last_seen;

  db.exec("ALTER TABLE messages RENAME TO messages_bak");
  try {
    expect(() => pollMessages(db, b.id, b.session_token)).toThrow();
  } finally {
    db.exec("ALTER TABLE messages_bak RENAME TO messages");
  }

  const after = db.query<{ last_seen: string }, [string]>(
    "SELECT last_seen FROM peers WHERE id = ?"
  ).get(b.id)!.last_seen;
  expect(after).toBe(before);
});

// ---------- ackMessages ----------

test("ackMessages with valid session marks rows acked", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "m" });
  const leased = pollMessages(db, b.id, b.session_token);
  const res = ackMessages(db, {
    id: b.id, session_token: b.session_token, lease_tokens: leased.map((m) => m.lease_token),
  });
  expect(res.acked).toBe(1);
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", leased[0]!.id);
  expect(pollMessages(db, b.id, b.session_token).length).toBe(0);
});

test("ackMessages with WRONG session_token returns acked=0 (auth)", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "m" });
  const leased = pollMessages(db, b.id, b.session_token);
  const res = ackMessages(db, {
    id: b.id, session_token: "wrong", lease_tokens: leased.map((m) => m.lease_token),
  });
  expect(res.acked).toBe(0);
});

test("ackMessages with unknown peer id returns acked=0", () => {
  const res = ackMessages(db, {
    id: "00000000-0000-0000-0000-000000000000",
    session_token: "any",
    lease_tokens: ["anything"],
  });
  expect(res.acked).toBe(0);
});

test("ackMessages REJECTS late acks whose lease has already expired", () => {
  const { a, b } = pair();
  sendMessage(db, { from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "m" });
  const leased = pollMessages(db, b.id, b.session_token);
  db.query("UPDATE messages SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", leased[0]!.id);
  const res = ackMessages(db, {
    id: b.id, session_token: b.session_token, lease_tokens: leased.map((m) => m.lease_token),
  });
  expect(res.acked).toBe(0);
  expect(pollMessages(db, b.id, b.session_token).length).toBe(1);
});

// ---------- renamePeer (peer-auth) + adminRenamePeer ----------

test("renamePeer with valid session_token succeeds", () => {
  const a = reg({ name: "alpha" });
  reg({ name: "beta" });
  const ok = renamePeer(db, { id: a.id, session_token: a.session_token, new_name: "gamma" });
  expect(ok.ok).toBe(true);
  expect(ok.name).toBe("gamma");
  expect(getPeerByName(db, "gamma")?.id).toBe(a.id);
});

test("renamePeer with WRONG session_token is rejected (auth — no peer impersonation)", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  // b tries to rename a using b's token
  const res = renamePeer(db, { id: a.id, session_token: b.session_token, new_name: "ha" });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/unauthorized/i);
  expect(getPeerByName(db, "alpha")?.id).toBe(a.id);
});

test("renamePeer rejects duplicate name", () => {
  const a = reg({ name: "alpha" });
  reg({ name: "beta" });
  const dup = renamePeer(db, { id: a.id, session_token: a.session_token, new_name: "beta" });
  expect(dup.ok).toBe(false);
  expect(dup.error).toMatch(/taken/i);
});

test("renamePeer rejects invalid name", () => {
  const a = reg({ name: "alpha" });
  const bad = renamePeer(db, { id: a.id, session_token: a.session_token, new_name: "has space" });
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/invalid/i);
});

// ---------- gcStalePeers ----------

test("gcStalePeers removes stale peers, preserves orphan messages", () => {
  const a = reg({ name: "alpha" });
  const b = reg({ name: "beta" });
  sendMessage(db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: "beta",
    text: "you will die before reading this",
  });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", b.id);
  const removed = gcStalePeers(db);
  expect(removed).toBe(1);
  expect(getPeer(db, b.id)).toBeNull();
  const remaining = db.query<{ c: number }, [string]>(
    "SELECT COUNT(*) AS c FROM messages WHERE to_id = ?"
  ).get(b.id);
  expect(remaining?.c).toBe(1);
  const orphans = listOrphanedMessages(db);
  expect(orphans.length).toBe(1);
  expect(orphans[0]!.to_id).toBe(b.id);
});

test("gcStalePeers does NOT delete a peer whose last_seen was refreshed", () => {
  const p = reg({ name: "racewin" });
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", p.id);
  db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run(new Date().toISOString(), p.id);
  const removed = gcStalePeers(db);
  expect(removed).toBe(0);
  expect(getPeer(db, p.id)).not.toBeNull();
});
