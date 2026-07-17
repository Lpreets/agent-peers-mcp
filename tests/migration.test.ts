// Regression: opening a DB file created by the PRE-session_token schema must
// transparently migrate, drop pre-upgrade peers, then serve register/send/poll
// normally for freshly-registered peers. Self-heal on NULL tokens.
// Code review round-3/round-4 findings.

import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initDb,
  registerPeer,
  sendMessage,
  pollMessages,
  ackMessages,
} from "../broker.ts";
import { unlinkSync, existsSync } from "node:fs";

let TEST_DB: string;
afterEach(() => {
  if (TEST_DB && existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

function createLegacyDb(path: string) {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE peers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex')),
      pid           INTEGER,
      cwd           TEXT,
      git_root      TEXT,
      tty           TEXT,
      summary       TEXT DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE messages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id           TEXT NOT NULL,
      to_id             TEXT NOT NULL,
      text              TEXT NOT NULL,
      sent_at           TEXT NOT NULL,
      acked             INTEGER NOT NULL DEFAULT 0,
      lease_token       TEXT,
      lease_expires_at  TEXT
    );
  `);
  const ts = new Date().toISOString();
  db.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("legacy-uuid-1", "legacy-alpha", "claude", 1, "/legacy", null, null, "", ts, ts);
  db.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("legacy-uuid-2", "legacy-beta", "codex", 2, "/legacy", null, null, "", ts, ts);
  db.close();
}

function createPreIdentityDb(path: string) {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE peers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex')),
      host          TEXT,
      pid           INTEGER,
      cwd           TEXT,
      git_root      TEXT,
      tty           TEXT,
      summary       TEXT DEFAULT '',
      session_token TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE messages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id           TEXT NOT NULL,
      to_id             TEXT NOT NULL,
      text              TEXT NOT NULL,
      sent_at           TEXT NOT NULL,
      acked             INTEGER NOT NULL DEFAULT 0,
      lease_token       TEXT,
      lease_expires_at  TEXT
    );
  `);
  const ts = new Date().toISOString();
  db.query(
    `INSERT INTO peers
       (id, name, peer_type, host, pid, cwd, git_root, tty, summary, session_token, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "pre-identity-peer",
    "pre-identity",
    "claude",
    "legacy-reported-host",
    9,
    "/pre-identity",
    null,
    null,
    "legacy summary",
    "pre-identity-session-token",
    ts,
    ts
  );
  db.query(
    `INSERT INTO messages (from_id, to_id, text, sent_at)
     VALUES (?, ?, ?, ?)`
  ).run(
    "pre-identity-peer",
    "missing-recipient",
    "pre-identity provenance must remain unknown",
    ts
  );
  db.close();
}

function schemaSignature(db: Database) {
  return db.query<{ type: string; name: string; table_name: string; sql: string | null }, []>(
    `SELECT type, name, tbl_name AS table_name, sql
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name`
  ).all();
}

test("initDb migrates pre-session_token DB: adds column, DROPS legacy peers, messages table intact", () => {
  TEST_DB = `/tmp/agent-peers-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  createLegacyDb(TEST_DB);

  // Seed a pre-existing message (pretend in-flight) so we can check it survives
  // as an orphan after peer deletion.
  const seed = new Database(TEST_DB);
  seed.query(
    `INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)`
  ).run("legacy-uuid-1", "legacy-uuid-2", "pre-upgrade in-flight", new Date().toISOString());
  seed.close();

  const db = initDb(TEST_DB);
  try {
    // Column now exists
    const cols = db.query<{ name: string }, []>(
      `SELECT name FROM pragma_table_info('peers')`
    ).all().map((r) => r.name);
    expect(cols).toContain("session_token");

    // Legacy peer rows are gone (migration drops them)
    const peerCount = db.query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM peers"
    ).get()!.c;
    expect(peerCount).toBe(0);

    // Pre-upgrade message survives (now visible as orphan via the LEFT JOIN)
    const msgCount = db.query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM messages WHERE acked = 0"
    ).get()!.c;
    expect(msgCount).toBe(1);
  } finally {
    db.close();
  }
});

test("after migration, fresh register + send + poll + ack works normally", () => {
  TEST_DB = `/tmp/agent-peers-migration2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  createLegacyDb(TEST_DB);
  const db = initDb(TEST_DB);

  try {
    const a = registerPeer(db, {
      peer_type: "claude", pid: 1, cwd: "/new", git_root: null, tty: null, summary: "", name: "fresh-a",
    });
    const b = registerPeer(db, {
      peer_type: "claude", pid: 2, cwd: "/new", git_root: null, tty: null, summary: "", name: "fresh-b",
    });
    const sent = sendMessage(db, {
      from_id: a.id, session_token: a.session_token, to_id_or_name: "fresh-b", text: "post-upgrade hello",
    });
    expect(sent.ok).toBe(true);

    const leased = pollMessages(db, b.id, b.session_token);
    expect(leased.length).toBe(1);
    expect(leased[0]!.text).toBe("post-upgrade hello");

    const acked = ackMessages(db, {
      id: b.id, session_token: b.session_token,
      lease_tokens: leased.map((m) => m.lease_token),
    });
    expect(acked.acked).toBe(1);
  } finally {
    db.close();
  }
});

test("initDb is idempotent on an already-migrated DB", () => {
  TEST_DB = `/tmp/agent-peers-migration3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  createLegacyDb(TEST_DB);

  const db1 = initDb(TEST_DB);
  db1.close();
  // Second open should do nothing destructive
  const db2 = initDb(TEST_DB);
  try {
    const cols = db2.query<{ name: string }, []>(
      `SELECT name FROM pragma_table_info('peers')`
    ).all().map((r) => r.name);
    expect(cols).toContain("session_token");
    expect(cols).toContain("host");

    const tables = db2.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r) => r.name);
    expect(tables).toContain("host_intents");
  } finally {
    db2.close();
  }
});

test("initDb adds nullable host column to existing migrated peers without data loss", () => {
  TEST_DB = `/tmp/agent-peers-migration-host-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const setup = new Database(TEST_DB);
  setup.exec("PRAGMA journal_mode = WAL;");
  setup.exec(`
    CREATE TABLE peers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex')),
      pid           INTEGER,
      cwd           TEXT,
      git_root      TEXT,
      tty           TEXT,
      summary       TEXT DEFAULT '',
      session_token TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );
  `);
  setup.exec(`
    CREATE TABLE messages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id           TEXT NOT NULL,
      to_id             TEXT NOT NULL,
      text              TEXT NOT NULL,
      sent_at           TEXT NOT NULL,
      acked             INTEGER NOT NULL DEFAULT 0,
      lease_token       TEXT,
      lease_expires_at  TEXT
    );
  `);
  const ts = new Date().toISOString();
  setup.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, session_token, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("hostless-1", "hostless", "claude", 1, "/x", null, "pts/1", "", "token", ts, ts);
  setup.close();

  const db = initDb(TEST_DB);
  try {
    const row = db.query<{ host: string | null; name: string }, []>(
      "SELECT host, name FROM peers WHERE id = 'hostless-1'"
    ).get();
    expect(row).toEqual({ host: null, name: "hostless" });
  } finally {
    db.close();
  }
});

test("migrated DB has session_token as NOT NULL, matching fresh install invariant", () => {
  TEST_DB = `/tmp/agent-peers-migration-notnull-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  createLegacyDb(TEST_DB);

  const db = initDb(TEST_DB);
  try {
    const info = db.query<{ name: string; nn: number }, []>(
      `SELECT name, "notnull" AS nn FROM pragma_table_info('peers')`
    ).all();
    const sessionCol = info.find((c) => c.name === "session_token");
    expect(sessionCol).toBeDefined();
    expect(sessionCol!.nn).toBe(1);

    // And the peers indices still exist after the rebuild
    const indices = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='index'`
    ).all().map((r) => r.name);
    expect(indices).toContain("idx_peers_last_seen");
    expect(indices).toContain("idx_peers_name");
  } finally {
    db.close();
  }
});

test("initDb self-heals NULL session_token rows from a crashed partial migration", () => {
  TEST_DB = `/tmp/agent-peers-migration4-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  // Start with a post-migration schema (column exists) but a row with NULL token,
  // simulating a crash after ALTER TABLE but before backfill.
  const setup = new Database(TEST_DB);
  setup.exec("PRAGMA journal_mode = WAL;");
  setup.exec(`
    CREATE TABLE peers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex')),
      pid           INTEGER,
      cwd           TEXT,
      git_root      TEXT,
      tty           TEXT,
      summary       TEXT DEFAULT '',
      session_token TEXT,
      registered_at TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );
  `);
  setup.exec(`
    CREATE TABLE messages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id           TEXT NOT NULL,
      to_id             TEXT NOT NULL,
      text              TEXT NOT NULL,
      sent_at           TEXT NOT NULL,
      acked             INTEGER NOT NULL DEFAULT 0,
      lease_token       TEXT,
      lease_expires_at  TEXT
    );
  `);
  const ts = new Date().toISOString();
  // Insert row with NULL session_token
  setup.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, session_token, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run("half-migrated-1", "half", "claude", 1, "/half", null, null, "", ts, ts);
  setup.close();

  // initDb should self-heal the NULL token
  const db = initDb(TEST_DB);
  try {
    const row = db.query<{ session_token: string }, []>(
      "SELECT session_token FROM peers WHERE id = 'half-migrated-1'"
    ).get();
    expect(row?.session_token).toMatch(/^[a-f0-9-]{36}$/);
  } finally {
    db.close();
  }
});

test("C9 RED: initDb adds identity transitions and nullable provenance without backfill, idempotent across reopen", () => {
  TEST_DB = `/tmp/agent-peers-migration-identity-columns-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  createPreIdentityDb(TEST_DB);

  const first = initDb(TEST_DB);
  const firstSchema = schemaSignature(first);
  first.close();

  const db = initDb(TEST_DB);
  try {
    expect(schemaSignature(db)).toEqual(firstSchema);

    const peerCols = db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('peers')"
    ).all().map((r) => r.name);
    const msgCols = db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('messages')"
    ).all().map((r) => r.name);

    const requiredPeerColumns = [
      "stable_identity_key",
      "authenticated_host_namespace",
      "host_auth_method",
      "identity_epoch",
      "identity_state",
      "credential_salt",
      "credential_verifier",
      "lease_owner_token_hash",
      "lease_generation",
      "broker_epoch",
      "lease_owner_connection_id",
      "lease_last_seen_mono_ns",
      "lease_expires_mono_ns",
      "lease_consecutive_misses",
      "last_auth_method",
      "sender_registry_state",
    ];
    const requiredMessageColumns = [
      "provenance_version",
      "sender_epoch_at_send",
      "sender_stable_identity_key_at_send",
      "sender_authenticated_host_namespace_at_send",
      "sender_name_at_send",
      "sender_peer_type_at_send",
      "sender_cwd_at_send",
      "sender_summary_at_send",
    ];

    for (const name of requiredPeerColumns) {
      expect(peerCols).toContain(name);
    }
    for (const name of requiredMessageColumns) {
      expect(msgCols).toContain(name);
    }
    expect(peerCols).not.toContain("reclaim_credential");

    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(({ name }) => name);
    expect(tables).toContain("identity_transitions");
    const transitionCols = db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('identity_transitions')"
    ).all().map(({ name }) => name);
    expect(transitionCols.length).toBeGreaterThan(0);
    expect(transitionCols.some((name) =>
      /token|secret|credential|verifier|salt/i.test(name)
    )).toBe(false);

    const row = db.query<{
      stable_identity_key: string | null;
      authenticated_host_namespace: string | null;
      host_auth_method: string | null;
      identity_epoch: number | null;
      identity_state: string | null;
      credential_salt: string | null;
      credential_verifier: string | null;
      broker_epoch: number | null;
    }, [string]>(
      `SELECT stable_identity_key, authenticated_host_namespace, host_auth_method, identity_epoch,
              identity_state, credential_salt, credential_verifier, broker_epoch
         FROM peers WHERE id = ?`
    ).get("pre-identity-peer");
    expect(row).toEqual({
      stable_identity_key: null,
      authenticated_host_namespace: null,
      host_auth_method: null,
      identity_epoch: null,
      identity_state: null,
      credential_salt: null,
      credential_verifier: null,
      broker_epoch: null,
    });

    const sampleMessageRow = db.query<{
      provenance_version: string | null;
      sender_epoch_at_send: number | null;
      sender_stable_identity_key_at_send: string | null;
      sender_authenticated_host_namespace_at_send: string | null;
      sender_name_at_send: string | null;
      sender_peer_type_at_send: string | null;
      sender_cwd_at_send: string | null;
      sender_summary_at_send: string | null;
    }, []>(
      `SELECT provenance_version, sender_epoch_at_send,
              sender_stable_identity_key_at_send,
              sender_authenticated_host_namespace_at_send,
              sender_name_at_send, sender_peer_type_at_send,
              sender_cwd_at_send, sender_summary_at_send
         FROM messages LIMIT 1`
    ).get();
    expect(sampleMessageRow).toEqual({
      provenance_version: null,
      sender_epoch_at_send: null,
      sender_stable_identity_key_at_send: null,
      sender_authenticated_host_namespace_at_send: null,
      sender_name_at_send: null,
      sender_peer_type_at_send: null,
      sender_cwd_at_send: null,
      sender_summary_at_send: null,
    });
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM identity_transitions"
    ).get()?.count).toBe(0);
  } finally {
    db.close();
  }
});

test("C9 RED: initDb creates partial stable-subject uniqueness and nullable INTEGER broker epoch", () => {
  TEST_DB = `/tmp/agent-peers-migration-partial-idx-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  createPreIdentityDb(TEST_DB);

  const db = initDb(TEST_DB);
  try {
    const indexRows = db.query<{
      name: string;
      is_unique: number;
      is_partial: number;
      sql: string | null;
    }, []>(
      `SELECT il.name, il."unique" AS is_unique, il.partial AS is_partial, sm.sql
         FROM pragma_index_list('peers') AS il
         LEFT JOIN sqlite_master AS sm
           ON sm.type = 'index' AND sm.name = il.name`
    ).all();
    const identityIndex = indexRows.find(({ is_unique, is_partial, sql }) => {
      const normalized = (sql ?? "").toLowerCase();
      return is_unique === 1
        && is_partial === 1
        && normalized.includes("stable_identity_key")
        && normalized.includes("identity_state")
        && normalized.includes("where");
    });
    expect(identityIndex).toBeDefined();

    const brokerEpoch = db.query<{ type: string; not_null: number }, []>(
      `SELECT type, "notnull" AS not_null
         FROM pragma_table_info('peers')
        WHERE name = 'broker_epoch'`
    ).get();
    expect(brokerEpoch).toEqual({ type: "INTEGER", not_null: 0 });
  } finally {
    db.close();
  }
});
