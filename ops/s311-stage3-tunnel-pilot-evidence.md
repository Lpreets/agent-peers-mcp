# S311 Stage 3 SSH-Tunnel Pilot Evidence

Date: 2026-06-07
Owner: Codex PC-side execution, Claude PCO-side receiver verification
Status: PASS for SSH-tunnel cross-host pilot; hold before teardown/shadow decision

## Scope

Operator ratified Stage 3 and authorized PC-side SSH execution, including killing existing PC tmux sessions and making the relevant temporary PC-side client configuration changes. No PCO broker restart, PCO firewall change, direct LAN bind, claude-peers decommission, or production cutover was performed.

## Code Under Test

PC agent-peers checkout:

```text
path: /home/lpreet/Projects/agent-peers-mcp
branch: fix/s311-agent-peers-crosshost-default-off
commit: 83b482f
remote tracking: lpreets/fix/s311-agent-peers-crosshost-default-off
```

PC MCP servers observed running from that checkout:

```text
/home/lpreet/.bun/bin/bun /home/lpreet/Projects/agent-peers-mcp/claude-server.ts
/home/lpreet/.bun/bin/bun /home/lpreet/Projects/agent-peers-mcp/codex-server.ts
```

## PCO Broker Target

The pilot used the already-running PCO broker as the tunnel target.

```text
PCO listen: 127.0.0.1:7900
PCO broker pid: 2006500
PCO broker elapsed at evidence capture: 11-21:48:48
PCO command: bun broker.ts
```

Conclusion: PCO broker was not killed or restarted for this pilot.

## PC Preparation

Existing PC tmux sessions were killed per operator authorization:

```text
tmux-clean
```

PC secret file was provisioned by secure file copy from PCO `~/.agent-peers-secret` to a PC-side file path. Secret contents were not printed in peer messages or evidence.

```text
PC secret file: /home/lpreet/.config/agentic/secrets.d/agent-peers-pco.secret
mode/owner: 600 lpreet:lpreet
```

Temporary PC client env was configured in:

```text
~/.claude/settings.json
~/.codex/config.toml
```

Backups were created before edits with names matching:

```text
~/.claude/settings.json.s311-stage3-bak-<timestamp>
~/.codex/config.toml.s311-stage3-bak-<timestamp>
```

Effective remote env:

```text
AGENT_PEERS_REMOTE=1
AGENT_PEERS_BROKER_URL=http://127.0.0.1:17900
AGENT_PEERS_SECRET_FILE=/home/lpreet/.config/agentic/secrets.d/agent-peers-pco.secret
```

## Tunnel

PC could not initiate SSH back to PCO:

```text
PC -> PCO 10.23.1.102:22   connection refused
PC -> PCO 10.23.1.102:2221 connection refused
```

Therefore the pilot used the authorized reverse tunnel from PCO to PC:

```text
ssh -f -N -R 127.0.0.1:17900:127.0.0.1:7900 -p 2221 lpreet@10.23.1.101
```

PC-side listener:

```text
LISTEN 127.0.0.1:17900
```

Health probe from PC through the tunnel:

```text
curl http://127.0.0.1:17900/health
{"ok":true,"pid":2006500}
```

## PC Pair Launch

PC tmux session:

```text
session: MSAASA_STAGE3
cwd: /home/lpreet/Projects/MSAASA
pane 0: claude --dangerously-load-development-channels server:claude-peers server:agent-peers
pane 1: codex -C /home/lpreet/Projects/MSAASA
```

Claude dev-channel confirmation was accepted in the PC pane. Both PC agent-peers MCP servers then registered through the tunnel.

## PCO Broker Registration Evidence

PC peers observed from PCO `agent-peers list_peers scope=machine`:

```text
bold-mantis (claude)
  CWD: /home/lpreet/Projects/MSAASA
  Summary: PC_STAGE3_CLAUDE_REMOTE_TUNNEL cwd=/home/lpreet/Projects/MSAASA

sunny-drake (codex)
  CWD: /home/lpreet/Projects/MSAASA
  Summary: PC_STAGE3_CODEX_REMOTE_TUNNEL cwd=/home/lpreet/Projects/MSAASA
```

## Message Proof

### Claude Path

Claude PCO-side verification from `fuzzy-drake`:

```text
STAGE 3 PILOT - CLAUDE PATH PASS
PC peers registered via tunnel: bold-mantis (claude), sunny-drake (codex)
PCO -> PC: bold-mantis confirmed receipt
PC -> PCO: bold-mantis replied nonce TUNNEL-OK-7311 and it arrived over agent-peers
```

Verdict: bidirectional cross-host delivery for Claude path PASS.

### Codex Durable-Inbox Path

PCO Codex sent to PC Codex peer `sunny-drake`:

```text
S311_STAGE3_PCO_TO_PC_TEST from PCO Codex via SSH tunnel
```

PC Codex then used its actual `agent-peers.check_messages` tool. The PC Codex pane showed:

```text
Called agent-peers.check_messages({})
  PEER INBOX - 2 unread message(s) from your colleagues.

Saw S311_STAGE3_PCO_TO_PC_TEST in agent-peers inbox from chill-cub,
plus the PCO verification request from fuzzy-drake.
```

PC Codex replied via `agent-peers.send_message`:

```text
to_id: fuzzy-drake
message: S311_STAGE3_PC_TO_PCO_REPLY from PC Codex via SSH tunnel
Message sent (id=7576)
```

Verdict: cross-host delivery to a Codex recipient through the local durable inbox path PASS. This was verified through PC Codex `check_messages`, not broker-row inspection.

## Constraints Honored

- PCO broker was not restarted.
- PCO broker remained loopback-bound.
- No PCO firewall/listener change.
- No direct LAN bind.
- No claude-peers retirement or decommission.
- PC client env used `AGENT_PEERS_REMOTE=1`; no split-brain local broker was used for the pilot path.
- Secret content was not printed in logs/evidence.

## Rollback Readiness

Immediate rollback:

1. Stop PC tmux session `MSAASA_STAGE3`.
2. Close the reverse SSH tunnel exposing PC `127.0.0.1:17900`.
3. Restore PC `~/.claude/settings.json` and `~/.codex/config.toml` from the `s311-stage3-bak-*` backups, or remove the three temporary env keys.
4. Decide whether to keep or remove `/home/lpreet/.config/agentic/secrets.d/agent-peers-pco.secret` based on the Stage 4 shadow plan.

Current state at evidence write: tunnel and PC pair intentionally left running pending bilateral Stage 4/teardown decision.

## Verdict

Stage 3 SSH-tunnel pilot PASS:

- PC-side Stage 2 client code connected to the existing PCO loopback broker through SSH tunnel.
- PCO observed PC Claude and PC Codex peers registered in the shared broker.
- Bidirectional cross-host Claude messaging passed.
- PCO-to-PC Codex durable-inbox delivery passed through actual PC Codex `check_messages`.
- PC Codex sent a cross-host reply back through the same tunnel.

The single functional gap that blocked claude-peers retirement, cross-host agent-peers operation, now exists in a default-off, tunnel-based, rollbackable form. Stage 4 should define the shadow duration, measured success gates, and teardown/secret disposition.
