// shared/broker-client.ts
// Typed HTTP wrapper around the broker. Used by both MCP servers and cli.ts.

import type {
  RegisterRequest, RegisterResponse, SetSummaryRequest, ListPeersRequest,
  SendMessageRequest, SendMessageResponse, AckMessagesRequest, AckMessagesResponse,
  RenamePeerRequest, RenamePeerResponse,
  HeartbeatRequest, UnregisterRequest, PollMessagesRequest,
  LeasedMessage, Peer, PollHostIntentsRequest, HostIntent, AckHostIntentRequest, AckHostIntentResponse,
} from "./types.ts";

export interface BrokerClient {
  isAlive(): Promise<boolean>;
  register(req: RegisterRequest): Promise<RegisterResponse>;
  heartbeat(req: HeartbeatRequest): Promise<void>;
  unregister(req: UnregisterRequest): Promise<void>;
  setSummary(req: SetSummaryRequest): Promise<void>;
  listPeers(req: ListPeersRequest): Promise<Peer[]>;
  sendMessage(req: SendMessageRequest): Promise<SendMessageResponse>;
  pollMessages(req: PollMessagesRequest): Promise<LeasedMessage[]>;
  ackMessages(req: AckMessagesRequest): Promise<AckMessagesResponse>;
  pollHostIntents(req: PollHostIntentsRequest): Promise<HostIntent[]>;
  ackHostIntent(req: AckHostIntentRequest): Promise<AckHostIntentResponse>;
  renamePeer(req: RenamePeerRequest): Promise<RenamePeerResponse>;
  // Note: there is no adminRenamePeer() in the client anymore. cli.ts reads
  // the target peer's session_token from SQLite directly and calls renamePeer
  // with it — see cli.ts cmdRename.
}

export const SECRET_HEADER = "X-Agent-Peers-Secret";

export interface SendRetryOptions {
  attempts?: number;
  delaysMs?: number[];
  requestTimeoutMs?: number;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BrokerClientOptions {
  sendRetry?: SendRetryOptions;
  fetchImpl?: FetchLike;
}

/** S348: per-attempt bound for /register (see the register() comment below). */
export const REGISTER_REQUEST_TIMEOUT_MS = 10_000;

export class BrokerHttpError extends Error {
  constructor(readonly path: string, readonly status: number) {
    super(`broker ${path}: HTTP ${status}`);
    this.name = "BrokerHttpError";
  }
}

export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof BrokerHttpError && error.status === 401;
}

const DEFAULT_SEND_RETRY: Required<SendRetryOptions> = {
  attempts: 8,
  delaysMs: [100, 150, 250, 400, 650, 900, 1200],
  requestTimeoutMs: 5000,
};

const PRE_COMMIT_ERROR_CODES = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryOptions(opts?: SendRetryOptions): Required<SendRetryOptions> {
  const envAttempts = parsePositiveInt(process.env.AGENT_PEERS_SEND_RETRY_ATTEMPTS);
  const envTimeout = parsePositiveInt(process.env.AGENT_PEERS_SEND_RETRY_TIMEOUT_MS);
  const envDelays = parseDelays(process.env.AGENT_PEERS_SEND_RETRY_DELAYS_MS);
  return {
    attempts: Math.max(1, opts?.attempts ?? envAttempts ?? DEFAULT_SEND_RETRY.attempts),
    delaysMs: opts?.delaysMs ?? envDelays ?? DEFAULT_SEND_RETRY.delaysMs,
    requestTimeoutMs: opts?.requestTimeoutMs ?? envTimeout ?? DEFAULT_SEND_RETRY.requestTimeoutMs,
  };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseDelays(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const delays = value.split(",")
    .map((part) => parseInt(part.trim(), 10))
    .filter((delay) => Number.isFinite(delay) && delay >= 0);
  return delays.length > 0 ? delays : undefined;
}

function errorCode(err: unknown): string | undefined {
  const direct = (err as { code?: unknown } | null)?.code;
  if (typeof direct === "string") return direct;
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

function errorSyscall(err: unknown): string | undefined {
  const direct = (err as { syscall?: unknown } | null)?.syscall;
  if (typeof direct === "string") return direct;
  const cause = (err as { cause?: { syscall?: unknown } } | null)?.cause;
  return typeof cause?.syscall === "string" ? cause.syscall : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isPreCommitBrokerUnavailable(err: unknown): boolean {
  const code = errorCode(err);
  if (!code) return false;
  if (PRE_COMMIT_ERROR_CODES.has(code)) return true;
  return code === "ETIMEDOUT" && errorSyscall(err) === "connect";
}

export function createClient(baseUrl: string, sharedSecret: string, options: BrokerClientOptions = {}): BrokerClient {
  const fetchFn = options.fetchImpl ?? fetch;

  async function postOnce<T>(path: string, body: unknown, requestTimeoutMs?: number): Promise<T> {
    const signal = requestTimeoutMs ? AbortSignal.timeout(requestTimeoutMs) : undefined;
    const res = await fetchFn(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SECRET_HEADER]: sharedSecret,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      // Drain the response for connection reuse, but do not embed broker text
      // in the exception. Callers need a typed status/path and must never
      // accidentally surface credentials or other response details.
      await res.text();
      throw new BrokerHttpError(path, res.status);
    }
    return res.json() as Promise<T>;
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    return postOnce<T>(path, body);
  }

  async function sendPost<T>(body: unknown): Promise<T> {
    const retry = retryOptions(options.sendRetry);
    let lastPreCommitError: unknown = null;
    for (let attempt = 1; attempt <= retry.attempts; attempt++) {
      try {
        return await postOnce<T>("/send-message", body, retry.requestTimeoutMs);
      } catch (err) {
        if (err instanceof BrokerHttpError) throw err;
        if (!isPreCommitBrokerUnavailable(err)) {
          throw new Error(
            `delivery uncertain: broker send failed after connection may have been established; ` +
            `not retrying to avoid duplicate send (${errorMessage(err)})`
          );
        }
        lastPreCommitError = err;
        if (attempt >= retry.attempts) break;
        const delay = retry.delaysMs[Math.min(attempt - 1, retry.delaysMs.length - 1)] ?? 0;
        if (delay > 0) await sleep(delay);
      }
    }
    throw new Error(
      `broker unavailable before send commit after ${retry.attempts} attempt(s): ${errorMessage(lastPreCommitError)}`
    );
  }

  return {
    async isAlive() {
      try {
        const res = await fetchFn(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
      } catch { return false; }
    },
    // S348: registration MUST be individually bounded. It is driven by
    // registerWithRetry under a 90s deadline, but a deadline around an
    // unbounded operation is decorative — one hung request would strand
    // readiness forever and never return control to the retry loop. The abort
    // surfaces as a TimeoutError, not a BrokerHttpError, so it is correctly
    // NOT retried by isLiveHolderConflict().
    register(req) {
      return postOnce<RegisterResponse>("/register", req, REGISTER_REQUEST_TIMEOUT_MS);
    },
    async heartbeat(req) { await post("/heartbeat", req); },
    async unregister(req) { await post("/unregister", req); },
    async setSummary(req) { await post("/set-summary", req); },
    listPeers(req) { return post<Peer[]>("/list-peers", req); },
    sendMessage(req) { return sendPost<SendMessageResponse>(req); },
    async pollMessages(req) {
      const { messages } = await post<{ messages: LeasedMessage[] }>("/poll-messages", req);
      return messages;
    },
    ackMessages(req) { return post<AckMessagesResponse>("/ack-messages", req); },
    async pollHostIntents(req) {
      const { intents } = await post<{ intents: HostIntent[] }>("/poll-intents", req);
      return intents;
    },
    ackHostIntent(req) { return post<AckHostIntentResponse>("/ack-intent", req); },
    renamePeer(req) { return post<RenamePeerResponse>("/rename-peer", req); },
  };
}
