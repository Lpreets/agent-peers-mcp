// tests/register-retry.test.ts
//
// S348 — retry policy contract (Codex RV assertions 2 and 6, plus the negative
// companion). Deliberately unit-level with an injected clock: an end-to-end
// spawn test could NOT reproduce the collision reliably, because the server
// derives tty from its parent via `ps` and a test runner without a controlling
// terminal yields tty=null — while the broker's identity match is `tty = ?`,
// which never matches NULL. Such a test would pass for the wrong reason, the
// same class of environment-dependent fixture defect as the earlier
// hard-coded-address version of transport-attach-first.test.ts.

import { test, expect } from "bun:test";
import { BrokerHttpError } from "../shared/broker-client.ts";
import {
  registerWithRetry,
  isLiveHolderConflict,
  REGISTER_RETRY_DEADLINE_MS,
} from "../shared/register-retry.ts";
import { STALE_RECLAIM_THRESHOLD_MS } from "../broker.ts";

/** Virtual clock — no wall-clock waiting, fully deterministic. */
function fakeDeps() {
  let nowMs = 0;
  return {
    deps: {
      now: () => nowMs,
      sleep: async (ms: number) => { nowMs += ms; },
    },
    elapsed: () => nowMs,
  };
}

const conflict = () => new BrokerHttpError("/register", 409);

test("INVARIANT: the retry deadline outlives the broker's reclaim threshold", () => {
  // If the deadline ever drops below the reclaim window, retry can never
  // succeed and the rotation self-block silently returns.
  expect(REGISTER_RETRY_DEADLINE_MS).toBeGreaterThan(STALE_RECLAIM_THRESHOLD_MS);
});

test("succeeds ONLY after waiting past the broker's 60s reclaim threshold", async () => {
  const { deps, elapsed } = fakeDeps();
  let attempts = 0;
  const result = await registerWithRetry(async () => {
    attempts++;
    // Mirrors the broker exactly: the predecessor's row is reclaimable only
    // once it is strictly staler than STALE_RECLAIM_THRESHOLD_MS. Success is
    // therefore CONDITIONAL on virtual time, not on an attempt count — an
    // earlier version succeeded at 15s and asserted only elapsed > 0, which
    // never proved the behaviour the retry exists for.
    if (deps.now() <= STALE_RECLAIM_THRESHOLD_MS) throw conflict();
    return { id: "peer-1", name: "msaasa-codex", session_token: "tok-new" };
  }, deps);

  expect(result.name).toBe("msaasa-codex");
  expect(elapsed()).toBeGreaterThan(STALE_RECLAIM_THRESHOLD_MS);
  expect(elapsed()).toBeLessThanOrEqual(REGISTER_RETRY_DEADLINE_MS);
  expect(attempts).toBeGreaterThan(1);
});

test("waits past the broker's 60s reclaim threshold before giving up", async () => {
  const { deps, elapsed } = fakeDeps();
  let attempts = 0;
  await expect(registerWithRetry(async () => {
    attempts++;
    throw conflict();
  }, deps)).rejects.toThrow(/HTTP 409/);

  // Negative companion: a holder heartbeating throughout the budget is NEVER
  // replaced — we fail bounded instead of stealing its identity.
  expect(elapsed()).toBeGreaterThan(60_000);
  expect(elapsed()).toBeLessThanOrEqual(REGISTER_RETRY_DEADLINE_MS);
  expect(attempts).toBeGreaterThan(1);
});

test("does NOT retry a non-409 failure", async () => {
  const { deps } = fakeDeps();
  let attempts = 0;
  await expect(registerWithRetry(async () => {
    attempts++;
    throw new BrokerHttpError("/register", 500);
  }, deps)).rejects.toThrow(/HTTP 500/);
  expect(attempts).toBe(1);
});

test("does NOT retry a 401 session-expired failure", async () => {
  const { deps } = fakeDeps();
  let attempts = 0;
  await expect(registerWithRetry(async () => {
    attempts++;
    throw new BrokerHttpError("/register", 401);
  }, deps)).rejects.toThrow(/HTTP 401/);
  expect(attempts).toBe(1);
});

test("does NOT retry a 409 from a different endpoint", async () => {
  const { deps } = fakeDeps();
  let attempts = 0;
  await expect(registerWithRetry(async () => {
    attempts++;
    throw new BrokerHttpError("/rename-peer", 409);
  }, deps)).rejects.toThrow(/HTTP 409/);
  expect(attempts).toBe(1);
});

test("does NOT retry a generic non-broker error", async () => {
  const { deps } = fakeDeps();
  let attempts = 0;
  await expect(registerWithRetry(async () => {
    attempts++;
    throw new Error("ECONNREFUSED");
  }, deps)).rejects.toThrow(/ECONNREFUSED/);
  expect(attempts).toBe(1);
});

test("isLiveHolderConflict discriminates precisely", () => {
  expect(isLiveHolderConflict(new BrokerHttpError("/register", 409))).toBe(true);
  expect(isLiveHolderConflict(new BrokerHttpError("/register", 500))).toBe(false);
  expect(isLiveHolderConflict(new BrokerHttpError("/heartbeat", 409))).toBe(false);
  expect(isLiveHolderConflict(new Error("nope"))).toBe(false);
  expect(isLiveHolderConflict(undefined)).toBe(false);
});
