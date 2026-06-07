# S311 Stage 1 Cross-Host Design Spec

Date: 2026-06-07
Owner: Codex lead, Claude review
Status: Draft for bilateral review before Stage 2 prototype
Scope: Design only. No live bind, no firewall change, no transport cutover, no claude-peers mutation.

## Goal

Make agent-peers support PCO<->PC cross-host operation while preserving its current stronger single-host guarantees:

- loopback-only by default;
- shared-secret auth on all non-health broker calls;
- peer `session_token` ownership checks;
- broker lease/ack delivery;
- local Codex durable inbox with confirm-on-next-tool-call semantics;
- file-permission trust boundary for DB, secrets, and Codex inbox.

The design closes the single functional gap identified in Stage 0: agent-peers is loopback-only today, while claude-peers already supports a central broker reachable over the LAN. This spec intentionally copies the cross-host shape, not claude-peers' weaker delivery model.

Important scope correction from Stage 1 review-prep: agent-peers already has broker request auth. `createClient(baseUrl, sharedSecret)` injects `X-Agent-Peers-Secret` and the broker already rejects non-health calls without the matching secret. Stage 2 does not add a new auth mechanism; it only changes how both sides locate the same shared secret in remote mode.

## Non-Goals

- No federation or relay design. Stage 2 uses central PCO broker model A only.
- No retirement of claude-peers. Retirement remains a later parity/shadow-gated milestone.
- No direct LAN exposure during prototype. Stage 2 can test bind behavior locally; Stage 3 live pilot is operator-ratified.
- No inline plaintext secret in managed settings. Secret material must live in a file or an operator-approved secret mechanism.
- No behavior change for default local users.

## Operating Model

### Local Default

Default behavior remains exactly single-host:

```text
broker bind: 127.0.0.1:7900
client URL:  http://127.0.0.1:7900
secret file: ~/.agent-peers-secret
broker spawn: enabled when local health fails
```

A user who does not set new env vars should observe no network exposure and no change in install instructions.

### Cross-Host Pilot

The first live PCO<->PC pilot should use an SSH tunnel:

```text
PCO broker: 127.0.0.1:7900
PC tunnel:  localhost:<forwarded-port> -> PCO 127.0.0.1:7900
PC clients: AGENT_PEERS_BROKER_URL=http://127.0.0.1:<forwarded-port>
```

This proves cross-host semantics without changing the broker trust boundary. Direct LAN bind is available only after explicit operator ratification.

### Direct LAN Mode

Direct LAN mode is allowed but gated:

```text
AGENT_PEERS_BIND=10.23.1.102
AGENT_PEERS_SECRET_FILE=/path/to/shared/agent-peers.secret
```

Binding `0.0.0.0` is a broader exposure mode. It should require explicit operator choice plus a firewall or network allowlist for the peer hosts.

## Environment Variables

| Variable | Applies to | Default | Meaning |
|---|---|---:|---|
| `AGENT_PEERS_PORT` | broker + clients | `7900` | Broker port. Existing variable, preserved. |
| `AGENT_PEERS_BIND` | broker | `127.0.0.1` | Host/interface for `Bun.serve`. Non-loopback requires a valid secret file and explicit operator intent. |
| `AGENT_PEERS_BROKER_HOST` | clients | `127.0.0.1` | Hostname/IP clients dial when full URL is not supplied. |
| `AGENT_PEERS_BROKER_URL` | clients | unset | Full client broker URL override, e.g. SSH-tunnel localhost port. Takes precedence over host+port. |
| `AGENT_PEERS_SECRET_FILE` | broker + clients | `~/.agent-peers-secret` | Shared secret file path. Validated with the existing regular-file, owner, non-symlink, `0600` checks. |
| `AGENT_PEERS_REMOTE` | clients | inferred | Optional explicit remote-mode flag. `1` disables local auto-spawn and fail-closes on missing/invalid secret. |

Rejected for Stage 2:

- `AGENT_PEERS_SECRET`: reject as a normal path because env literals leak through process/environment surfaces and repeat the Stage 0 claude-peers plaintext settings hygiene issue. If ever added, it should be an explicit break-glass/debug mode, not documented pilot guidance.

## URL and Mode Resolution

Clients should resolve broker target in this order:

1. If `AGENT_PEERS_BROKER_URL` is set, use it exactly after validating `http://` or `https://` protocol.
2. Else construct `http://${AGENT_PEERS_BROKER_HOST ?? "127.0.0.1"}:${AGENT_PEERS_PORT ?? 7900}`.

Remote mode should be true when any of the following holds:

- `AGENT_PEERS_REMOTE=1`;
- `AGENT_PEERS_BROKER_URL` is set and its host is not loopback;
- `AGENT_PEERS_BROKER_HOST` is set and is not `127.0.0.1`, `localhost`, `::1`, or a recognized local address.

For SSH tunnel pilot, `AGENT_PEERS_BROKER_URL=http://127.0.0.1:<forwarded-port>` may still be semantically remote while syntactically loopback. In that case the pilot should set `AGENT_PEERS_REMOTE=1` to disable auto-spawn.

## Broker Bind Policy

Broker startup should resolve:

```text
bindHost = AGENT_PEERS_BIND ?? "127.0.0.1"
secretPath = AGENT_PEERS_SECRET_FILE ?? "~/.agent-peers-secret"
```

Rules:

1. `127.0.0.1`, `localhost`, and `::1` are local mode.
2. Any other bind host is non-loopback mode.
3. Non-loopback mode must validate an existing secret file before serving.
4. Non-loopback mode must not auto-generate a new shared secret.
5. Local mode may preserve current first-run auto-generation of `~/.agent-peers-secret`.
6. Broker logs must include the bind URL without printing secret material.

Fail-closed cases:

- `AGENT_PEERS_BIND` is non-loopback and `AGENT_PEERS_SECRET_FILE` is missing.
- The configured secret file is a symlink, not regular, wrong owner, wrong mode, or shorter than the existing minimum length.
- `AGENT_PEERS_BIND=0.0.0.0` without a valid secret file.

## Secret Provisioning

Cross-host operation requires one shared secret copied out-of-band to both hosts.

Required file properties:

```text
owner: current user
mode:  0600
type:  regular file, not symlink
size:  existing minimum length >= 32 chars
```

Recommended path:

```text
~/.config/agentic/secrets.d/agent-peers.secret
```

The exact path can vary by host, but clients and broker must point at it through `AGENT_PEERS_SECRET_FILE`. Managed settings should reference only the file path, never the secret value.

## Local Auto-Spawn Policy

Current `ensureBroker` spawns `bun broker.ts` whenever health fails. This is correct for local mode and dangerous for remote mode.

Stage 2 should change callers so:

- local mode: health failure still calls `ensureBroker`;
- remote mode: health failure returns a clear startup error and never spawns a local broker;
- SSH tunnel mode: set `AGENT_PEERS_REMOTE=1`, so a broken tunnel cannot silently create a split-brain local broker.

Suggested error shape:

```text
agent-peers remote broker unavailable: <url>
remote mode disables local broker auto-spawn; check tunnel/bind/firewall and AGENT_PEERS_SECRET_FILE
```

## Health Endpoint Policy

Current unauthenticated local health returns PID. For Stage 2:

- keep unauthenticated `GET /health` for local liveness and compatibility;
- when bound to non-loopback, return only minimal liveness:

```json
{"ok":true}
```

Do not expose peer counts, DB paths, secret paths, or process argv. Keep detailed diagnostics in CLI/local DB inspection, not unauthenticated network health.

## Source Touch Points for Stage 2

Expected implementation surfaces are intentionally narrow:

- `broker.ts`
  - add bind-host resolution;
  - add secret-file path override;
  - fail closed for non-loopback without existing valid secret;
  - use bind host in `Bun.serve`;
  - minimize non-loopback health detail.
- `shared/shared-secret.ts`
  - expose env-aware secret path helper or accept explicit path consistently;
  - preserve existing permission validation.
- `shared/ensure-broker.ts`
  - add remote-mode/no-spawn wrapper or have callers gate it.
- `shared/broker-client.ts`
  - no auth semantics change; keep `X-Agent-Peers-Secret`.
- `claude-server.ts`
  - resolve broker URL from env;
  - resolve secret file from env;
  - disable auto-spawn in remote mode.
- `codex-server.ts`
  - same as Claude server;
  - preserve Codex durable inbox behavior.
- `cli.ts`
  - optional: respect broker URL/secret file for network diagnostics;
  - preserve DB-local admin operations as local-only unless explicitly redesigned.
- tests
  - add unit tests for config resolution and startup gating;
  - keep existing delivery tests passing.

The four core code deltas should be:

1. `broker.ts`: replace the hardcoded `hostname: "127.0.0.1"` with resolved `AGENT_PEERS_BIND ?? "127.0.0.1"` plus non-loopback secret-file gating.
2. `claude-server.ts` and `codex-server.ts`: replace hardcoded `BROKER_URL=http://127.0.0.1:${port}` with env-resolved broker URL/host.
3. `shared/ensure-broker.ts` or its callers: skip `Bun.spawn` in remote mode; health-check remains, but a failed remote health check errors instead of spawning a local broker.
4. `shared/shared-secret.ts`: resolve `AGENT_PEERS_SECRET_FILE`; remote mode reads that file fail-closed and never waits for a locally provisioned generated secret.

No broker HTTP API, auth header, lease/ack, inbox, or schema change is required.

## Delivery Invariants That Must Not Change

Stage 2 must preserve these existing invariants:

- `pollMessages` leases unacked rows; it does not mark delivered.
- `ackMessages` requires recipient peer id plus session token.
- `sendMessage` only targets active peers by id or name.
- Codex persists leased messages locally before surfacing them.
- Codex only acks/prunes after a subsequent tool call confirms the prior response reached the model.
- Codex inbox remains local to the Codex host and retains `0600` file / `0700` directory posture.
- Broker DB and WAL/SHM files remain `0600`.

Remote HTTP transport should only change where the same API is reached, not what delivery means.

## Stage 2 Test Matrix

Minimum local test matrix before any live PCO<->PC pilot:

| Test | Expected |
|---|---|
| Default broker startup with no new env | Listens on `127.0.0.1:7900`; local behavior unchanged. |
| `AGENT_PEERS_BIND=127.0.0.1` | Same as default. |
| `AGENT_PEERS_BIND=0.0.0.0` without configured existing secret file | Startup fails closed before `Bun.serve`. |
| `AGENT_PEERS_BIND=10.23.1.102` with valid `AGENT_PEERS_SECRET_FILE` | Startup uses requested bind and does not print the secret. |
| Secret file mode `0644` | Broker/client refuses to use it. |
| Secret file symlink | Broker/client refuses to use it. |
| `AGENT_PEERS_BROKER_URL=http://127.0.0.1:7999 AGENT_PEERS_REMOTE=1` and no server | Client errors clearly; no local broker is spawned. |
| Local client health failure without remote mode | Existing local auto-spawn still works. |
| Remote client with valid secret reaches a test broker | Register/list/send/poll/ack flow passes. |
| Wrong secret against test broker | Non-health calls return `401`. |
| Non-loopback health | Returns minimal liveness only. |
| Codex inbox tests | Existing tests pass unchanged. |
| Broker lease/ack tests | Existing tests pass unchanged. |
| End-to-end local delivery | Existing e2e test passes unchanged. |

Recommended commands after Stage 2 implementation:

```bash
bun test
bunx tsc --noEmit
git diff --check
```

## Stage 3 Live Pilot Plan

Stage 3 is the first genuine HITL gate and must be operator-ratified.

Preferred pilot:

1. Start PCO broker on loopback only.
2. Establish SSH tunnel from PC to PCO broker.
3. Configure PC agent-peers clients with:

```text
AGENT_PEERS_REMOTE=1
AGENT_PEERS_BROKER_URL=http://127.0.0.1:<forwarded-port>
AGENT_PEERS_SECRET_FILE=<shared-secret-file-on-PC>
```

4. Verify PC can register a Claude and/or Codex peer into the PCO broker.
5. Verify PCO<->PC send/list/check flow.
6. Verify Codex recipient still uses local durable inbox and confirm-on-next-tool-call behavior.
7. Keep claude-peers running as fallback.

Direct LAN pilot is a fallback path if SSH tunnel is insufficient:

```text
AGENT_PEERS_BIND=10.23.1.102
AGENT_PEERS_SECRET_FILE=<shared-secret-file-on-PCO>
```

Before direct LAN bind:

- operator ratifies exposure;
- PC->PCO application reachability is probed;
- firewall/allowlist posture is explicit;
- rollback command is ready.

## Rollback

Stage 2 rollback:

- unset new env vars;
- stop test broker;
- restart clients with default local env;
- no DB migration rollback expected because schema must not change.

Stage 3 SSH-tunnel rollback:

- stop PC clients using remote env;
- close SSH tunnel;
- restart PC clients with local/default agent-peers or keep claude-peers fallback.

Stage 3 LAN-bind rollback:

- unset `AGENT_PEERS_BIND`, `AGENT_PEERS_BROKER_HOST`, `AGENT_PEERS_BROKER_URL`, and `AGENT_PEERS_REMOTE`;
- restart broker/clients;
- verify `ss -ltnp` shows agent-peers only on `127.0.0.1:7900`;
- keep claude-peers fallback untouched.

No rollback step should delete `~/.agent-peers.db`, `~/.agent-peers-secret`, Codex inbox files, or claude-peers state during Stages 1-3.

## Acceptance Criteria for Stage 1

- Spec exists and covers env vars, remote no-auto-spawn, fail-closed auth, secret-file-only guidance, health behavior, bind policy, SSH-tunnel pilot, rollback, and test matrix.
- Claude cross-reviews the spec before Stage 2 code.
- Operator is not asked for HITL until Stage 3 live pilot, unless review finds a material safety disagreement.

## S305 Markers

- `parallel_shape_used`: bilateral plan plus parallel read lanes; Stage 1 is serialized doc write by Codex lead.
- `discussion_points_hit`: DP0/DP1 complete in Stage 0; DP2 active for Stage 1 review; DP3 required before Stage 2 prototype merge.
- `lead_by_strength_roles`: Codex owns network/security design; Claude owns cross-review and broader retirement-blocker integration.
- `operator_ratified_before_landing`: operator gave "Proceed Optimally" for Stages 1-2; no live high-blast transport mutation in this spec.
