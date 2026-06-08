import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { startBroker } from "../broker.ts";
import { createClient, isPreCommitBrokerUnavailable } from "../shared/broker-client.ts";

const handles: ReturnType<typeof startBroker>[] = [];
const cleanupPaths: string[] = [];

function tmpPath(name: string): string {
  const path = `/tmp/agent-peers-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  cleanupPaths.push(path);
  return path;
}

function track(handle: ReturnType<typeof startBroker>): ReturnType<typeof startBroker> {
  handles.push(handle);
  return handle;
}

function stop(handle: ReturnType<typeof startBroker>): void {
  clearInterval(handle.gcTimer);
  handle.server.stop(true);
  handle.db.close();
  const idx = handles.indexOf(handle);
  if (idx >= 0) handles.splice(idx, 1);
}

async function seedPeers(port: number, secret: string) {
  const client = createClient(`http://127.0.0.1:${port}`, secret);
  const sender = await client.register({
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", name: "sender",
  });
  const receiver = await client.register({
    peer_type: "codex", pid: 2, cwd: "/x", git_root: null, tty: null, summary: "", name: "receiver",
  });
  return { client, sender, receiver };
}

afterEach(() => {
  for (const handle of [...handles]) stop(handle);
  for (const path of cleanupPaths.splice(0)) {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(p)) unlinkSync(p);
    }
  }
});

test("send retries connection-refused restart window and lands exactly once", async () => {
  const db = tmpPath("restart-window.db");
  const secretPath = tmpPath("restart-window.secret");
  const first = track(startBroker(0, db, secretPath));
  const port = first.server.port!;
  const secret = readFileSync(secretPath, "utf8").trim();
  const { sender, receiver } = await seedPeers(port, secret);
  stop(first);

  const client = createClient(`http://127.0.0.1:${port}`, secret, {
    sendRetry: { attempts: 6, delaysMs: [10, 20, 30, 40, 50], requestTimeoutMs: 500 },
  });
  const send = client.sendMessage({
    from_id: sender.id, session_token: sender.session_token, to_id_or_name: "receiver", text: "during-restart",
  });

  await new Promise((resolve) => setTimeout(resolve, 35));
  track(startBroker(port, db, secretPath));

  const sent = await send;
  expect(sent.ok).toBe(true);

  const after = createClient(`http://127.0.0.1:${port}`, secret);
  const polled = await after.pollMessages({ id: receiver.id, session_token: receiver.session_token });
  expect(polled.map((m) => m.text)).toEqual(["during-restart"]);
});

test("send fails visibly when connection-refused retry cap is exceeded", async () => {
  const client = createClient(`http://127.0.0.1:9`, "irrelevant", {
    sendRetry: { attempts: 2, delaysMs: [1], requestTimeoutMs: 100 },
  });
  await expect(client.sendMessage({
    from_id: "a", session_token: "s", to_id_or_name: "b", text: "lost",
  })).rejects.toThrow(/broker unavailable before send commit/i);
});

test("send does not retry ambiguous post-connect timeout", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return new Response(JSON.stringify({ ok: true, message_id: 1, to_id: "b" }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  try {
    const client = createClient(`http://127.0.0.1:${server.port!}`, "irrelevant", {
      sendRetry: { attempts: 5, delaysMs: [1, 1, 1, 1], requestTimeoutMs: 20 },
    });
    await expect(client.sendMessage({
      from_id: "a", session_token: "s", to_id_or_name: "b", text: "maybe-committed",
    })).rejects.toThrow(/delivery uncertain/i);
    expect(requests).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("send does not retry ECONNRESET because it may be post-send ambiguous", async () => {
  let requests = 0;
  const reset = new Error("socket hang up") as Error & { code: string };
  reset.code = "ECONNRESET";
  const client = createClient("http://127.0.0.1:7900", "irrelevant", {
    sendRetry: { attempts: 5, delaysMs: [1, 1, 1, 1], requestTimeoutMs: 100 },
    fetchImpl: async () => {
      requests += 1;
      throw reset;
    },
  });

  await expect(client.sendMessage({
    from_id: "a", session_token: "s", to_id_or_name: "b", text: "maybe-committed",
  })).rejects.toThrow(/delivery uncertain/i);
  expect(requests).toBe(1);
});

test("classifier retries only connect-phase ETIMEDOUT, not generic timeout", () => {
  expect(isPreCommitBrokerUnavailable(Object.assign(new Error("connect timed out"), {
    code: "ETIMEDOUT",
    syscall: "connect",
  }))).toBe(true);
  expect(isPreCommitBrokerUnavailable(Object.assign(new Error("read timed out"), {
    code: "ETIMEDOUT",
  }))).toBe(false);
});
