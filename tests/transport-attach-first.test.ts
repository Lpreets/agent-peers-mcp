// tests/transport-attach-first.test.ts
//
// S348 RED test — the MCP stdio transport must be attached BEFORE any broker
// work, so that a broker failure degrades the server instead of killing it.
//
// Incident: agent-peers went dark under Codex. Root-cause mechanism (proven in
// MSAASA research/working/s348-codex-0145-delta-evidence.md §6b/§6d):
// codex-server.ts does `ensureBroker` -> `waitForSharedSecret` -> `register`
// and only THEN `mcp.connect(new StdioServerTransport())`. Everything before
// that connect is a window in which `initialize` cannot be answered. A fatal in
// that window exits the process having written ZERO bytes to stdout, which the
// client reports as the uninformative
//   "connection closed: initialize response" / "Broken pipe ... when send initialize request"
// with no diagnostic anywhere (Codex swallows child stderr, and codex-cli
// 0.145.0 stopped persisting MCP traces).
//
// Codex receiver-verification (AMBER->approved) required six assertions rather
// than the single "answers initialize" check originally proposed: a naive fix
// could answer `initialize` and then let the background broker init reject and
// exit, which would FALSE-GREEN a one-assertion test.
//
// Fixture safety: the broker URL is an unreachable NON-LOOPBACK address, which
// puts ensure-broker in remote mode (auto-spawn disabled), plus a temp secret
// path. This test therefore cannot spawn or contact the live broker.

import { test, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
// Unreachable + non-loopback => remote mode => no local auto-spawn, no live broker.
const DEAD_BROKER_URL = "http://10.255.255.1:7900";
const TEST_SECRET = `/tmp/agent-peers-s348-red-secret-${Date.now()}`;

// Bound for a response that must be answered from the transport alone.
const RESPONSE_BOUND_MS = 5_000;
// The pre-connect broker failure resolves in ~2s; wait past it before probing liveness.
const BROKER_FAILURE_SETTLE_MS = 6_000;

let proc: ReturnType<typeof Bun.spawn> | null = null;

afterEach(() => {
  proc?.kill();
  proc = null;
  if (existsSync(TEST_SECRET)) unlinkSync(TEST_SECRET);
});

function startServer() {
  return Bun.spawn({
    cmd: ["bun", "codex-server.ts"],
    cwd: REPO,
    env: {
      ...process.env,
      AGENT_PEERS_ENABLED: "1",
      PEER_NAME: "s348-red-test",
      AGENT_PEERS_BROKER_URL: DEAD_BROKER_URL,
      AGENT_PEERS_SECRET_FILE: TEST_SECRET,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Line-delimited JSON-RPC reader with a hard bound. */
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
        // Either the stream closed (process died) or we hit the bound.
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

test("S348: transport is answerable even when the broker never becomes available", async () => {
  proc = startServer();
  const out = makeLineReader(proc.stdout as ReadableStream<Uint8Array>);

  // --- 1. initialize is answered within a short bound -----------------------
  // Fails on current main: the process dies inside the pre-connect window
  // having written zero bytes, so this read returns null.
  send(proc, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "s348-red-test", version: "0.0.1" },
    },
  });
  const initLine = await out.nextLine(RESPONSE_BOUND_MS);
  expect(initLine).not.toBeNull();
  const initRes = JSON.parse(initLine!);
  expect(initRes.result?.serverInfo?.name).toBe("agent-peers");

  send(proc, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  // --- 2. tools/list still returns the real catalog -------------------------
  send(proc, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listLine = await out.nextLine(RESPONSE_BOUND_MS);
  expect(listLine).not.toBeNull();
  const names = (JSON.parse(listLine!).result?.tools ?? []).map((t: any) => t.name).sort();
  expect(names).toEqual(
    ["check_messages", "list_peers", "rename_peer", "send_message", "set_summary"].sort(),
  );

  // --- 3. after broker init has definitively FAILED, we are still alive -----
  // This is the assertion that kills the false-green fix (answer initialize,
  // then let the background rejection exit the process).
  await Bun.sleep(BROKER_FAILURE_SETTLE_MS);
  expect(proc.killed).toBe(false);
  expect(proc.exitCode).toBeNull();

  // --- 4. a tool call returns a BOUNDED, TYPED broker-unavailable error -----
  // Must not hang, must not close stdio, must not be silently "ok".
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

  // --- 5. the transport is STILL healthy after that failure -----------------
  send(proc, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  const secondList = await out.nextLine(RESPONSE_BOUND_MS);
  expect(secondList).not.toBeNull();
  expect(JSON.parse(secondList!).id).toBe(4);

  // --- 6. fixture never touched the live broker ----------------------------
  // Structural: DEAD_BROKER_URL is non-loopback (remote mode => auto-spawn
  // disabled) and the secret path is a temp file. Asserted so a future edit
  // that points this at 127.0.0.1 fails loudly instead of silently going live.
  expect(DEAD_BROKER_URL.includes("127.0.0.1")).toBe(false);
  expect(DEAD_BROKER_URL.includes("localhost")).toBe(false);
  expect(TEST_SECRET.startsWith("/tmp/")).toBe(true);
}, 30_000);
