# S310 Fix 1 — Broker-side idle-safe wake layer (DESIGN, design-to-park)

> **Status:** RATIFIED FOR IMPLEMENTATION (operator 2026-06-07 S310: "Ratify → implement behind flag"). Bilateral (Claude `zany-kiwi` + Codex `jolly-moose`, DP1 locked). **HIGH-BLAST** (shared agent-peers transport). **Implementation constraint (operator-set): feature flag stays `off` — NO enabled behavior lands; log-only pilot is a separate later step needing its own go-ahead.** Full acceptance matrix (incl. live active-pane non-injection test) required before any flag flip.

### Identity resolution (DP2 RESOLVED — jolly-moose 7478)
`pane_current_path == registry.cwd` is a STRONG signal but NOT hard equality (agents legitimately `cd` within the repo). Spec:
- **Primary identity:** exact `tty` match + registry id/name/title match (`pane_title == peer:<name>` or equivalent) + live pane process belongs to expected client family.
- **Cwd = scoped validation:** accept exact cwd OR cwd under registered project/git_root. Pane cwd OUTSIDE registered root → `skipped_scope_mismatch` (fail-closed on out-of-scope, avoids false skips on legit subdir cd).
- Registry has only cwd, no git_root → derive root from TSV / registration cwd, allow subpaths.
- Title/name missing but tty exact + cwd in-scope → pilot `would_wake_low_confidence`; require a SECOND identity signal before `on` mode.

## Problem (root cause, confirmed in code)
`agent-peers` is poll-based: `sendMessage` (`broker.ts:440`) is a pure durable DB insert; `pollMessages` (`broker.ts:493`) is the ONLY writer of `last_seen`. An **idle peer never takes a turn → never polls → never sees the row** until externally tmux-woken. Neither client can wake itself: `claude-server.ts:91` (idle Claude queues the channel push until next turn), `codex-server.ts:126` (Codex CLI never surfaces mid-task MCP push). So the wake must originate from the **broker daemon**, which already runs a long-lived process with a background timer (`gcTimer`, `broker.ts:824`).

## Architecture (Claude half)

### Placement — in-daemon wake queue + debounce drain
- The daemon is `Bun.serve` (`broker.ts:826`) and already owns a periodic background worker (`gcTimer`). Add a **second interval-driven worker** + an **in-memory wake queue** (`Map<to_id, {firstQueuedAt, lastQueuedAt, count}>`).
- **Hook point:** `broker.ts:849` `/send-message` route. After `sendMessage` returns `ok:true`, **fire-and-forget enqueue** `to_id` into the wake queue — NEVER awaited before the HTTP response returns. Delivery latency/success is completely independent of the wake path.
- **Drain:** a `setInterval(WAKE_DRAIN_MS)` worker pops due entries (per-target debounce satisfied) and runs the validate→nudge pipeline. Coalesces bursts: N messages to the same idle peer within the quiet window → exactly 1 nudge.
- **Restart semantics (v1, accepted):** the queue is in-memory; a daemon restart drops it, but messages are durable in SQLite and remain pollable. No reconcile pass in v1 (the next message re-triggers a wake). Documented limitation, not a silent gap.

### Idle-PROOF validation (positive evidence, never absence-of-busy)
Run BEFORE any keystroke. The stored `peers.tty` is a **candidate only**:
1. **Live pane mapping** — `tmux list-panes -a -F '#{pane_tty} #{pane_id} #{pane_pid} #{pane_current_command} #{pane_title}'`; find the pane whose `pane_tty == peers.tty`. None → `wake_skipped: tty_no_live_pane`.
2. **Identity confirm** — pane must map to the SAME peer (pid lineage OR cwd/title match) — guards stale/duplicate-peer + tty-reuse (the S310 duplicate-MCP-child class). Mismatch → `wake_skipped: tty_identity_mismatch`.
3. **Positive idle proof** — require affirmative idle evidence (exact signals = Codex's half to validate on disposable panes): shell is foreground (`pane_current_command` is the shell, not a child) AND a `capture-pane` tail shows the client's idle-prompt marker (Claude prompt box / Codex prompt footer) AND no in-flight turn indicator. Cannot positively prove idle → `wake_skipped: idle_unprovable` (leave the durable message pending; do NOT wake).
4. **Active-pane NON-injection (acceptance #2, the keystone safety property)** — the inverse of the S310 bug. NEVER `send-keys` when the pane shows a running command or active model turn. This must be **proven by test against a genuinely-busy fixture pane**, not trusted from a single `pane_current_command` snapshot.

### Debounce / coalesce
Per-target ≤1 wake per `WAKE_QUIET_WINDOW_MS`. Burst of N → 1 nudge. Prevents nudge-storms when a peer is flooded.

### Feature flag (`AGENT_PEERS_WAKE_MODE`)
- `off` (default) — wake layer inert; behavior identical to today.
- `log-only` (pilot) — run validate pipeline, emit structured `wake_decision` logs (`would_wake` | `wake_skipped:<reason>`), send **zero** keystrokes. This gathers evidence the validation is correct BEFORE any real nudge.
- `on` — validate + debounced nudge.
- **No secrets / no message body in wake logs** — only `to_id`, decision, reason, target tty.

### Failure isolation
Entire wake path wrapped: any throw → log + continue. Delivery already returned 200; a tmux failure never touches messaging. Do NOT use `last_seen` for idleness (poll-driven + clock-skewed per S308) — live pane evidence only.

## Acceptance matrix (all green before flip)
- **T1** idle peer (Claude / Codex) receives msg → processes within N sec, no manual wake. (on-mode, disposable panes)
- **T2** ACTIVE-pane non-injection — busy pane (running command OR mid-turn) → ZERO keystrokes injected (assert capture-pane unchanged + no new turn). Fixture must be genuinely busy.
- **T3** delivery-independence — wake path throws (mock tmux fail) → `sendMessage` still `ok:true`, msg in DB.
- **T4** stale/duplicate-peer + tty-mismatch → `wake_skipped`, no misfire (two peers, reused tty).
- **T5** no regression — existing `broker.test.ts` + `e2e-live-delivery.test.ts` pass.
- **T6** debounce — N messages in window → exactly 1 wake.
- **T7** log-only emits decisions + sends zero keys.

## Codex half (jolly-moose) — DP1 LOCKED (agent-peers 7476)

### Locked interface (broker worker → wake mechanism)
```
wake_peer_if_idle(peer_id, peer_type, cwd, tty, expected_title_prefix?, reason_id)
  -> woke | skipped_active | skipped_no_pane | skipped_ambiguous | skipped_not_idle | error
```
Contract: `tty` is a candidate only — resolve live pane by `pane_tty`, then require `pane_current_path == cwd` AND (`pane_title == peer:<name>` or registry name/tty match); 0 or >1 matches → skip. Positive idle proof from visible `capture-pane` (not `pane_current_command`). Never injects message body/free-form text — only a fixed content-free nudge. Any active marker → skip, leave durable msg pending. Every non-`woke` return = non-fatal telemetry (delivery already committed). Wake logs carry peer id/name, tty, cwd, result, reason_id, idle-proof summary — NO message text.

### Idle proof (Codex-specified, ADOPTED) — require TWO stable samples ~1s apart
- **Claude idle:** footer has `bypass permissions on` OR `Context N%` AND no active marker.
- **Codex idle:** footer has `gpt-5.*Context N%` (with/without `left`, per 0.137) AND no active marker.
- **Active markers (skip if ANY visible):** `esc to interrupt | Working \( | tool_use | Bash\( | Running | Thinking | Messages to be submitted | Do you want to` (+ Codex: `Update available | Hooks need review`).
- Two stable idle samples ~1s apart before sending keys (race-close vs single snapshot).

### Wake mechanism by client (content-free)
- **Codex:** `send-keys F4 || true` → `send-keys -l 'Check agent-peers now.'` → sleep ~1s → `Enter` (F4 = existing Codex wake canon; separate Enter per Codex staged-text behavior).
- **Claude:** `send-keys -l 'Check agent-peers now.'` → `Enter` (no F4).

### Active-pane non-injection proof (3 layers; acceptance gate = layer 2)
1. **Mechanical marker fixtures** — panes displaying captured fixtures containing each active marker → assert `skipped_not_idle` + pane buffer/capture unchanged.
2. **Live active-model test** — disposable Claude/Codex pane on a long prompt/tool action; attempt wake while footer shows `esc to interrupt` → assert skip + no typed text appears. **This is the real gate; `pane_current_command` alone is insufficient.**
3. **Stale/duplicate safety** — two panes, same cwd, one matching tty → wakes only one; two matching candidates → `skipped_ambiguous`.

### Open risk (honestly recorded)
Any tmux text injection IS an external model turn. Acceptable only behind feature-flag/log-only first + debounce/coalesce + the layer-2 non-injection test. No currently-verified client-side API alternative for zero-keystroke wake.

## Implementation status (behind flag, default off — NO enabled behavior landed)
- **Claude half (DONE):** `shared/types.ts` seam (WakeMode/WakeResult/WakeTarget/WakeDecision/WakePeerIfIdle + SendMessageResponse.to_id); `shared/wake-worker.ts` (in-memory queue + setInterval drain + per-target debounce/coalesce + max-wait starvation cap + AGENT_PEERS_WAKE_MODE flag + structured WakeDecision logging, getPeer injected to avoid broker↔worker cycle); `broker.ts` hook (fire-and-forget enqueue after /send-message ok:true at the route; `to_id` surfaced from the existing `RETURNING`; worker start + cleanup stop). Tests `tests/wake-worker.test.ts` (8): off-noop, debounce-coalesce, max-wait cap, delivery-independence (throwing mechanism never throws out), peer-gone, fresh-row target, telemetry-no-body. Production tsc 0 errors; full suite **117 pass / 0 fail**.
- **Codex half (DONE):** `shared/tmux-wake.ts` (`wakePeerIfIdle`) + `tests/tmux-wake.test.ts` (9). off/log-only/on, per-client nudge, mechanical active-marker no-injection, scope-mismatch, dup-tty ambiguity, low-confidence identity, catch-to-error.

## DP gates
- **DP1** interface lock (worker↔mechanism contract) — ✅ LOCKED (both halves converge, zero conflict).
- **DP2** mutual cross-RV — ✅ EXCHANGED. Claude→Codex (agent-peers 7484): PASS-with-findings. 1 MAJOR (keystone TOCTOU: ~1-2s unguarded gap between idle-proof and send-keys → add a pre-keystroke active-marker recheck) + 2 MAJOR-to-VERIFY via live test (commandMatches `pane_current_command===peer_type` and `pane_title===peer:<name>` must be empirically true or on-mode is inert; both fail-safe, not misfire) + 1 MINOR (CODEX_IDLE greedy match + full-pane scan → tighten to last ~3-5 lines / footer anchor). All non-TOCTOU findings are fail-safe (worst case = missed wake, never wrong-pane injection).
- **REMAINING before any flag flip / log-only pilot:** (a) TOCTOU pre-keystroke recheck (Codex) + Claude RV of the patch; (b) the **live active-model non-injection test** (acceptance gate #2 — `pane_current_command` alone insufficient); (c) live verification of the two MAJOR-to-VERIFY identity signals. Then: separate operator go-ahead for the log-only pilot.
- **DP2** design cross-RV (both halves) → spec.
- **DP3** operator ratification (HIGH-BLAST) — REQUIRED before any code.
- Then: implement behind flag → log-only pilot → evidence → enable.

## Provenance
S310; `tasks/s310-permanent-fix-peer-handoff-reliability.md` FIX 1; root cause `broker.ts:440/493`, `claude-server.ts:91`, `codex-server.ts:126`; S308 D6 (invariant = boundary policy); clock-skew caveat `tasks/s308-agent-peers-clock-skew-infra-bug.md`.
