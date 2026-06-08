// End-to-end test: real broker process serving a real HTTP client.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker } from "../broker.ts";
import { createClient } from "../shared/broker-client.ts";
import { chmodSync, readFileSync, unlinkSync, existsSync, writeFileSync } from "node:fs";

const TEST_DB = "/tmp/agent-peers-e2e-" + Date.now() + ".db";
const TEST_SECRET = "/tmp/agent-peers-e2e-secret-" + Date.now();
const TEST_PORT = 7911;
let handle: ReturnType<typeof startBroker>;
let testSecret: string;
let previousWakeMode: string | undefined;

beforeAll(() => {
  previousWakeMode = process.env.AGENT_PEERS_WAKE_MODE;
  process.env.AGENT_PEERS_WAKE_MODE = "log-only";
  handle = startBroker(TEST_PORT, TEST_DB, TEST_SECRET);
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
