// shared/types.ts
// Canonical types used by broker, clients, and CLI.

export type PeerId = string; // UUID v4
export type PeerType = "claude" | "codex";
export type PeerName = string; // 1-32 chars, ^[a-zA-Z0-9_-]+$

export interface Peer {
  id: PeerId;
  name: PeerName;
  peer_type: PeerType;
  host: string | null;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface LeasedMessage {
  id: number;
  from_id: PeerId;
  from_name: PeerName;
  from_peer_type: PeerType;
  from_cwd: string;
  from_summary: string;
  to_id: PeerId;
  text: string;
  sent_at: string;
  lease_token: string;
}

// ----- Broker API request/response -----

export interface RegisterRequest {
  peer_type: PeerType;
  host?: string | null;
  name?: PeerName;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
  name: PeerName;
  session_token: string; // opaque per-session auth token; required on peer mutations
}

export interface HeartbeatRequest { id: PeerId; session_token: string; }

export interface UnregisterRequest { id: PeerId; session_token: string; }

export interface SetSummaryRequest { id: PeerId; session_token: string; summary: string; }

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
  peer_type?: PeerType;
}

export interface SendMessageRequest {
  from_id: PeerId;
  session_token: string;
  to_id_or_name: string;
  text: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  message_id?: number;
  to_id?: PeerId; // resolved recipient id (from RETURNING) — used by the wake worker
}

export interface PollMessagesRequest { id: PeerId; session_token: string; }

export interface PollMessagesResponse {
  messages: LeasedMessage[];
}

export interface AckMessagesRequest {
  id: PeerId;
  session_token: string;
  lease_tokens: string[];
}

export interface AckMessagesResponse {
  ok: boolean;
  acked: number;
}

export interface RenamePeerRequest {
  id: PeerId;
  session_token: string;
  new_name: PeerName;
}

export interface RenamePeerResponse {
  ok: boolean;
  error?: string;
  name?: PeerName;
}

// ----- Host-local executor intent queue -----

export type HostIntentType = "wake" | "rotate";
export type HostIntentStatus = "pending" | "leased" | "done" | "failed";

export interface HostIntent {
  id: number;
  type: HostIntentType;
  host_id: string;
  target_peer_id: PeerId;
  target_peer_type: PeerType;
  target_name: PeerName;
  target_cwd: string;
  target_git_root: string | null;
  target_tty: string | null;
  reason_id: string;
  status: HostIntentStatus;
  attempts: number;
  created_at: string;
  updated_at: string;
  leased_at: string | null;
  lease_expires_at: string | null;
  lease_token: string | null;
  result: string | null;
  idle_proof: string | null;
}

export interface PollHostIntentsRequest {
  host_id: string;
  limit?: number;
}

export interface PollHostIntentsResponse {
  intents: HostIntent[];
}

export interface AckHostIntentRequest {
  id: number;
  lease_token: string;
  status: "done" | "failed";
  result: string;
  idle_proof?: string | null;
}

export interface AckHostIntentResponse {
  ok: boolean;
  acked: number;
}

// ----- Idle-safe wake layer (S310 Fix 1) -----
// Seam between the broker-daemon wake worker (Claude/zany-kiwi) and the
// tmux wake mechanism (Codex/jolly-moose). The worker decides WHEN to attempt
// a wake (queue + debounce); the mechanism decides IF the target is safely
// idle and performs the content-free nudge. Every non-"woke" result is
// non-fatal telemetry — message delivery is already committed and durable.

export type WakeMode = "off" | "log-only" | "on";

export type WakeResult =
  | "woke"
  | "queued_remote"            // broker queued a durable host-local executor intent
  | "would_wake"               // log-only: validation passed, no keys sent
  | "would_wake_low_confidence" // log-only: tty+scope ok but missing 2nd identity signal
  | "skipped_active"           // an active marker was visible → never inject
  | "skipped_not_idle"         // no positive idle proof (e.g. only one stable sample)
  | "skipped_peer_type_excluded" // peer type disabled by wake policy
  | "skipped_no_pane"          // tty resolves to no live tmux pane
  | "skipped_ambiguous"        // >1 candidate pane matched
  | "skipped_scope_mismatch"   // pane cwd outside registered project/git_root
  | "error";                   // mechanism threw (caught, non-fatal)

// Input the worker hands the mechanism. tty is a CANDIDATE only — the
// mechanism must resolve+validate the live pane before any keystroke.
export interface WakeTarget {
  peer_id: PeerId;
  peer_type: PeerType;
  name: PeerName;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  reason_id: string;           // correlation id for telemetry (e.g. "msg-<id>")
}

// Structured wake telemetry. NEVER carries message text or secrets — only
// identity + decision + idle-proof summary (per the locked contract).
export interface WakeDecision {
  peer_id: PeerId;
  name: PeerName;
  peer_type: PeerType;
  tty: string | null;
  cwd: string;
  result: WakeResult;
  reason_id: string;
  mode: WakeMode;
  idle_proof?: string;         // short human summary, no captured body
  at: string;                  // ISO timestamp
}

// The contract the mechanism (shared/tmux-wake.ts) implements and the worker
// imports. Resolves+validates the live pane, requires positive 2-sample idle
// proof, and performs the content-free nudge only in "on" mode.
export type WakePeerIfIdle = (
  target: WakeTarget,
  mode: WakeMode,
) => Promise<WakeDecision>;
