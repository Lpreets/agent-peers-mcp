// shared/register-retry.ts
//
// S348 — bounded retry for /register live-holder conflicts.
//
// Why this exists: the registration identity key is (peer_type, host, cwd, tty).
// `refresh-pair` rotates a pane with `tmux respawn-pane -k`, so all four are
// IDENTICAL across a rotation. The predecessor heartbeats right up until it is
// killed, so its row's last_seen is fresh, the stale-reclaim path is skipped,
// and the successor — which has no /prepare-replacement capability, because the
// predecessor died without issuing one — gets HTTP 409.
//
// The row becomes reclaimable after STALE_RECLAIM_THRESHOLD_MS (60s), but the
// server registered exactly ONCE at startup and never retried, so it stayed
// locked out for its whole session. Rotation was self-blocking by construction.
//
// Retry is safe here only because of two other S348 properties:
//   1. the MCP transport is already attached (codex-server), so retrying costs
//      nothing user-visible — readiness stays `initializing` and tool calls
//      keep returning the typed broker-unavailable error;
//   2. PEER_GC_RETENTION_MS > STALE_RECLAIM_THRESHOLD_MS (broker.ts), so the
//      row we are waiting to reclaim cannot be GC-deleted out from under us —
//      otherwise "eventually registered" could mean registered under a NEW
//      uuid, silently orphaning messages addressed to the old one.
//
// A continuously heartbeating holder is still protected: it never goes stale,
// so every attempt 409s and we fail bounded rather than stealing its identity.
// /prepare-replacement remains the clean fast path for healthy rotations; this
// is the outage-safe correctness fallback.

import { BrokerHttpError } from "./broker-client.ts";

/** Must exceed the broker's STALE_RECLAIM_THRESHOLD_MS (60s) with margin. */
export const REGISTER_RETRY_DEADLINE_MS = 90_000;
export const REGISTER_RETRY_INTERVAL_MS = 5_000;

/** ONLY a 409 on /register is retryable. Everything else is a real failure. */
export function isLiveHolderConflict(error: unknown): boolean {
  return error instanceof BrokerHttpError
    && error.status === 409
    && error.path === "/register";
}

export interface RegisterRetryDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface RegisterRetryOptions {
  deadlineMs?: number;
  intervalMs?: number;
  /** Observability hook: called before each wait. */
  onRetry?: (attempt: number, elapsedMs: number) => void;
}

/**
 * Run `attempt` until it succeeds, a non-retryable error occurs, or the
 * deadline would be exceeded. Rethrows the last 409 on timeout so the caller
 * reports the real reason rather than a synthesised one.
 */
export async function registerWithRetry<T>(
  attempt: () => Promise<T>,
  deps: RegisterRetryDeps,
  options: RegisterRetryOptions = {},
): Promise<T> {
  const deadlineMs = options.deadlineMs ?? REGISTER_RETRY_DEADLINE_MS;
  const intervalMs = options.intervalMs ?? REGISTER_RETRY_INTERVAL_MS;
  const startedAt = deps.now();
  let attemptNo = 0;

  for (;;) {
    attemptNo++;
    try {
      return await attempt();
    } catch (error) {
      // Non-409, or 409 from some other endpoint: never retried.
      if (!isLiveHolderConflict(error)) throw error;

      const elapsedMs = deps.now() - startedAt;
      // Bounded: only sleep if the NEXT attempt still lands inside the budget.
      if (elapsedMs + intervalMs > deadlineMs) throw error;

      options.onRetry?.(attemptNo, elapsedMs);
      await deps.sleep(intervalMs);
    }
  }
}
