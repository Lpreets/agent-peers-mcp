# Idle Marker Maintenance

The wake layer must fail closed. If a Claude or Codex footer changes and wake
decisions start returning `skipped_not_idle`, do not widen the matcher from a
single live pane capture.

1. Capture the current idle status band and an active status band for the
   affected client.
2. Add both captures under `tests/fixtures/idle-active/`.
3. Update `shared/tmux-wake.ts` only enough for idle fixtures to classify idle
   and active/unknown fixtures to skip.
4. Run:

```bash
bun test tests/tmux-wake.test.ts
```

The classifier intentionally scans only the bottom/status band. Active markers
in transcript history above that band must not contaminate the current state.
Unknown state is not idle.
