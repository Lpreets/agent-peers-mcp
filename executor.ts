#!/usr/bin/env bun
// Host-local executor for durable broker intents. Phase 2 implements wake
// intents and explicitly stubs rotate intents for Phase 3.

import { createClient } from "./shared/broker-client.ts";
import { resolveBrokerClientConfig } from "./shared/broker-config.ts";
import { resolveHostId } from "./shared/host-id.ts";
import { readSharedSecretOrThrow } from "./shared/shared-secret.ts";
import { readWakeMode } from "./shared/wake-worker.ts";
import { wakePeerIfIdle as defaultWakeFn } from "./shared/tmux-wake.ts";
import type {
  AckHostIntentRequest,
  AckHostIntentResponse,
  HostIntent,
  WakeDecision,
  WakeMode,
  WakePeerIfIdle,
  WakeTarget,
} from "./shared/types.ts";

export interface ProcessHostIntentOptions {
  mode: WakeMode;
  wakeFn?: WakePeerIfIdle;
  ackIntent: (req: AckHostIntentRequest) => Promise<AckHostIntentResponse>;
}

export async function processHostIntent(intent: HostIntent, opts: ProcessHostIntentOptions): Promise<void> {
  const leaseToken = intent.lease_token;
  if (!leaseToken) return;

  if (intent.type === "rotate") {
    await opts.ackIntent({
      id: intent.id,
      lease_token: leaseToken,
      status: "failed",
      result: "not-implemented",
      idle_proof: "rotate intents are reserved for Phase 3",
    });
    return;
  }

  const target: WakeTarget = {
    peer_id: intent.target_peer_id,
    peer_type: intent.target_peer_type,
    name: intent.target_name,
    cwd: intent.target_cwd,
    git_root: intent.target_git_root,
    tty: intent.target_tty,
    reason_id: intent.reason_id,
  };
  const wakeFn = opts.wakeFn ?? defaultWakeFn;
  let decision: WakeDecision;
  try {
    decision = await wakeFn(target, opts.mode);
  } catch (err) {
    decision = {
      peer_id: target.peer_id,
      name: target.name,
      peer_type: target.peer_type,
      tty: target.tty,
      cwd: target.cwd,
      result: "error",
      reason_id: target.reason_id,
      mode: opts.mode,
      idle_proof: `mechanism threw: ${err instanceof Error ? err.message : String(err)}`,
      at: new Date().toISOString(),
    };
  }

  await opts.ackIntent({
    id: intent.id,
    lease_token: leaseToken,
    status: decision.result === "error" ? "failed" : "done",
    result: decision.result,
    idle_proof: decision.idle_proof ?? null,
  });
}

async function main(): Promise<void> {
  const mode = readWakeMode();
  if (mode === "off") {
    console.error("[agent-peers/executor] AGENT_PEERS_WAKE_MODE=off; executor inert");
    return;
  }
  const hostId = resolveHostId();
  if (!hostId) throw new Error("agent-peers executor: unable to resolve host id");
  const cfg = resolveBrokerClientConfig();
  const secret = readSharedSecretOrThrow(cfg.secretPath);
  const client = createClient(cfg.brokerUrl, secret);
  const intervalMs = parseInt(process.env.AGENT_PEERS_EXECUTOR_POLL_MS ?? "1000", 10);

  console.error(`[agent-peers/executor] polling ${cfg.brokerUrl} for host_id=${hostId} mode=${mode}`);
  const tick = async () => {
    const intents = await client.pollHostIntents({ host_id: hostId });
    for (const intent of intents) {
      await processHostIntent(intent, {
        mode,
        ackIntent: (ack) => client.ackHostIntent(ack),
      });
    }
  };

  await tick();
  setInterval(() => { void tick().catch((err) => console.error("[agent-peers/executor] tick error:", err)); }, intervalMs);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[agent-peers/executor] fatal:", err);
    process.exit(1);
  });
}
