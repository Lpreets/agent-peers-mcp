import { writeSync } from "node:fs";
import { isSessionExpiredError } from "./broker-client.ts";
import type { SendMessageResponse } from "./types.ts";

export type AuthLostComponent = "claude" | "codex";
export type AuthLostOperation = "poll" | "heartbeat" | "summary" | "unregister" | "send_message";
export type AuthLostReason = "session_expired" | "unauthorized_sender";

export interface AuthLostHandlerOptions {
  component: AuthLostComponent;
  writeStderr?: (line: string) => void;
  exit?: (code: number) => void;
}

export interface AuthLostHandler {
  isLost(): boolean;
  exitIfSessionExpired(operation: AuthLostOperation, error: unknown): boolean;
  exitIfUnauthorizedSend(response: SendMessageResponse): boolean;
}

function isUnauthorizedSender(response: SendMessageResponse): boolean {
  return response.ok === false
    && typeof response.error === "string"
    && /^unauthorized sender:/.test(response.error);
}

/**
 * Convert broker-side session loss into one deterministic local terminal
 * event. State is process-local: the broker never tracks or broadcasts a
 * global "victim" flag, and no session token or peer id is serialized.
 */
export function createAuthLostHandler(options: AuthLostHandlerOptions): AuthLostHandler {
  const writeStderr = options.writeStderr ?? ((line: string) => { writeSync(2, `${line}\n`); });
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let lost = false;

  const trip = (operation: AuthLostOperation, reason: AuthLostReason): boolean => {
    if (!lost) {
      lost = true;
      try {
        // Synchronous fd write makes the terminal evidence deterministic even
        // though the very next action terminates the MCP process.
        writeStderr(JSON.stringify({
          event: "AUTH_LOST",
          component: options.component,
          operation,
          reason,
        }));
      } finally {
        exit(1);
      }
    }
    return true;
  };

  return {
    isLost: () => lost,
    exitIfSessionExpired(operation, error) {
      return isSessionExpiredError(error) ? trip(operation, "session_expired") : false;
    },
    exitIfUnauthorizedSend(response) {
      return isUnauthorizedSender(response)
        ? trip("send_message", "unauthorized_sender")
        : false;
    },
  };
}
