// End-to-end test: real broker process serving a real HTTP client.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker } from "../broker.ts";
import {
  BrokerHttpError,
  SECRET_HEADER,
  createClient,
  isPreCommitBrokerUnavailable,
  isSessionExpiredError,
} from "../shared/broker-client.ts";
import { chmodSync, readFileSync, unlinkSync, existsSync, writeFileSync } from "node:fs";

const TEST_DB = "/tmp/agent-peers-e2e-" + Date.now() + ".db";
const TEST_SECRET = "/tmp/agent-peers-e2e-secret-" + Date.now();
let TEST_PORT = 0;
let handle: ReturnType<typeof startBroker>;
let testSecret: string;
let previousWakeMode: string | undefined;

const HOST_NAMESPACE_HEADER = "X-Agent-Host-Namespace";
const HOST_ATTESTATION_HEADER = "X-Agent-Host-Attestation";
const HOST_NONCE_HEADER = "X-Agent-Host-Nonce";
const HOST_TIMESTAMP_HEADER = "X-Agent-Host-Timestamp";

type TypedHttpResponse = {
  status: number;
  code: string | null;
  error: string;
};

async function readTypedHttpResponse(res: Response): Promise<TypedHttpResponse> {
  const raw = await res.text();
  try {
    const parsed = JSON.parse(raw) as { error?: string; code?: string };
    return {
      status: res.status,
      code: typeof parsed.code === "string" ? parsed.code : null,
      error: typeof parsed.error === "string" ? parsed.error : raw,
    };
  } catch {
    return { status: res.status, code: null, error: raw };
  }
}

async function postRegisterWithAttestation(params: {
  namespace: string;
  attestation: string;
  nonce: string;
  timestamp: string;
  host?: string;
  bodyNamespaceOverride?: string;
}): Promise<Response> {
  return fetch(`http://127.0.0.1:${TEST_PORT}/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SECRET_HEADER]: testSecret,
      [HOST_NAMESPACE_HEADER]: params.namespace,
      [HOST_ATTESTATION_HEADER]: params.attestation,
      [HOST_NONCE_HEADER]: params.nonce,
      [HOST_TIMESTAMP_HEADER]: params.timestamp,
    },
    body: JSON.stringify({
      peer_type: "claude",
      host: params.host ?? "lpreet-pco",
      pid: 88,
      cwd: "/host-attest",
      git_root: null,
      tty: null,
      summary: "attestation",
      name: `host-attest-${params.nonce}`,
      ...(params.bodyNamespaceOverride === undefined
        ? {}
        : {
            authenticated_host_namespace: params.bodyNamespaceOverride,
            host_auth_method: "json-override-must-not-win",
          }),
    }),
  });
}

async function postPeerQueue(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${TEST_PORT}/peer/queue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SECRET_HEADER]: testSecret,
    },
    body: JSON.stringify(body),
  });
}

function tableRowCount(table: "peers" | "messages" | "identity_transitions"): number | null {
  const exists = handle.db.query<{ present: number }, [string]>(
    "SELECT COUNT(*) AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table)?.present ?? 0;
  if (exists === 0) return null;
  return handle.db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM ${table}`
  ).get()!.count;
}

function safePeerSnapshot(peerId: string): Record<string, unknown> | null {
  const safeColumns = [
    "id",
    "name",
    "peer_type",
    "host",
    "pid",
    "cwd",
    "git_root",
    "tty",
    "summary",
    "registered_at",
    "last_seen",
    "stable_identity_key",
    "authenticated_host_namespace",
    "host_auth_method",
    "identity_epoch",
    "identity_state",
    "lease_generation",
    "broker_epoch",
    "lease_last_seen_mono_ns",
    "lease_expires_mono_ns",
    "lease_consecutive_misses",
    "last_auth_method",
    "sender_registry_state",
  ];
  const available = new Set(handle.db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('peers')"
  ).all().map(({ name }) => name));
  const projection = safeColumns.filter((name) => available.has(name));
  return handle.db.query<Record<string, unknown>, [string]>(
    `SELECT ${projection.join(", ")} FROM peers WHERE id = ?`
  ).get(peerId) ?? null;
}

function brokerMutationSnapshot(peerId: string) {
  return {
    peer: safePeerSnapshot(peerId),
    messages: tableRowCount("messages"),
    identityTransitions: tableRowCount("identity_transitions"),
  };
}

type CapturedOutcome<T> =
  | { kind: "result"; value: T }
  | { kind: "error"; error: unknown };

async function captureOutcome<T>(run: () => Promise<T>): Promise<CapturedOutcome<T>> {
  try {
    return { kind: "result", value: await run() };
  } catch (error) {
    return { kind: "error", error };
  }
}

beforeAll(() => {
  previousWakeMode = process.env.AGENT_PEERS_WAKE_MODE;
  process.env.AGENT_PEERS_WAKE_MODE = "log-only";
  handle = startBroker(TEST_PORT, TEST_DB, TEST_SECRET);
  if (handle.server.port === undefined) throw new Error("test broker did not bind a port");
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

test("broker-client blocks JSON namespace override mismatches at the raw host-attestation boundary", async () => {
  const beforePeerCount = tableRowCount("peers");
  const bad = await postRegisterWithAttestation({
    namespace: "tenant-a",
    host: "tenant-a",
    attestation: "bogus",
    nonce: `ns-mismatch-${Math.random().toString(36).slice(2)}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    bodyNamespaceOverride: "tenant-b",
  });
  const observed = await readTypedHttpResponse(bad);
  expect({
    status: observed.status,
    code: observed.code,
    peerCountDelta: (tableRowCount("peers") ?? 0) - (beforePeerCount ?? 0),
  }).toEqual({
    status: 401,
    code: "IDENTITY_HOST_NAMESPACE_MISMATCH",
    peerCountDelta: 0,
  });
});

test("PARTIAL boundary rejection: duplicate bogus host attestations never enroll; valid replay awaits Stage-B verifier injection", async () => {
  const nonce = `replay-${Math.random().toString(36).slice(2)}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const beforePeerCount = tableRowCount("peers");
  const first = await postRegisterWithAttestation({
    namespace: "tenant-a",
    attestation: "bogus",
    nonce,
    timestamp,
  });
  const second = await postRegisterWithAttestation({
    namespace: "tenant-a",
    attestation: "bogus",
    nonce,
    timestamp,
  });
  const [firstObserved, secondObserved] = await Promise.all([
    readTypedHttpResponse(first),
    readTypedHttpResponse(second),
  ]);

  // A bogus signature can only prove rejection. A genuine first acceptance
  // followed by IDENTITY_HOST_ATTESTATION_REPLAY remains PARTIAL until Stage B
  // ratifies and injects a mock verifier; this test never derives an HMAC from
  // the unrelated broker shared secret.
  expect({
    first: { status: firstObserved.status, code: firstObserved.code },
    second: { status: secondObserved.status, code: secondObserved.code },
    peerCountDelta: (tableRowCount("peers") ?? 0) - (beforePeerCount ?? 0),
  }).toEqual({
    first: { status: 401, code: "IDENTITY_HOST_ATTESTATION_INVALID" },
    second: { status: 401, code: "IDENTITY_HOST_ATTESTATION_INVALID" },
    peerCountDelta: 0,
  });
});

test("broker-client rejects host-attestation requests outside timestamp skew window", async () => {
  const oldTs = String(Math.floor((Date.now() - 60 * 60 * 1000) / 1000));
  const beforePeerCount = tableRowCount("peers");
  const res = await postRegisterWithAttestation({
    namespace: "tenant-a",
    attestation: "bogus",
    nonce: `skew-${Math.random().toString(36).slice(2)}`,
    timestamp: oldTs,
  });
  const observed = await readTypedHttpResponse(res);
  expect({
    status: observed.status,
    code: observed.code,
    peerCountDelta: (tableRowCount("peers") ?? 0) - (beforePeerCount ?? 0),
  }).toEqual({
    status: 401,
    code: "IDENTITY_HOST_ATTESTATION_TIME_SKEW",
    peerCountDelta: 0,
  });
});

test("release-seat requires explicit lease auth, not default session auth", async () => {
  const reg = await createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret).register({
    peer_type: "claude",
    pid: 90,
    cwd: "/release-seat",
    git_root: null,
    tty: null,
    summary: "",
    name: "release-seat-holder",
  });

  const payload = { id: reg.id, session_token: reg.session_token };
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/release-seat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SECRET_HEADER]: testSecret,
    },
    body: JSON.stringify(payload),
  });
  const observed = await readTypedHttpResponse(res);
  expect({ status: observed.status, code: observed.code }).toEqual({
    status: 401,
    code: "IDENTITY_CREDENTIAL_REQUIRED",
  });
});

test("fresh enrollment stores only salted verifier material, never plaintext reclaim credential", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);
  const reg = await client.register({
    peer_type: "codex",
    pid: 93,
    cwd: "/credential-storage",
    git_root: null,
    tty: null,
    summary: "",
    name: "credential-storage",
  });

  const columns = handle.db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('peers')"
  ).all().map((row) => row.name);
  expect(columns).toContain("credential_salt");
  expect(columns).toContain("credential_verifier");
  expect(columns).not.toContain("reclaim_credential");

  const stored = handle.db.query<{
    credential_salt: string | null;
    credential_verifier: string | null;
  }, [string]>(
    "SELECT credential_salt, credential_verifier FROM peers WHERE id = ?"
  ).get(reg.id);
  expect(stored?.credential_salt).toBeTruthy();
  expect(stored?.credential_verifier).toBeTruthy();
  expect(JSON.stringify(stored)).not.toContain(reg.session_token);
});

test("C10 RED: proven pre-connect ECONNREFUSED queues locally but is never reported accepted", async () => {
  const preConnect = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
    code: "ECONNREFUSED",
    syscall: "connect",
  });
  expect(isPreCommitBrokerUnavailable(preConnect)).toBe(true);

  let fetchAttempts = 0;
  const sendClient = createClient("http://127.0.0.1:1", testSecret, {
    sendRetry: { attempts: 1, delaysMs: [0], requestTimeoutMs: 20 },
    fetchImpl: async () => {
      fetchAttempts += 1;
      throw preConnect;
    },
  });
  const outcome = await captureOutcome(() => sendClient.sendMessage({
    from_id: "pre-connect-sender",
    session_token: "pre-connect-session",
    to_id_or_name: "pre-connect-target",
    text: "must be queued without acceptance",
  }));
  const normalized = outcome.kind === "result"
    ? {
        kind: outcome.kind,
        queued: (outcome.value as unknown as { queued?: unknown }).queued ?? null,
        accepted: (outcome.value as unknown as { accepted?: unknown }).accepted ?? null,
        code: (outcome.value as unknown as { code?: unknown }).code ?? null,
      }
    : {
        kind: outcome.kind,
        queued: null,
        accepted: null,
        code: (outcome.error as { code?: unknown } | null)?.code ?? null,
      };

  expect(fetchAttempts).toBe(1);
  expect(normalized).toEqual({
    kind: "result",
    queued: true,
    accepted: false,
    code: "BROKER_UNAVAILABLE_QUEUED_NOT_ACCEPTED",
  });
});

test.todo(
  "PARTIAL C10: owner-local queue artifact creation awaits the Stage-B local-outbox seam",
  () => {}
);

test("ambiguous post-connect send failure is never queued or retried", async () => {
  const bootstrap = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);
  const sender = await bootstrap.register({
    peer_type: "claude",
    pid: 91,
    cwd: "/send-queue",
    git_root: null,
    tty: null,
    summary: "",
    name: "queue-sender",
  });
  await bootstrap.register({
    peer_type: "codex",
    pid: 92,
    cwd: "/send-queue",
    git_root: null,
    tty: null,
    summary: "",
    name: "queue-target",
  });

  let fetchAttempts = 0;
  const sendClient = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret, {
    sendRetry: { attempts: 4, delaysMs: [1], requestTimeoutMs: 20 },
    fetchImpl: async () => {
      fetchAttempts += 1;
      const e = new Error("ambiguous broker send path") as Error & { code: string };
      e.code = "ECONNRESET";
      throw e;
    },
  });

  const outcome = await captureOutcome(() => sendClient.sendMessage({
    from_id: sender.id,
    session_token: sender.session_token,
    to_id_or_name: "queue-target",
    text: "ambiguous path should not queue",
  }));
  expect(fetchAttempts).toBe(1);
  expect(outcome.kind).toBe("error");
  const error = outcome.kind === "error" ? outcome.error : null;
  expect(error).toBeInstanceOf(Error);
  expect((error as { queued?: unknown } | null)?.queued).not.toBe(true);
  expect((error as Error | null)?.message).toMatch(/delivery uncertain/i);
});

test("C10 RED: ambiguous post-connect send failure exposes the exact typed not-queued code", async () => {
  const sendClient = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret, {
    sendRetry: { attempts: 4, delaysMs: [1], requestTimeoutMs: 20 },
    fetchImpl: async () => {
      throw Object.assign(new Error("ambiguous broker send path"), {
        code: "ECONNRESET",
      });
    },
  });
  const outcome = await captureOutcome(() => sendClient.sendMessage({
    from_id: "ambiguous-sender",
    session_token: "ambiguous-session",
    to_id_or_name: "ambiguous-target",
    text: "typed ambiguous failure",
  }));
  expect(outcome.kind).toBe("error");
  const error = outcome.kind === "error" ? outcome.error : null;
  expect((error as { queued?: unknown } | null)?.queued).not.toBe(true);
  expect((error as { code?: unknown } | null)?.code).toBe(
    "BROKER_DELIVERY_UNCERTAIN_NOT_QUEUED"
  );
});

test("C17 RED: /peer/queue rejects a stale identity snapshot without replay or DB mutation", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);
  const suffix = Math.random().toString(36).slice(2);
  const sender = await client.register({
    peer_type: "claude",
    pid: 94,
    cwd: "/queue-stale",
    git_root: null,
    tty: null,
    summary: "",
    name: `queue-stale-sender-${suffix}`,
  });
  const target = await client.register({
    peer_type: "codex",
    pid: 95,
    cwd: "/queue-stale",
    git_root: null,
    tty: null,
    summary: "",
    name: `queue-stale-target-${suffix}`,
  });
  const before = brokerMutationSnapshot(sender.id);
  const res = await postPeerQueue({
    kind: "send_message",
    queued_at_mono_ns: process.hrtime.bigint().toString(),
    stable_identity_key: `stale-subject-${suffix}`,
    identity_epoch: 0,
    identity_state: "current",
    host_namespace: "stale-host-namespace",
    correlation: `queue-stale-${suffix}`,
    request: {
      from_id: sender.id,
      to_id_or_name: target.name,
      text: "stale queue entry must never replay",
    },
  });
  const observed = await readTypedHttpResponse(res);
  await new Promise((resolve) => setTimeout(resolve, 25));

  expect(brokerMutationSnapshot(sender.id)).toEqual(before);
  expect(res.ok).toBe(false);
  expect(observed.code).toBe("IDENTITY_QUEUE_REPLAY_STALE");
});

test("C17 RED: /peer/queue rejects entries older than 900s without replay or DB mutation", async () => {
  const client = createClient(`http://127.0.0.1:${TEST_PORT}`, testSecret);
  const suffix = Math.random().toString(36).slice(2);
  const sender = await client.register({
    peer_type: "claude",
    pid: 96,
    cwd: "/queue-expired",
    git_root: null,
    tty: null,
    summary: "",
    name: `queue-expired-sender-${suffix}`,
  });
  const target = await client.register({
    peer_type: "codex",
    pid: 97,
    cwd: "/queue-expired",
    git_root: null,
    tty: null,
    summary: "",
    name: `queue-expired-target-${suffix}`,
  });
  const before = brokerMutationSnapshot(sender.id);
  const queuedAt = process.hrtime.bigint() - 901n * 1_000_000_000n;
  const res = await postPeerQueue({
    kind: "send_message",
    queued_at_mono_ns: queuedAt.toString(),
    stable_identity_key: sender.id,
    identity_epoch: 0,
    identity_state: "current",
    host_namespace: "expired-host-namespace",
    correlation: `queue-expired-${suffix}`,
    request: {
      from_id: sender.id,
      to_id_or_name: target.name,
      text: "expired queue entry must never replay",
    },
  });
  const observed = await readTypedHttpResponse(res);
  await new Promise((resolve) => setTimeout(resolve, 25));

  expect(brokerMutationSnapshot(sender.id)).toEqual(before);
  expect(res.ok).toBe(false);
  expect(observed.code).toBe("IDENTITY_QUEUE_REPLAY_EXPIRED");
});
