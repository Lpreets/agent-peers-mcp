import { expect, test } from "bun:test";
import { processHostIntent } from "../executor.ts";
import type { HostIntent, WakeDecision, WakeMode, WakeTarget } from "../shared/types.ts";

function intent(over: Partial<HostIntent> = {}): HostIntent {
  return {
    id: 1,
    type: "wake",
    host_id: "lpreet-pc",
    target_peer_id: "peer-1",
    target_peer_type: "codex",
    target_name: "remote-codex",
    target_cwd: "/repo",
    target_git_root: "/repo",
    target_tty: "pts/9",
    reason_id: "msg-1",
    status: "leased",
    attempts: 1,
    created_at: "2026-06-08T08:00:00.000Z",
    updated_at: "2026-06-08T08:00:00.000Z",
    leased_at: "2026-06-08T08:00:00.000Z",
    lease_expires_at: "2026-06-08T08:00:30.000Z",
    lease_token: "lease-1",
    result: null,
    idle_proof: null,
    ...over,
  };
}

test("processHostIntent executes wake intents locally and acks structured telemetry only", async () => {
  const wakeCalls: WakeTarget[] = [];
  const acks: unknown[] = [];
  const wakeFn = async (target: WakeTarget, mode: WakeMode): Promise<WakeDecision> => {
    wakeCalls.push(target);
    return {
      peer_id: target.peer_id,
      name: target.name,
      peer_type: target.peer_type,
      tty: target.tty,
      cwd: target.cwd,
      result: "would_wake",
      reason_id: target.reason_id,
      mode,
      idle_proof: "test proof",
      at: "2026-06-08T08:00:00.000Z",
    };
  };

  await processHostIntent(intent(), {
    mode: "log-only",
    wakeFn,
    ackIntent: async (ack) => { acks.push(ack); return { ok: true, acked: 1 }; },
  });

  expect(wakeCalls).toHaveLength(1);
  expect(wakeCalls[0]!.peer_id).toBe("peer-1");
  expect(acks).toEqual([{
    id: 1,
    lease_token: "lease-1",
    status: "done",
    result: "would_wake",
    idle_proof: "test proof",
  }]);
  expect(JSON.stringify(acks[0])).not.toContain("message body");
});

test("processHostIntent stubs rotate intents as failed not-implemented in Phase 2", async () => {
  const acks: unknown[] = [];
  await processHostIntent(intent({ type: "rotate" }), {
    mode: "on",
    wakeFn: async () => { throw new Error("should not wake rotate"); },
    ackIntent: async (ack) => { acks.push(ack); return { ok: true, acked: 1 }; },
  });

  expect(acks).toEqual([{
    id: 1,
    lease_token: "lease-1",
    status: "failed",
    result: "not-implemented",
    idle_proof: "rotate intents are reserved for Phase 3",
  }]);
});
