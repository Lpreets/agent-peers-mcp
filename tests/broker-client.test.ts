// End-to-end test: real broker process serving a real HTTP client.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker } from "../broker.ts";
import {
  BrokerHttpError,
  createClient,
  isSessionExpiredError,
} from "../shared/broker-client.ts";
import { chmodSync, readFileSync, unlinkSync, existsSync, writeFileSync } from "node:fs";

const TEST_DB = "/tmp/agent-peers-e2e-" + Date.now() + ".db";
const TEST_SECRET = "/tmp/agent-peers-e2e-secret-" + Date.now();
let TEST_PORT = 0;
let handle: ReturnType<typeof startBroker>;
let testSecret: string;
let previousWakeMode: string | undefined;

beforeAll(() => {
  previousWakeMode = process.env.AGENT_PEERS_WAKE_MODE;
  process.env.AGENT_PEERS_WAKE_MODE = "log-only";
  handle = startBroker(TEST_PORT, TEST_DB, TEST_SECRET);
  TEST_PORT = handle.server.port;
  testSecret = readFileSync(TEST_SECRET, "utf8").trim();
});
afterAll(() => {
  clearInterval(handle.gcTimer);
  handle.server.stop(true);
  handle.db.close();
  for (const p of [TEST_DB, TEST_SECRET]) if (existsSync(p)) unlinkSync(p);
  if (previousWakeMode === undefined) {
    delete process.env.AGENT_PEERS_WAKE_MODE;
  } else {
    process.env.AGENT_PEERS_WAKE_MODE = previousWakeMode;
  }
});

test("broker-client end-to-end: register → send → poll → ack", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);

  const a = await client.register({
    peer_type: "claude", pid: 10, cwd: "/a", git_root: null, tty: null, summary: "",
    name: "alpha",
  });
  const b = await client.register({
    peer_type: "codex", pid: 11, cwd: "/a", git_root: null, tty: null, summary: "",
    name: "beta",
  });
  expect(a.name).toBe("alpha");
  expect(b.name).toBe("beta");
  expect(a.session_token).toBeTruthy();

  const sent = await client.sendMessage({
    from_id: a.id, session_token: a.session_token, to_id_or_name: "beta", text: "hi",
  });
  expect(sent.ok).toBe(true);

  const polled = await client.pollMessages({ id: b.id, session_token: b.session_token });
  expect(polled.length).toBe(1);
  expect(polled[0]!.from_name).toBe("alpha");

  const acked = await client.ackMessages({
    id: b.id, session_token: b.session_token,
    lease_tokens: polled.map((m) => m.lease_token),
  });
  expect(acked.acked).toBe(1);
});

test("same-TTY collision expires the old holder and preserves the new holder", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);
  const recipient = await client.register({
    peer_type: "claude", host: "lpreet-pco", pid: 40, cwd: "/collision-recipient",
    git_root: null, tty: "/dev/pts/p0-recipient", summary: "", name: "collision-recipient",
  });
  const oldHolder = await client.register({
    peer_type: "codex", host: "lpreet-pco", pid: 41, cwd: "/collision",
    git_root: null, tty: "/dev/pts/p0-collision", summary: "", name: "collision-holder",
  });
  const newHolder = await client.register({
    peer_type: "codex", host: "lpreet-pco", pid: 42, cwd: "/collision",
    git_root: null, tty: "/dev/pts/p0-collision", summary: "replacement",
    name: "ignored-on-physical-session-replacement",
  });

  expect(newHolder.id).toBe(oldHolder.id);
  expect(newHolder.name).toBe(oldHolder.name);
  expect(newHolder.session_token).not.toBe(oldHolder.session_token);

  const expectExpired = async (promise: Promise<unknown>, path: string) => {
    try {
      await promise;
      throw new Error(`expected ${path} to reject`);
    } catch (error) {
      expect(error).toBeInstanceOf(BrokerHttpError);
      expect(isSessionExpiredError(error)).toBe(true);
      expect((error as BrokerHttpError).path).toBe(path);
      expect((error as Error).message).not.toContain(oldHolder.session_token);
    }
  };

  await expectExpired(
    client.pollMessages({ id: oldHolder.id, session_token: oldHolder.session_token }),
    "/poll-messages",
  );
  await expectExpired(
    client.heartbeat({ id: oldHolder.id, session_token: oldHolder.session_token }),
    "/heartbeat",
  );
  await expectExpired(
    client.setSummary({ id: oldHolder.id, session_token: oldHolder.session_token, summary: "stale" }),
    "/set-summary",
  );
  await expectExpired(
    client.unregister({ id: oldHolder.id, session_token: oldHolder.session_token }),
    "/unregister",
  );

  const staleSend = await client.sendMessage({
    from_id: oldHolder.id,
    session_token: oldHolder.session_token,
    to_id_or_name: recipient.id,
    text: "must not land",
  });
  expect(staleSend.ok).toBe(false);
  expect(staleSend.error).toMatch(/^unauthorized sender:/);
  expect(staleSend.error).not.toContain(oldHolder.session_token);
  expect(staleSend.error).not.toContain("must not land");

  const machinePeers = await client.listPeers({
    scope: "machine", cwd: "/any", git_root: null, peer_type: "codex",
  });
  const collisionProjection = machinePeers.find((peer) => peer.id === newHolder.id);
  expect(collisionProjection).toBeDefined();
  expect(collisionProjection?.id).toBe(newHolder.id);
  expect(collisionProjection?.name).toBe(oldHolder.name);
  expect(machinePeers.filter((peer) => peer.id === newHolder.id)).toHaveLength(1);
  expect(Object.prototype.hasOwnProperty.call(collisionProjection!, "session_token")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(collisionProjection!, "reclaim_token")).toBe(false);

  await client.heartbeat({ id: newHolder.id, session_token: newHolder.session_token });
  await client.setSummary({
    id: newHolder.id, session_token: newHolder.session_token, summary: "new holder active",
  });
  const outbound = await client.sendMessage({
    from_id: newHolder.id,
    session_token: newHolder.session_token,
    to_id_or_name: recipient.id,
    text: "new holder outbound",
  });
  expect(outbound.ok).toBe(true);

  const inbound = await client.sendMessage({
    from_id: recipient.id,
    session_token: recipient.session_token,
    to_id_or_name: newHolder.id,
    text: "new holder inbox",
  });
  expect(inbound.ok).toBe(true);
  const newInbox = await client.pollMessages({
    id: newHolder.id, session_token: newHolder.session_token,
  });
  expect(newInbox.map((message) => message.text)).toContain("new holder inbox");
});

test("broker-client polls and acks host intents via shared-secret endpoints", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);

  const sender = await client.register({
    peer_type: "claude", host: "lpreet-pco", pid: 30, cwd: "/r", git_root: null, tty: null, summary: "",
    name: "intent-sender",
  });
  await client.register({
    peer_type: "codex", host: "lpreet-pc", pid: 31, cwd: "/r", git_root: null, tty: "pts/31", summary: "",
    name: "intent-target",
  });

  const sent = await client.sendMessage({
    from_id: sender.id, session_token: sender.session_token, to_id_or_name: "intent-target", text: "remote wake me",
  });
  expect(sent.ok).toBe(true);

  let intents = await client.pollHostIntents({ host_id: "lpreet-pc" });
  for (let i = 0; intents.length === 0 && i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    intents = await client.pollHostIntents({ host_id: "lpreet-pc" });
  }
  expect(intents).toHaveLength(1);
  expect(intents[0]!.type).toBe("wake");
  expect(intents[0]!.target_name).toBe("intent-target");
  expect(intents[0]!.lease_token).toBeTruthy();

  const acked = await client.ackHostIntent({
    id: intents[0]!.id,
    lease_token: intents[0]!.lease_token!,
    status: "done",
    result: "would_wake",
    idle_proof: "client test",
  });
  expect(acked.acked).toBe(1);
});

test("broker-client self-rename with peer session token", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);

  const p = await client.register({
    peer_type: "claude", pid: 20, cwd: "/r", git_root: null, tty: null, summary: "",
    name: "renamer",
  });
  const r = await client.renamePeer({
    id: p.id, session_token: p.session_token, new_name: "renamed",
  });
  expect(r.ok).toBe(true);
  expect(r.name).toBe("renamed");
});

test("broker-client rejects peer-rename with wrong token (auth)", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);

  const p = await client.register({
    peer_type: "claude", pid: 22, cwd: "/r", git_root: null, tty: null, summary: "",
    name: "locked",
  });
  const r = await client.renamePeer({
    id: p.id, session_token: "wrong-token", new_name: "hacked",
  });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/unauthorized/i);
});

test("broker-client isAlive returns true for live broker, false for wrong port", async () => {
  const live = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);
  const dead = createClient(`http://127.0.0.1:9999`, testSecret);
  expect(await live.isAlive()).toBe(true);
  expect(await dead.isAlive()).toBe(false);
});

test("broker rejects HTTP requests without the shared-secret header (auth regression)", async () => {
  // Codex round-C: mere localhost binding is NOT a trust boundary on
  // shared/multi-user hosts. Broker must require the X-Agent-Peers-Secret
  // header (from ~/.agent-peers-secret with mode 0600) on every non-/health
  // request. Verify a 401-class rejection when the header is wrong.
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "machine", cwd: "/any", git_root: null }),
  });
  expect(res.status).toBe(401);
});

test("broker refuses non-loopback bind without an existing secret", () => {
  const db = "/tmp/agent-peers-nonloopback-no-secret-" + Date.now() + ".db";
  const secret = "/tmp/agent-peers-nonloopback-no-secret-" + Date.now();
  expect(() => startBroker(0, db, secret, "0.0.0.0")).toThrow(/refusing non-loopback bind/);
  for (const p of [db, secret]) if (existsSync(p)) unlinkSync(p);
});

test("broker refuses non-loopback bind with an insecure secret before opening DB", () => {
  const db = "/tmp/agent-peers-nonloopback-bad-secret-" + Date.now() + ".db";
  const secret = "/tmp/agent-peers-nonloopback-bad-secret-" + Date.now();
  writeFileSync(secret, "x".repeat(64), { mode: 0o644 });
  chmodSync(secret, 0o644);
  expect(() => startBroker(0, db, secret, "0.0.0.0")).toThrow(/mode 644/);
  expect(existsSync(db)).toBe(false);
  for (const p of [db, secret]) if (existsSync(p)) unlinkSync(p);
});

test("broker non-loopback health omits pid details", async () => {
  const db = "/tmp/agent-peers-nonloopback-health-" + Date.now() + ".db";
  const secret = "/tmp/agent-peers-nonloopback-health-secret-" + Date.now();
  const local = startBroker(0, db, secret, "127.0.0.1");
  try {
    const url = `http://127.0.0.1:${local.server.port}/health`;
    const body = await (await fetch(url)).json() as { ok: boolean; pid?: number };
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);
  } finally {
    clearInterval(local.gcTimer);
    local.server.stop(true);
    local.db.close();
  }

  const nonLoopback = startBroker(0, db, secret, "0.0.0.0");
  try {
    const url = `http://127.0.0.1:${nonLoopback.server.port}/health`;
    const body = await (await fetch(url)).json() as { ok: boolean; pid?: number };
    expect(body).toEqual({ ok: true });
  } finally {
    clearInterval(nonLoopback.gcTimer);
    nonLoopback.server.stop(true);
    nonLoopback.db.close();
    for (const p of [db, secret]) if (existsSync(p)) unlinkSync(p);
  }
});
