# S311 Stage 4 Persistent PC Shadow Setup

Date: 2026-06-07
Owner: Codex PC-side execution, Claude PCO-side receiver verification
Status: PASS for persistent shadow setup and tunnel drop-recovery

## Scope

Operator authorized Stage 4 PC-side work to make the Stage 3 tunnel path persistent enough for shadow operation. This setup keeps the PCO broker loopback-bound and does not restart, reconfigure, or replace it.

No PCO firewall change, direct LAN bind, claude-peers decommission, production cutover, or fork merge was performed.

## Code Under Test

PC and PCO checkouts stayed on the Stage 2/3 branch:

```text
repo: /home/lpreet/Projects/MSAASA_Projects/agent-peers-mcp
branch: fix/s311-agent-peers-crosshost-default-off
commit: dcb04e4
remote: origin/fix/s311-agent-peers-crosshost-default-off
```

PC checkout:

```text
path: /home/lpreet/Projects/agent-peers-mcp
branch: fix/s311-agent-peers-crosshost-default-off
commit: dcb04e4
```

## Connectivity

PC has the required SSH alias for the persistent tunnel:

```text
PC alias: Lpreet-PCO
HostName: 10.23.1.102
User: lpreet
IdentityFile: ~/.ssh/Lpreet-PCO
Port: 2222
```

PCO-side execution used the existing PC alias:

```text
PC alias from PCO: Lpreet-PC
```

Raw `lpreet@10.23.1.101 -p2221` was not used for Stage 4 because it does not select the correct key on this host.

## Secret

The PC secret is retained for the shadow lane and was not printed:

```text
path: /home/lpreet/.config/agentic/secrets.d/agent-peers-pco.secret
mode: 600
```

## Persistent Tunnel Unit

Stage 4 uses a PC user `systemd` unit around plain `ssh -N -L`. `autossh` was not installed, so restart behavior is owned by systemd.

```text
unit: ~/.config/systemd/user/agent-peers-pco-tunnel.service
enabled: yes
linger: yes
```

Unit content:

```ini
[Unit]
Description=MSAASA S311 agent-peers PCO tunnel for PC shadow
Documentation=/home/lpreet/Projects/agent-peers-mcp/ops/s311-stage4-shadow-setup.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ssh -NT -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:17900:127.0.0.1:7900 Lpreet-PCO
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Important implementation note: `ClearAllForwardings=yes` was tried and removed because it suppressed the explicit `-L` forward. `ControlMaster=no` and `ControlPath=none` keep the service process resident instead of exiting into an existing SSH master connection.

## Environment Isolation

The persistent systemd unit only creates the tunnel. It does not globally set agent-peers remote-client env.

Stage 4 shadow clients run in a dedicated PC tmux session:

```text
session: MSAASA_STAGE4
cwd: /home/lpreet/Projects/MSAASA
```

Claude pane:

```text
claude --dangerously-load-development-channels server:claude-peers server:agent-peers
```

Codex pane:

```text
codex -C /home/lpreet/Projects/MSAASA \
  -c 'mcp_servers.agent-peers.env={ "AGENT_PEERS_ENABLED" = "1", "AGENT_PEERS_REMOTE" = "1", "AGENT_PEERS_BROKER_URL" = "http://127.0.0.1:17900", "AGENT_PEERS_SECRET_FILE" = "/home/lpreet/.config/agentic/secrets.d/agent-peers-pco.secret", "PATH" = "/home/lpreet/.bun/bin:/home/lpreet/.volta/bin:/usr/local/bin:/usr/bin:/bin" }'
```

This avoids global PC `~/.codex/config.toml` mutation. An earlier inherited-env Codex launch spawned an accidental local PC broker on `127.0.0.1:7900`; that local broker was killed and the Codex pane was relaunched with the explicit config override above.

## Runtime Evidence

Persistent tunnel before drop-recovery:

```text
ActiveState=active
SubState=running
MainPID=1147636
NRestarts=0
health={"ok":true,"pid":2006500}
LISTEN 127.0.0.1:17900 users:(("ssh",pid=1147636,fd=4))
```

PCO broker evidence:

```text
health pid through tunnel: 2006500
PCO broker remained loopback-bound on 127.0.0.1:7900
PCO broker was not restarted during Stage 4
```

PC tmux evidence:

```text
MSAASA_STAGE4:0.0 pid=1147977 active=0 cmd=claude cwd=/home/lpreet/Projects/MSAASA
MSAASA_STAGE4:0.1 pid=1153819 active=1 cmd=codex cwd=/home/lpreet/Projects/MSAASA
```

Peer registration observed from PCO broker:

```text
cozy-dodo (claude)
  CWD: /home/lpreet/Projects/MSAASA
  Summary: PC_STAGE4_SHADOW_CLAUDE tunnel=systemd-user pco-broker=127.0.0.1:7900 via local 17900

quiet-finch (codex)
  CWD: /home/lpreet/Projects/MSAASA
  Summary: PC_STAGE4_SHADOW_CODEX tunnel=systemd-user pco-broker=127.0.0.1:7900 via local 17900
```

Message evidence:

```text
PCO Codex -> PC Codex quiet-finch: delivered to PC Codex durable inbox.
PC Codex quiet-finch -> PCO Claude fuzzy-drake: arrived through agent-peers after PC Codex called check_messages.
```

## Drop-Recovery Gate

Codex killed only the PC-side SSH tunnel process and let the user systemd unit recover it:

```text
before MainPID=1147636 NRestarts=0
after ActiveState=active SubState=running MainPID=1158298 NRestarts=1
health={"ok":true,"pid":2006500}
LISTEN 127.0.0.1:17900 users:(("ssh",pid=1158298,fd=4))
```

Verdict: PASS. The tunnel recovered under systemd with a new SSH process, incremented restart count, restored local listener, and successful health probe to the unchanged PCO broker.

The short drop did not stale-GC the PC shadow peer rows. That is acceptable for this gate: the recovery proof is the process restart plus restored health/listener, not peer expiry.

## Rollback

Rollback is bounded to PC:

1. Stop the shadow pair:

```bash
ssh Lpreet-PC 'tmux kill-session -t MSAASA_STAGE4'
```

2. Disable and stop the persistent tunnel:

```bash
ssh Lpreet-PC 'systemctl --user disable --now agent-peers-pco-tunnel.service'
```

3. Remove the unit if Stage 4 is abandoned:

```bash
ssh Lpreet-PC 'rm -f ~/.config/systemd/user/agent-peers-pco-tunnel.service && systemctl --user daemon-reload'
```

4. Remove the PC secret only if no further shadow/pilot is planned:

```bash
ssh Lpreet-PC 'rm -f ~/.config/agentic/secrets.d/agent-peers-pco.secret'
```

## Constraints Honored

- PCO broker was not restarted.
- PCO broker stayed loopback-bound.
- No PCO firewall/listener change.
- No direct LAN bind.
- No claude-peers retirement or decommission.
- PC remote-client env was scoped to the Stage 4 shadow clients, not global shell rc.
- PC global Claude/Codex config was not patched for Stage 4.
- Secret contents were not printed in logs/evidence.

## Verdict

Stage 4 persistent PC shadow PASS:

- PC user systemd maintains a persistent SSH tunnel from `127.0.0.1:17900` to the PCO loopback broker.
- PC Claude and PC Codex shadow peers register through that tunnel.
- Cross-host Codex durable-inbox delivery works through the shadow route.
- Tunnel drop-recovery passed without PCO broker mutation.

Recommended next decision: keep shadow running for a bounded observation window, then decide whether to promote, keep as fallback, or roll back.
