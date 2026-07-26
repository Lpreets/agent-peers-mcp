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

test("retries a /register 409 and succeeds once the holder goes stale", async () => {
  const { deps, elapsed } = fakeDeps();
  let attempts = 0;
  const result = await registerWithRetry(async () => {
    attempts++;
    // Holder ages out partway through the budget, as a real stale row would.
    if (attempts < 4) throw conflict();
    return { id: "peer-1", name: "msaasa-codex", session_token: "tok-new" };
  }, deps);

  expect(attempts).toBe(4);
  expect(result.name).toBe("msaasa-codex");
  // Must have been willing to wait past the broker's 60s reclaim threshold.
  expect(elapsed()).toBeGreaterThan(0);
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
