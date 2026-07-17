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

test("AUTH_LOST event is schema-stable and contains no path/body context", () => {
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const authLost = createAuthLostHandler({
    component: "codex",
    writeStderr: (line) => stderr.push(line),
    exit: (code) => { exitCodes.push(code); },
  });

  authLost.exitIfSessionExpired(
    "heartbeat",
    new BrokerHttpError("/heartbeat?session_token=secret", 401),
  );

  expect(exitCodes).toEqual([1]);
  const payload = JSON.parse(stderr[0]!) as Record<string, unknown>;
  expect(payload).toEqual({
    event: "AUTH_LOST",
    component: "codex",
    operation: "heartbeat",
    reason: "session_expired",
  });
  expect(stderr[0]).not.toContain("secret");
  expect(stderr[0]).not.toContain("/heartbeat");
  expect(Object.keys(payload)).toHaveLength(4);
});

test("AUTH_LOST output never includes credentials or request payload context", () => {
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const authLost = createAuthLostHandler({
    component: "codex",
    writeStderr: (line) => stderr.push(line),
    exit: (code) => { exitCodes.push(code); },
  });
  const suspiciousToken = "token-should-not-emit";
  const suspiciousMessage = "do-not-log-this-message-text";

  expect(authLost.exitIfUnauthorizedSend({
    ok: false,
    error: `unauthorized sender: ${suspiciousToken} ${suspiciousMessage}`,
  })).toBe(true);
  expect(authLost.isLost()).toBe(true);
  expect(exitCodes).toEqual([1]);
  const payload = JSON.parse(stderr[0]!) as {
    event: string;
    component: string;
    reason: string;
    operation: string;
  };
  expect(payload).toEqual({
    event: "AUTH_LOST",
    component: "codex",
    operation: "send_message",
    reason: "unauthorized_sender",
  });
  expect(JSON.stringify(payload)).not.toContain(suspiciousToken);
  expect(JSON.stringify(payload)).not.toContain(suspiciousMessage);
});

test("RED: typed old-epoch session-loss must still emit AUTH_LOST without credential/body leakage", () => {
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const authLost = createAuthLostHandler({
    component: "codex",
    writeStderr: (line) => stderr.push(line),
    exit: (code) => { exitCodes.push(code); },
  });
  const suspiciousToken = "typed-session-token-should-not-emit";
  const suspiciousBody = "FORBIDDEN_BODY_SNIPPET_ABC123";
  const typedOldEpochError = {
    status: 401,
    name: "BrokerSessionExpiredError",
    code: "SENDER_EPOCH_MISMATCH",
    peer_id: "peer-stale-e5f1",
    sender_epoch: 0,
    message: `stale sender epoch; epoch mismatch (token=${suspiciousToken})`,
    body: { error: suspiciousBody },
  } as any;

  expect(authLost.exitIfSessionExpired("summary", typedOldEpochError)).toBe(true);
  expect(authLost.isLost()).toBe(true);
  expect(exitCodes).toEqual([1]);
  const payload = JSON.parse(stderr[0]!) as Record<string, unknown>;

  expect(payload).toEqual({
    event: "AUTH_LOST",
    component: "codex",
    operation: "summary",
    reason: "session_expired",
  });
  const line = JSON.stringify(payload);
  expect(line).not.toContain(suspiciousToken);
  expect(line).not.toContain(suspiciousBody);
  expect(line).not.toContain("peer-stale-e5f1");
  expect(line).not.toContain("SENDER_EPOCH_MISMATCH");
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

test("non-matching send responses never trip AUTH_LOST", () => {
  const exitCodes: number[] = [];
  const authLost = createAuthLostHandler({
    component: "codex",
    writeStderr: () => { exitCodes.push(666); },
    exit: () => { exitCodes.push(1); },
  });

  expect(authLost.exitIfUnauthorizedSend({ ok: false, error: "temporary network error" })).toBe(false);
  expect(authLost.exitIfUnauthorizedSend({ ok: false, error: "unauthorized: not a sender" })).toBe(false);
  expect(authLost.isLost()).toBe(false);
  expect(exitCodes).toEqual([]);
});
