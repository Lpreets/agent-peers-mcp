# S311 Cross-Host Security and Routing Audit

Date: 2026-06-07
Owner: Codex
Scope: Stage 0 read-only audit for agent-peers unified transport. No transport code, settings, firewall, or process state was changed.

## Executive Verdict

Agent-peers is a good candidate for the firm target state of replacing claude-peers, but cross-host enablement should land behind explicit env gates and a shadow period. The live PCO state is favorable for a default-off migration: claude-peers is already LAN-exposed on `0.0.0.0:7899`, while agent-peers remains loopback-only on `127.0.0.1:7900`.

Recommended Stage 1 design stance:

- Keep agent-peers default bind at `127.0.0.1`.
- Add explicit non-loopback bind only when both `AGENT_PEERS_BIND` and a valid shared secret file are configured.
- Add remote client host configuration without local auto-spawn in remote mode.
- Prefer SSH tunnel for the first live PCO<->PC pilot unless operator explicitly chooses LAN exposure.
- Preserve agent-peers lease/ack, session-token, durable Codex inbox, peer-type, and DB/secret permission semantics.

## Live PCO Network Evidence

PCO host address:

```text
enp8s0 UP 10.23.1.102/24
default via 10.23.1.1 dev enp8s0
```

Observed LAN neighbor/routability signal:

```text
10.23.1.200 dev enp8s0 lladdr d8:cb:8a:a2:bb:91 REACHABLE
ping -c 1 -W 1 10.23.1.200 -> 1 received, 0% packet loss, rtt 0.669 ms
```

Interpretation: PCO has a direct route to `10.23.1.200` on the same `/24`. That supports either a direct LAN pilot or an SSH-tunnel pilot. This does not prove application-level reachability from PC back to PCO; Stage 1 live test still needs an operator-ratified PC-side probe.

Firewall status on PCO:

```text
systemctl is-active firewalld ufw nftables -> inactive / inactive / inactive
nft list ruleset -> empty output
```

Interpretation: there is no active host firewall layer observed on PCO. A direct non-loopback bind would likely expose the broker to the LAN unless another perimeter layer filters it. That strengthens the recommendation to pilot via SSH tunnel first or require an explicit firewall allowlist before `AGENT_PEERS_BIND=0.0.0.0`.

## Live Broker Posture

Listening ports:

```text
claude-peers: 0.0.0.0:7899 pid=4136887
agent-peers: 127.0.0.1:7900 pid=2006500
```

Health checks from PCO:

```text
curl http://127.0.0.1:7900/health -> {"ok":true,"pid":2006500}
curl http://127.0.0.1:7899/health -> {"status":"ok","peers":7}
curl http://10.23.1.102:7899/health -> {"status":"ok","peers":7}
curl http://10.23.1.102:7900/health -> connection refused
```

Interpretation:

- Current claude-peers is already reachable through PCO's LAN interface.
- Current agent-peers is not LAN-reachable, which is the correct default.
- Agent-peers `/health` currently returns PID unauthenticated on loopback. If non-loopback bind is enabled, Stage 1 should consider either minimal health output or auth-gated detail.

Observed process posture:

```text
claude --dangerously-load-development-channels server:claude-peers server:agent-peers
bun /home/lpreet/Projects/MSAASA_Projects/claude-peers-mcp/server.ts
bun /home/lpreet/Projects/MSAASA_Projects/agent-peers-mcp/claude-server.ts
bun /home/lpreet/Projects/MSAASA_Projects/agent-peers-mcp/codex-server.ts
bun broker.ts
bun /home/lpreet/Projects/MSAASA_Projects/claude-peers-mcp/broker.ts
```

Cutover implication: retirement must inventory wrappers and managed settings that still load `server:claude-peers`. The live main MSAASA Claude command loads both dev channels today.

## Secret and Local State Posture

Agent-peers local files:

```text
~/.agent-peers-secret mode 0600 owner lpreet:lpreet
~/.agent-peers.db mode 0600 owner lpreet:lpreet
~/.agent-peers.db-shm mode 0600 owner lpreet:lpreet
~/.agent-peers.db-wal mode 0600 owner lpreet:lpreet
~/.agent-peers-codex/* mode 0600
```

No `~/.claude-peers-secret` file was observed via `stat`; claude-peers may be using an env-provided secret or inherited launch state. Claude's usage audit should confirm.

Stage 1 implication:

- Do not let remote-mode clients auto-generate per-host secrets. That would create split-brain auth.
- Add `AGENT_PEERS_SECRET_FILE` or equivalent. In remote mode, missing/invalid secret file should fail closed.
- Preserve current owner/mode/symlink checks.
- Avoid `AGENT_PEERS_SECRET` env literal unless operator accepts environment/proc leakage risk.

## Source Evidence: Current Agent-Peers Constraints

Current broker bind is hardcoded loopback:

- `broker.ts:862-865`: `Bun.serve({ port, hostname: "127.0.0.1", ... })`

Current broker auth posture:

- `broker.ts:20-27`: default DB/secret paths and `x-agent-peers-secret` header.
- `broker.ts:873-877`: every non-health request requires matching shared secret.
- `broker.ts:725-731`: secret comment states all broker HTTP requests must carry the secret except `/health`.
- `broker.ts:750-757`: existing secret file is validated and too-short files fail closed.
- `shared/shared-secret.ts:59-80`: validates non-symlink regular file, current owner, mode `0600`.

Current local auto-spawn is not remote-aware:

- `shared/ensure-broker.ts:9-30`: if health check fails, spawns `bun broker.ts` locally.
- `claude-server.ts:38-39`: broker URL is hardcoded `http://127.0.0.1:${AGENT_PEERS_PORT}`.
- `codex-server.ts:82-83`: same hardcoded loopback broker URL.

Stage 1 implication: client broker URL must be configurable, and `ensureBroker` must only auto-spawn when target host is loopback/local. Remote-mode connection failure should surface a clear error instead of starting a shadow local broker.

## Codex Delivery Regression Check

No Codex delivery regression is expected from remote broker mode if the HTTP API semantics remain unchanged.

Evidence:

- `broker.ts:529-580`: `pollMessages` leases unacked rows with lease expiry and session-token auth.
- `broker.ts:585-599`: `ackMessages` acks by lease token only when the recipient peer id and session token match.
- `codex-server.ts:5-61`: delivery invariant says no broker ack or local prune until a later Codex tool call proves the previous response completed.
- `codex-server.ts:234-287`: background poll persists leased messages to durable local queue before any push/ack behavior.
- `codex-server.ts:336-420`: `withPiggyback` flushes confirmed acks, promotes previously presented messages only on the next call, polls inline, and reads the durable queue without consuming it.
- `shared/codex-inbox.ts:40-63`: queue writes are atomic temp-file writes with restrictive permissions.
- `shared/codex-inbox.ts:142-179`: inbox read refuses wider-than-0600 or wrong-owner files and otherwise loads unread state.

Remote-mode requirements to preserve this:

- Keep message ids, lease tokens, session tokens, and ack endpoints unchanged.
- Keep Codex durable inbox local to the Codex host; do not centralize it in the broker.
- Ensure reconnect/reclaim does not rotate session identity in a way that strands pending local inbox state unexpectedly.
- Do not shorten lease/reclaim windows during the cross-host pilot.

## Security Risks and Controls

Risk: non-loopback broker exposes peer enumeration and message injection if the secret leaks.

Controls:

- Default `127.0.0.1` bind.
- Non-loopback bind requires explicit env plus valid shared secret.
- Prefer SSH tunnel first: broker remains loopback-bound on PCO, PC dials a local forwarded port.
- If LAN bind is chosen, bind to `10.23.1.102` rather than `0.0.0.0` where feasible.
- If `0.0.0.0` is necessary, require firewall allowlist for the PC/PCO addresses.
- Keep unauthenticated health minimal on non-loopback.

Risk: remote-mode auto-spawns a local broker after failed remote health check, creating split-brain.

Controls:

- Add a remote-mode flag or infer from non-loopback broker host.
- Disable `ensureBroker` local spawn unless broker host is `127.0.0.1`, `localhost`, or a configured local address.
- Error clearly with target URL and secret-file path status.

Risk: per-host generated secrets break auth or accidentally connect to the wrong trust boundary.

Controls:

- Use shared secret file provisioning.
- Fail closed when remote mode has no valid secret file.
- Keep generated default secret only for local single-host mode.

Risk: current PCO has no active host firewall.

Controls:

- Prefer SSH tunnel pilot.
- Treat direct LAN bind as operator-ratified infra exposure.

## Stage 1 Design Inputs

Suggested env shape:

- `AGENT_PEERS_PORT`: existing broker port, default `7900`.
- `AGENT_PEERS_BIND`: broker bind host, default `127.0.0.1`.
- `AGENT_PEERS_BROKER_HOST`: client connect host, default `127.0.0.1`.
- `AGENT_PEERS_BROKER_URL`: optional full override if host/port split is insufficient.
- `AGENT_PEERS_SECRET_FILE`: shared secret path override, default local `~/.agent-peers-secret`.
- `AGENT_PEERS_REMOTE=1`: optional explicit remote-mode gate if host inference is too implicit.

Required tests:

- Broker default remains loopback.
- Non-loopback bind without valid secret config fails closed.
- Client remote host does not call local `ensureBroker`.
- Client local host still auto-spawns broker.
- Shared-secret file override validates owner/mode/symlink.
- Auth header remains `X-Agent-Peers-Secret`.
- Codex inbox/lease tests still pass unchanged.

## Open Questions for Merge With Claude Audit

- Which host is canonical PC for this pilot: observed `10.23.1.200`, or another PC address from Claude's inventory?
- Is SSH from PC to PCO or PCO to PC already configured for local forwarding?
- Where is the live claude-peers secret configured, if any?
- Which wrappers/settings still load `server:claude-peers` and must be changed at retirement?
- Does any current automation depend on unauthenticated claude-peers `/health` returning peer count?

## S305 Markers

- `parallel_shape_used`: Codex used local parallel read lanes via `multi_tool_use.parallel`; Claude is running the code/settings/docs usage inventory in parallel.
- `discussion_points_hit`: DP0/DP1 via peer messages 7555-7558; DP2 pending Stage 0 merge.
- `lead_by_strength_roles`: Claude owns usage/parity inventory; Codex owns security/routing and Codex-regression evidence.
- `operator_ratified_before_landing`: no high-blast transport mutation landed; this report is read-only evidence plus a new audit artifact requested by Claude/operator lane.
