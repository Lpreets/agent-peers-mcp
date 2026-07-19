// Comprehensive unit tests for broker.ts — covers every in-process primitive.

import { test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import * as brokerModule from "../broker.ts";
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
import type { Database } from "bun:sqlite";
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

type ReplacementProof = {
  peer_id: string;
  capability: string;
};

type RegistrationOptions = {
  name?: string;
  peer_type?: "claude" | "codex";
  host?: string | null;
  cwd?: string;
  git_root?: string | null;
  tty?: string | null;
  summary?: string;
  pid?: number;
  replacement?: ReplacementProof;
};

type RegistrationRequestWithReplacement = Parameters<typeof registerPeer>[1] & {
  replacement?: ReplacementProof;
};

type RegistrationResult = ReturnType<typeof registerPeer>;

type RegistrationAttempt = {
  result?: RegistrationResult;
  error?: unknown;
};

type ReplacementCapability = {
  capability: string;
  expires_at: string;
};

type ReplacementIssuer = (
  targetDb: Database,
  peerId: string,
  sessionToken: string,
) => ReplacementCapability;

type LiveHolderConflictConstructor = abstract new (...args: never[]) => Error;

type HolderSnapshot = {
  id: string;
  name: string;
  peer_type: string;
  host: string | null;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  session_token: string;
  registered_at: string;
  last_seen: string;
};

// Helper: register and return a full auth handle. The intersection keeps this
// test compile-safe before the future replacement field lands in shared types.
function reg(opts: RegistrationOptions) {
  const request = {
    peer_type: opts.peer_type ?? "claude",
    pid: opts.pid ?? 1,
    cwd: opts.cwd ?? "/x",
    git_root: opts.git_root ?? null,
    tty: opts.tty ?? null,
    host: opts.host,
    summary: opts.summary ?? "",
    ...(opts.name ? { name: opts.name } : {}),
  } as RegistrationRequestWithReplacement;
  if (opts.replacement) request.replacement = opts.replacement;
  return registerPeer(db, request);
}

function attemptRegistration(opts: RegistrationOptions): RegistrationAttempt {
  try {
    return { result: reg(opts) };
  } catch (error) {
    return { error };
  }
}

function issueReplacementCapability(
  peerId: string,
  sessionToken: string,
): ReplacementCapability {
  const issuer = (brokerModule as unknown as {
    issueReplacementCapability?: ReplacementIssuer;
  }).issueReplacementCapability;
  if (typeof issuer !== "function") {
    throw new Error("RED contract missing: issueReplacementCapability");
  }
  const grant = issuer(db, peerId, sessionToken);
  expect(typeof grant.capability).toBe("string");
  expect(grant.capability.length >= 22).toBe(true); // >=128 bits in base64url form
  expect(Number.isFinite(Date.parse(grant.expires_at))).toBe(true);
  return grant;
}

function expectLiveHolderConflict(
  attempt: RegistrationAttempt,
  forbiddenValues: string[] = [],
): void {
  // Assert presence as booleans so a failing RED run cannot print a returned
  // RegisterResponse (which contains the disposable session token).
  expect(attempt.result === undefined).toBe(true);
  expect(attempt.error instanceof Error).toBe(true);
  if (!(attempt.error instanceof Error)) return;

  const conflictConstructor = (brokerModule as unknown as {
    LiveHolderConflictError?: LiveHolderConflictConstructor;
  }).LiveHolderConflictError;
  expect(typeof conflictConstructor).toBe("function");
  if (typeof conflictConstructor === "function") {
    expect(attempt.error instanceof conflictConstructor).toBe(true);
  }
  expect(attempt.error.name).toBe("LiveHolderConflictError");
  expect((attempt.error as Error & { code?: string }).code).toBe("LIVE_HOLDER_CONFLICT");
  for (const forbidden of forbiddenValues) {
    expect(attempt.error.message.includes(forbidden)).toBe(false);
  }
}

function snapshotHolder(peerId: string): HolderSnapshot {
  return db.query<HolderSnapshot, [string]>(
    `SELECT id, name, peer_type, host, pid, cwd, git_root, tty, summary,
            session_token, registered_at, last_seen
       FROM peers WHERE id = ?`,
  ).get(peerId)!;
}

function expectHolderUnchanged(before: HolderSnapshot): void {
  const after = snapshotHolder(before.id);
  expect({
    id: after.id,
    name: after.name,
    peer_type: after.peer_type,
    host: after.host,
    pid: after.pid,
    cwd: after.cwd,
    git_root: after.git_root,
    tty: after.tty,
    summary: after.summary,
    registered_at: after.registered_at,
    last_seen: after.last_seen,
  }).toEqual({
    id: before.id,
    name: before.name,
    peer_type: before.peer_type,
    host: before.host,
    pid: before.pid,
    cwd: before.cwd,
    git_root: before.git_root,
    tty: before.tty,
    summary: before.summary,
    registered_at: before.registered_at,
    last_seen: before.last_seen,
  });
  expect(after.session_token === before.session_token).toBe(true);
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

test("registerPeer refuses an active same-tuple collision without mutating its holder", () => {
  const first = reg({
    name: "live-holder",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/repo",
    tty: "pts/9",
    pid: 101,
    summary: "holder summary",
  });
  const before = snapshotHolder(first.id);
  const attempt = attemptRegistration({
    name: "spoofed-replacement-name",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/repo",
    tty: "pts/9",
    pid: 202,
    summary: "spoofed replacement summary",
  });

  expectLiveHolderConflict(attempt, [
    first.id,
    first.name,
    first.session_token,
    "lpreet-pco",
    "/repo",
    "pts/9",
    "holder summary",
    "spoofed-replacement-name",
    "spoofed replacement summary",
  ]);
  expectHolderUnchanged(before);
  expect(listPeers(db, { scope: "machine", cwd: "/any", git_root: null, peer_type: "codex" })).toHaveLength(1);
  expect(() => heartbeatPeer(db, first.id, first.session_token)).not.toThrow();
  expect(getPeer(db, first.id)?.pid).toBe(101);
});

test("denied active collision preserves the holder's lease and mailbox authority", () => {
  const sender = reg({ name: "sender" });
  const first = reg({ name: "receiver", peer_type: "codex", cwd: "/repo", tty: "pts/9" });

  sendMessage(db, {
    from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: "receiver", text: "leased",
  });
  const leased = pollMessages(db, first.id, first.session_token);
  expect(leased).toHaveLength(1);
  const beforeHolder = snapshotHolder(first.id);
  const beforeLease = db.query<{
    lease_token: string | null;
    lease_expires_at: string | null;
    acked: number;
  }, [number]>(
    "SELECT lease_token, lease_expires_at, acked FROM messages WHERE id = ?",
  ).get(leased[0]!.id)!;

  const attempt = attemptRegistration({
    name: "new-name",
    peer_type: "codex",
    cwd: "/repo",
    tty: "pts/9",
    pid: 303,
  });
  expectLiveHolderConflict(attempt, [first.session_token]);
  expectHolderUnchanged(beforeHolder);

  const afterLease = db.query<{
    lease_token: string | null;
    lease_expires_at: string | null;
    acked: number;
  }, [number]>(
    "SELECT lease_token, lease_expires_at, acked FROM messages WHERE id = ?",
  ).get(leased[0]!.id)!;
  expect(afterLease.lease_token === beforeLease.lease_token).toBe(true);
  expect(afterLease.lease_expires_at).toBe(beforeLease.lease_expires_at);
  expect(afterLease.acked).toBe(beforeLease.acked);

  const stillLeased = pollMessages(db, first.id, first.session_token);
  expect(stillLeased).toHaveLength(1);
  expect(stillLeased[0]!.id).toBe(leased[0]!.id);
  expect(stillLeased[0]!.lease_token === leased[0]!.lease_token).toBe(false);
  expect(ackMessages(db, {
    id: first.id,
    session_token: first.session_token,
    lease_tokens: [stillLeased[0]!.lease_token],
  }).acked).toBe(1);
});

test("exact metadata and matching name do not authorize active replacement", () => {
  const first = reg({
    name: "stable",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/repo",
    tty: "pts/9",
    pid: 101,
    summary: "identical metadata",
  });
  const before = snapshotHolder(first.id);
  const attempt = attemptRegistration({
    name: "stable",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/repo",
    tty: "pts/9",
    pid: 101,
    summary: "identical metadata",
  });

  expectLiveHolderConflict(attempt, [first.session_token, "identical metadata"]);
  expectHolderUnchanged(before);
  expect(getPeerByName(db, "stable-2")).toBeNull();
  expect(() => heartbeatPeer(db, first.id, first.session_token)).not.toThrow();
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

test("registerPeer normalizes host for comparison but refuses an active match", () => {
  const first = reg({ name: "stable-host", peer_type: "codex", host: "Lpreet-PCO", cwd: "/repo", tty: "pts/9", pid: 101 });
  const before = snapshotHolder(first.id);
  const attempt = attemptRegistration({
    name: "stable-host",
    peer_type: "codex",
    host: " lpreet-pco ",
    cwd: "/repo",
    tty: "pts/9",
    pid: 202,
  });

  expectLiveHolderConflict(attempt, [first.session_token]);
  expectHolderUnchanged(before);
  const row = getPeer(db, first.id)!;
  expect(row.host).toBe("lpreet-pco");
  expect(row.pid).toBe(101);
});

test("registerPeer refuses an active legacy null-host match", () => {
  const first = reg({ name: "legacy-hostless", peer_type: "codex", host: null, cwd: "/repo", tty: "pts/9", pid: 101 });
  const before = snapshotHolder(first.id);
  const attempt = attemptRegistration({
    name: "legacy-hostless",
    peer_type: "codex",
    host: null,
    cwd: "/repo",
    tty: "pts/9",
    pid: 202,
  });

  expectLiveHolderConflict(attempt, [first.session_token]);
  expectHolderUnchanged(before);
  expect(getPeer(db, first.id)?.host).toBeNull();
  expect(getPeer(db, first.id)?.pid).toBe(101);
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

test("replacement capability issuance requires the current holder token", () => {
  const holder = reg({
    name: "grant-auth-holder",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/grant-auth",
    tty: "pts/31",
  });
  const before = snapshotHolder(holder.id);

  expect(() => issueReplacementCapability(holder.id, "wrong-token"))
    .toThrow(SessionExpiredError);
  expectHolderUnchanged(before);
  expect(() => heartbeatPeer(db, holder.id, holder.session_token)).not.toThrow();
});

test("valid replacement capability succeeds once and preserves mailbox continuity", () => {
  const sender = reg({ name: "grant-sender" });
  const holder = reg({
    name: "grant-holder",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/grant",
    tty: "pts/32",
    pid: 101,
  });

  expect(sendMessage(db, {
    from_id: sender.id,
    session_token: sender.session_token,
    to_id_or_name: holder.id,
    text: "already acked",
  }).ok).toBe(true);
  const acknowledged = pollMessages(db, holder.id, holder.session_token);
  expect(ackMessages(db, {
    id: holder.id,
    session_token: holder.session_token,
    lease_tokens: [acknowledged[0]!.lease_token],
  }).acked).toBe(1);

  expect(sendMessage(db, {
    from_id: sender.id,
    session_token: sender.session_token,
    to_id_or_name: holder.id,
    text: "leased before replacement",
  }).ok).toBe(true);
  expect(pollMessages(db, holder.id, holder.session_token)).toHaveLength(1);
  expect(sendMessage(db, {
    from_id: sender.id,
    session_token: sender.session_token,
    to_id_or_name: holder.id,
    text: "unleased before replacement",
  }).ok).toBe(true);

  const grant = issueReplacementCapability(holder.id, holder.session_token);
  const replacement = reg({
    name: "metadata-name-is-ignored",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/grant",
    tty: "pts/32",
    pid: 202,
    replacement: { peer_id: holder.id, capability: grant.capability },
  });
  expect(replacement.id).toBe(holder.id);
  expect(replacement.name).toBe(holder.name);
  expect(replacement.session_token === holder.session_token).toBe(false);
  expect(() => heartbeatPeer(db, holder.id, holder.session_token)).toThrow(SessionExpiredError);
  expect(() => heartbeatPeer(db, replacement.id, replacement.session_token)).not.toThrow();

  const backlog = pollMessages(db, replacement.id, replacement.session_token);
  expect(backlog.map((message) => message.text).sort()).toEqual([
    "leased before replacement",
    "unleased before replacement",
  ]);
  expect(backlog.some((message) => message.text === "already acked")).toBe(false);

  const beforeReplay = snapshotHolder(replacement.id);
  const replay = attemptRegistration({
    name: "replay-attempt",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/grant",
    tty: "pts/32",
    pid: 303,
    replacement: { peer_id: holder.id, capability: grant.capability },
  });
  expectLiveHolderConflict(replay, [replacement.session_token, grant.capability]);
  expectHolderUnchanged(beforeReplay);
});

test("wrong capability conflicts without consuming a valid grant", () => {
  const holder = reg({
    name: "wrong-grant-holder",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/wrong-grant",
    tty: "pts/33",
    pid: 101,
  });
  const grant = issueReplacementCapability(holder.id, holder.session_token);
  const before = snapshotHolder(holder.id);
  const invalidCapability = "test-only-invalid-capability";
  const denied = attemptRegistration({
    name: "wrong-grant-attempt",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/wrong-grant",
    tty: "pts/33",
    pid: 202,
    replacement: { peer_id: holder.id, capability: invalidCapability },
  });
  expectLiveHolderConflict(denied, [holder.session_token, invalidCapability]);
  expectHolderUnchanged(before);

  const replacement = reg({
    name: "valid-after-wrong",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/wrong-grant",
    tty: "pts/33",
    pid: 303,
    replacement: { peer_id: holder.id, capability: grant.capability },
  });
  expect(replacement.id).toBe(holder.id);
  expect(replacement.session_token === holder.session_token).toBe(false);
});

test("replacement capability is bound to its issuing peer", () => {
  const target = reg({
    name: "bound-target",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/bound-target",
    tty: "pts/34",
    pid: 101,
  });
  const grantOwner = reg({
    name: "bound-owner",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/bound-owner",
    tty: "pts/35",
    pid: 201,
  });
  const grant = issueReplacementCapability(grantOwner.id, grantOwner.session_token);
  const targetBefore = snapshotHolder(target.id);
  const ownerBefore = snapshotHolder(grantOwner.id);

  const denied = attemptRegistration({
    name: "cross-peer-attempt",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/bound-target",
    tty: "pts/34",
    pid: 102,
    replacement: { peer_id: grantOwner.id, capability: grant.capability },
  });
  expectLiveHolderConflict(denied, [target.session_token, grant.capability]);
  expectHolderUnchanged(targetBefore);
  expectHolderUnchanged(ownerBefore);

  const ownerReplacement = reg({
    name: "bound-owner-replacement",
    peer_type: "codex",
    host: "lpreet-pco",
    cwd: "/bound-owner",
    tty: "pts/35",
    pid: 202,
    replacement: { peer_id: grantOwner.id, capability: grant.capability },
  });
  expect(ownerReplacement.id).toBe(grantOwner.id);
  expect(ownerReplacement.session_token === grantOwner.session_token).toBe(false);
});

test("expired replacement capability conflicts without mutating the holder", () => {
  const issuedAt = new Date("2040-01-02T03:04:05.000Z");
  setSystemTime(issuedAt);
  try {
    const holder = reg({
      name: "expired-grant-holder",
      peer_type: "codex",
      host: "lpreet-pco",
      cwd: "/expired-grant",
      tty: "pts/36",
      pid: 101,
    });
    const grant = issueReplacementCapability(holder.id, holder.session_token);
    expect(Date.parse(grant.expires_at) === issuedAt.getTime() + 30_000).toBe(true);
    const before = snapshotHolder(holder.id);

    setSystemTime(issuedAt.getTime() + 30_001);
    const denied = attemptRegistration({
      name: "expired-grant-attempt",
      peer_type: "codex",
      host: "lpreet-pco",
      cwd: "/expired-grant",
      tty: "pts/36",
      pid: 202,
      replacement: { peer_id: holder.id, capability: grant.capability },
    });
    expectLiveHolderConflict(denied, [holder.session_token, grant.capability]);
    expectHolderUnchanged(before);
  } finally {
    setSystemTime();
  }
});

test("same-tuple row exactly at the stale cutoff is still live and conflicts", () => {
  const now = new Date("2040-02-03T04:05:06.000Z");
  setSystemTime(now);
  try {
    const holder = reg({
      name: "cutoff-live",
      peer_type: "codex",
      host: "lpreet-pco",
      cwd: "/cutoff-live",
      tty: "pts/37",
      pid: 101,
    });
    db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
      .run(new Date(now.getTime() - 60_000).toISOString(), holder.id);
    const before = snapshotHolder(holder.id);

    const denied = attemptRegistration({
      name: "cutoff-live",
      peer_type: "codex",
      host: "lpreet-pco",
      cwd: "/cutoff-live",
      tty: "pts/37",
      pid: 202,
    });
    expectLiveHolderConflict(denied, [holder.session_token]);
    expectHolderUnchanged(before);
    expect(() => heartbeatPeer(db, holder.id, holder.session_token)).not.toThrow();
  } finally {
    setSystemTime();
  }
});

test("same-tuple row one millisecond before the cutoff is stale and reclaims", () => {
  const now = new Date("2040-02-03T04:05:06.000Z");
  setSystemTime(now);
  try {
    const stale = reg({
      name: "cutoff-stale",
      peer_type: "codex",
      host: "lpreet-pco",
      cwd: "/cutoff-stale",
      tty: "pts/38",
      pid: 101,
    });
    db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
      .run(new Date(now.getTime() - 60_001).toISOString(), stale.id);

    const reclaimed = reg({
      name: "cutoff-stale",
      peer_type: "codex",
      host: "lpreet-pco",
      cwd: "/cutoff-stale",
      tty: "pts/38",
      pid: 202,
    });
    expect(reclaimed.id).toBe(stale.id);
    expect(reclaimed.name).toBe(stale.name);
    expect(reclaimed.session_token === stale.session_token).toBe(false);
    expect(() => heartbeatPeer(db, stale.id, stale.session_token)).toThrow(SessionExpiredError);
    expect(() => heartbeatPeer(db, reclaimed.id, reclaimed.session_token)).not.toThrow();
  } finally {
    setSystemTime();
  }
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

  const replacementGrant = issueReplacementCapability(target.id, target.session_token);
  const replacement = reg({
    name: "target-codex",
    peer_type: "codex",
    cwd: "/repo",
    tty: "pts/9",
    pid: 202,
    replacement: { peer_id: target.id, capability: replacementGrant.capability },
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

  const replacementGrant = issueReplacementCapability(target.id, target.session_token);
  const replacement = reg({
    name: "target-codex",
    peer_type: "codex",
    cwd: "/repo",
    tty: "pts/9",
    pid: 202,
    replacement: { peer_id: target.id, capability: replacementGrant.capability },
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
