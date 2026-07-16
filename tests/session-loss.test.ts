import { expect, test } from "bun:test";
import { BrokerHttpError } from "../shared/broker-client.ts";
import { createAuthLostHandler } from "../shared/session-loss.ts";

test("typed HTTP 401 emits one structured AUTH_LOST event and exits locally", () => {
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const authLost = createAuthLostHandler({
    component: "codex",
    writeStderr: (line) => stderr.push(line),
    exit: (code) => { exitCodes.push(code); },
  });

  expect(authLost.exitIfSessionExpired(
    "poll",
    new BrokerHttpError("/poll-messages", 401),
  )).toBe(true);
  expect(authLost.isLost()).toBe(true);
  expect(exitCodes).toEqual([1]);
  expect(stderr).toHaveLength(1);
  expect(JSON.parse(stderr[0]!)).toEqual({
    event: "AUTH_LOST",
    component: "codex",
    operation: "poll",
    reason: "session_expired",
  });

  // A concurrent heartbeat failure must not emit or exit a second time.
  expect(authLost.exitIfSessionExpired(
    "heartbeat",
    new BrokerHttpError("/heartbeat", 401),
  )).toBe(true);
  expect(stderr).toHaveLength(1);
  expect(exitCodes).toEqual([1]);
});

test("non-401 transport failures do not trip AUTH_LOST", () => {
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const authLost = createAuthLostHandler({
    component: "claude",
    writeStderr: (line) => stderr.push(line),
    exit: (code) => { exitCodes.push(code); },
  });

  expect(authLost.exitIfSessionExpired(
    "summary",
    new BrokerHttpError("/set-summary", 503),
  )).toBe(false);
  expect(authLost.isLost()).toBe(false);
  expect(stderr).toEqual([]);
  expect(exitCodes).toEqual([]);
});

test("unauthorized send response trips the same structured AUTH_LOST path", () => {
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const authLost = createAuthLostHandler({
    component: "claude",
    writeStderr: (line) => stderr.push(line),
    exit: (code) => { exitCodes.push(code); },
  });

  expect(authLost.exitIfUnauthorizedSend({
    ok: false,
    error: "unauthorized sender: peer-id-without-a-token",
  })).toBe(true);
  expect(exitCodes).toEqual([1]);
  expect(JSON.parse(stderr[0]!)).toEqual({
    event: "AUTH_LOST",
    component: "claude",
    operation: "send_message",
    reason: "unauthorized_sender",
  });
  expect(stderr[0]).not.toContain("peer-id-without-a-token");
});

test("ordinary send failures do not masquerade as local auth loss", () => {
  const authLost = createAuthLostHandler({
    component: "codex",
    writeStderr: () => { throw new Error("must not write"); },
    exit: () => { throw new Error("must not exit"); },
  });

  expect(authLost.exitIfUnauthorizedSend({ ok: false, error: "unknown peer: nobody" })).toBe(false);
  expect(authLost.exitIfUnauthorizedSend({ ok: true, message_id: 1 })).toBe(false);
});
