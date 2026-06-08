import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  AckHostIntentRequest,
  AckHostIntentResponse,
  HostIntent,
  HostIntentType,
  PeerId,
  Peer,
} from "./types.ts";
import { normalizeHostId } from "./host-id.ts";

export const HOST_INTENT_LEASE_DURATION_MS = 30_000;
const ACTIVE_STATUSES = "'pending','leased'";

function nowIso(): string {
  return new Date().toISOString();
}

export function migrate_create_host_intents(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_intents (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      type             TEXT NOT NULL CHECK(type IN ('wake', 'rotate')),
      host_id          TEXT NOT NULL,
      target_peer_id   TEXT NOT NULL,
      reason_id        TEXT NOT NULL,
      status           TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'done', 'failed')) DEFAULT 'pending',
      attempts         INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      leased_at        TEXT,
      lease_expires_at TEXT,
      lease_token      TEXT,
      result           TEXT,
      idle_proof       TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_host_intents_host_status ON host_intents(host_id, status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_host_intents_lease ON host_intents(lease_expires_at);`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_host_intents_active_wake_target
    ON host_intents(type, target_peer_id)
    WHERE type = 'wake' AND status IN ('pending', 'leased');
  `);
}

export interface EnqueueHostIntentRequest {
  type: HostIntentType;
  host_id: string;
  target_peer_id: PeerId;
  reason_id: string;
}

export function enqueueHostIntent(db: Database, req: EnqueueHostIntentRequest): { id: number } {
  const ts = nowIso();
  const hostId = normalizeHostId(req.host_id);
  if (!hostId) throw new Error("host intent requires host_id");
  const tx = db.transaction(() => {
    if (req.type === "wake") {
      const active = db.query<{ id: number }, [string]>(
        `SELECT id FROM host_intents
         WHERE type = 'wake' AND target_peer_id = ? AND status IN (${ACTIVE_STATUSES})
         ORDER BY updated_at DESC
         LIMIT 1`
      ).get(req.target_peer_id);
      if (active) {
        db.query(
          `UPDATE host_intents
             SET host_id = ?, reason_id = ?, updated_at = ?, result = NULL, idle_proof = NULL
           WHERE id = ?`
        ).run(hostId, req.reason_id, ts, active.id);
        return active;
      }
    }

    const inserted = db.query<{ id: number }, [string, string, string, string, string, string]>(
      `INSERT INTO host_intents (type, host_id, target_peer_id, reason_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)
       RETURNING id`
    ).get(req.type, hostId, req.target_peer_id, req.reason_id, ts, ts);
    if (!inserted) throw new Error("host_intents insert failed");
    return inserted;
  });
  return tx();
}

export interface PollHostIntentsInternalRequest {
  host_id: string;
  limit?: number;
  now?: string;
  lease_duration_ms?: number;
}

export function pollHostIntents(db: Database, req: PollHostIntentsInternalRequest): HostIntent[] {
  const hostId = normalizeHostId(req.host_id);
  if (!hostId) return [];
  const now = req.now ?? nowIso();
  const leaseUntil = new Date(Date.parse(now) + (req.lease_duration_ms ?? HOST_INTENT_LEASE_DURATION_MS)).toISOString();
  const limit = Math.max(1, Math.min(req.limit ?? 20, 100));

  const tx = db.transaction(() => {
    const candidates = db.query<{ id: number }, [string, string, number]>(
      `SELECT id
       FROM host_intents
       WHERE host_id = ?
         AND status IN ('pending', 'leased')
         AND (status = 'pending' OR lease_expires_at IS NULL OR lease_expires_at < ?)
       ORDER BY id ASC
       LIMIT ?`
    ).all(hostId, now, limit);

    if (candidates.length === 0) return [] as HostIntent[];
    const update = db.query(
      `UPDATE host_intents
         SET status = 'leased',
             lease_token = ?,
             leased_at = ?,
             lease_expires_at = ?,
             attempts = attempts + 1,
             updated_at = ?
       WHERE id = ?`
    );
    for (const row of candidates) {
      const leaseToken = randomUUID();
      update.run(leaseToken, now, leaseUntil, now, row.id);
    }
    const placeholders = candidates.map(() => "?").join(",");
    return db.query<HostIntent, number[]>(
      `SELECT hi.id, hi.type, hi.host_id, hi.target_peer_id,
              COALESCE(p.peer_type, 'claude') AS target_peer_type,
              COALESCE(p.name, '(gone)') AS target_name,
              COALESCE(p.cwd, '') AS target_cwd,
              p.git_root AS target_git_root,
              p.tty AS target_tty,
              hi.reason_id, hi.status, hi.attempts, hi.created_at, hi.updated_at,
              hi.leased_at, hi.lease_expires_at, hi.lease_token, hi.result, hi.idle_proof
       FROM host_intents hi
       LEFT JOIN peers p ON p.id = hi.target_peer_id
       WHERE hi.id IN (${placeholders})
       ORDER BY hi.id ASC`
    ).all(...candidates.map((row) => row.id));
  });
  return tx();
}

export function ackHostIntent(db: Database, req: AckHostIntentRequest): AckHostIntentResponse {
  const info = db.query(
    `UPDATE host_intents
       SET status = ?, result = ?, idle_proof = ?, updated_at = ?,
           lease_token = NULL, lease_expires_at = NULL
     WHERE id = ?
       AND lease_token = ?
       AND status = 'leased'`
  ).run(req.status, req.result, req.idle_proof ?? null, nowIso(), req.id, req.lease_token);
  return { ok: true, acked: info.changes ?? 0 };
}

export function enqueueRemoteWakeIntent(db: Database, peer: Peer, reason_id: string): void {
  if (!peer.host) return;
  enqueueHostIntent(db, {
    type: "wake",
    host_id: peer.host,
    target_peer_id: peer.id,
    reason_id,
  });
}
