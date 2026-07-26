// tests/claude-transport-attach-first.test.ts
//
// S348 parity — the SAME contract as tests/transport-attach-first.test.ts, but
// for claude-server.ts.
//
// claude-server carried both S348 defects unfixed: mcp.connect() ran only after
// ensureBroker / waitForSharedSecret / register, and registration was one-shot
// with no bounded 409 retry. It never failed in the wild only because Claude
// Code's MCP client is more patient at startup than Codex's — luck, not
// immunity. If it had bitten, it would have taken out the Claude half of the
// transport with the same zero-diagnostic "connection closed" signature.
//
// Fixture isolation is deterministic by construction: we bind our OWN ephemeral
// loopback broker that always fails /health, and set AGENT_PEERS_REMOTE=1
// explicitly (broker-config.ts explicitRemote) so local auto-spawn is disabled
// regardless of host inference. It can never reach the live broker.

import { test, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const TEST_SECRET = `/tmp/agent-peers-s348-claude-secret-${Date.now()}`;

const RESPONSE_BOUND_MS = 5_000;
const BROKER_FAILURE_SETTLE_MS = 6_000;

let proc: ReturnType<typeof Bun.spawn> | null = null;
let fakeBroker: ReturnType<typeof Bun.serve> | null = null;
let healthHits = 0;

afterEach(() => {
  proc?.kill();
  proc = null;
  fakeBroker?.stop(true);
  fakeBroker = null;
  if (existsSync(TEST_SECRET)) unlinkSync(TEST_SECRET);
});

function startFakeFailingBroker() {
  healthHits = 0;
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      healthHits++;
      return new Response("broker down (S348 claude fixture)", { status: 503 });
    },
  });
}

function startServer(brokerUrl: string) {
  return Bun.spawn({
    cmd: ["bun", "claude-server.ts"],
    cwd: REPO,
    env: {
      ...process.env,
      AGENT_PEERS_ENABLED: "1",
      PEER_NAME: "s348-claude-parity-test",
      AGENT_PEERS_REMOTE: "1",
      AGENT_PEERS_BROKER_URL: brokerUrl,
      AGENT_PEERS_SECRET_FILE: TEST_SECRET,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function makeLineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const queue: string[] = [];

  async function nextLine(boundMs: number): Promise<string | null> {
    const deadline = Date.now() + boundMs;
    while (true) {
      if (queue.length) return queue.shift()!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (chunk.done || !chunk.value) {
        if (buf.trim()) { queue.push(buf.trim()); buf = ""; continue; }
        return null;
      }
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) queue.push(line);
      }
    }
  }
  return { nextLine };
}

function send(p: NonNullable<typeof proc>, msg: unknown) {
  p.stdin.write(JSON.stringify(msg) + "\n");
  p.stdin.flush();
}

test("S348 parity: claude-server answers initialize even when the broker never becomes available", async () => {
  fakeBroker = startFakeFailingBroker();
  const brokerUrl = `http://127.0.0.1:${fakeBroker.port}`;
  proc = startServer(brokerUrl);
  const out = makeLineReader(proc.stdout as ReadableStream<Uint8Array>);

  // --- 1. initialize answered within a short bound -------------------------
  send(proc, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "s348-claude-parity-test", version: "0.0.1" },
    },
  });
  const initLine = await out.nextLine(RESPONSE_BOUND_MS);
  expect(initLine).not.toBeNull();
  expect(JSON.parse(initLine!).result?.serverInfo?.name).toBe("agent-peers");

  send(proc, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  // --- 2. tools/list still returns the real catalog ------------------------
  send(proc, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listLine = await out.nextLine(RESPONSE_BOUND_MS);
  expect(listLine).not.toBeNull();
  const names = (JSON.parse(listLine!).result?.tools ?? []).map((t: any) => t.name);
  expect(names).toContain("check_messages");
  expect(names).toContain("send_message");

  // --- 3. still alive after broker init has definitively failed ------------
  // Kills the false-green fix that answers initialize then lets the background
  // rejection exit the process.
  await Bun.sleep(BROKER_FAILURE_SETTLE_MS);
  expect(proc.killed).toBe(false);
  expect(proc.exitCode).toBeNull();

  // --- 4. a tool call returns a BOUNDED, TYPED broker-unavailable error ----
  send(proc, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "check_messages", arguments: {} },
  });
  const callLine = await out.nextLine(RESPONSE_BOUND_MS);
  expect(callLine).not.toBeNull();
  const callRes = JSON.parse(callLine!);
  const callText = JSON.stringify(callRes).toLowerCase();
  expect(callRes.result?.isError ?? callRes.error != null).toBe(true);
  expect(callText).toContain("broker");
  expect(callText).toMatch(/unavailable|not ready|initializ/);

  // --- 5. transport STILL healthy after that failure -----------------------
  send(proc, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  const secondList = await out.nextLine(RESPONSE_BOUND_MS);
  expect(secondList).not.toBeNull();
  expect(JSON.parse(secondList!).id).toBe(4);

  // --- 6. fixture never touched the live broker ---------------------------
  expect(fakeBroker!.port).not.toBe(7900);
  expect(TEST_SECRET.startsWith("/tmp/")).toBe(true);
  // POSITIVE CONTROL: the health probe actually hit OUR fake, so the test
  // cannot pass because the server contacted nothing at all.
  expect(healthHits).toBeGreaterThan(0);
}, 30_000);
