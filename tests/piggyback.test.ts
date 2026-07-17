import { test, expect } from "bun:test";
import { formatInboxBlock, formatInboxPreview } from "../shared/piggyback.ts";
import type { LeasedMessage } from "../shared/types.ts";

const m = (id: number, text: string, from_name = "alpha", from_summary = ""): LeasedMessage => ({
  id,
  from_id: "id-" + id,
  from_name,
  from_peer_type: "claude",
  from_cwd: "/x",
  from_summary,
  to_id: "peer-recipient-id-a1b2c3",
  text,
  sent_at: "2026-04-13T00:00:00.000Z",
  lease_token: "tok-" + id,
});

// Queue-replay controls remain in the client/server lanes; this shared
// formatter test intentionally avoids asserting replay logic until a pure seam
// is introduced there.

test("formatInboxBlock returns empty string for no messages", () => {
  expect(formatInboxBlock([])).toBe("");
});

test("formatInboxBlock carries sender identity, colleague framing, and reply guidance", () => {
  const out = formatInboxBlock([m(42, "ping")]);
  // Colleague-tone banner (no more 🚨 / caps-lock flailing).
  expect(out).toContain("PEER INBOX");
  expect(out).toContain("from your colleagues");
  // Full sender identity.
  expect(out).toContain("from: alpha (claude");
  expect(out).toContain("cwd=/x");
  // Unique message id for dedupe + reply referencing.
  expect(out).toContain("message_id: 42");
  // Behavioral rules — each of the four reaction paths must be present.
  expect(out).toContain("answer now"); // question path
  expect(out).toContain("investigate"); // investigate path
  expect(out).toContain("FYI"); // info-only path
  expect(out).toContain("disagree"); // pushback path
  // Anti-pattern explicitly forbidden.
  expect(out).toContain("auto-acknowledge");
  // Body text preserved verbatim.
  expect(out).toContain("ping");
  // Reply action hint.
  expect(out).toContain("send_message(to_id=\"alpha\"");
});

test("formatInboxBlock includes sender summary when provided", () => {
  const out = formatInboxBlock([m(1, "hi", "backend-codex", "refactoring auth middleware")]);
  expect(out).toContain("their current work: refactoring auth middleware");
});

test("formatInboxBlock omits summary line when sender has no summary", () => {
  const out = formatInboxBlock([m(1, "hi", "backend-codex", "")]);
  expect(out).not.toContain("their current work:");
});

test("formatInboxBlock is redaction-safe: no raw identifiers or lease token", () => {
  const msg = m(314, "contains internal ids 123", "edge-peer", "reviewing auth");
  const out = formatInboxBlock([msg]);

  expect(out).toContain(`message_id: ${msg.id}`);
  expect(out).toContain(`from: ${msg.from_name}`);

  expect(out).not.toContain(msg.from_id);
  expect(out).not.toContain(msg.to_id);
  expect(out).not.toContain(msg.lease_token);
});

test("RED: sender_provenance snapshot overrides mutable legacy sender fields", () => {
  const msg = {
    ...m(77, "stale legacy body", "legacy-name", "legacy summary"),
    from_name: "mutable-legacy-name",
    from_peer_type: "claude",
    from_cwd: "/legacy-cwd",
    from_summary: "legacy mutable summary",
    sender_provenance: {
      name: "auth-snapshot-name",
      peer_type: "codex",
      namespace: "team-core",
      cwd: "/secure/cwd",
      summary: "auth-snapshot summary",
      epoch: 42,
    },
  } as any;

  const out = formatInboxBlock([msg]);

  expect(out).toContain("from: auth-snapshot-name (codex, cwd=/secure/cwd)");
  expect(out).toContain("namespace: team-core");
  expect(out).toContain("epoch: 42");
  expect(out).toContain("their current work: auth-snapshot summary");

  expect(out).not.toContain("legacy-name");
  expect(out).not.toContain("legacy mutable summary");
  expect(out).not.toContain("/legacy-cwd");
});

test("RED: missing sender provenance should render UNKNOWN/null, never (gone)/undefined/epoch0", () => {
  const msg = {
    ...m(78, "deregistered user message", "", ""),
    from_name: undefined,
    from_peer_type: undefined,
    from_summary: undefined,
    from_cwd: undefined,
    sender_provenance: {
      name: null,
      peer_type: null,
      namespace: null,
      cwd: null,
      summary: null,
      epoch: null,
    },
  } as any;

  const out = formatInboxBlock([msg]);

  expect(out).toContain("from: UNKNOWN (UNKNOWN, cwd=UNKNOWN)");
  expect(out).toContain("namespace: null");
  expect(out).toContain("epoch: null");
  expect(out).toContain("their current work: null");
  expect(out).not.toContain("(gone)");
  expect(out).not.toContain("claude");
  expect(out).not.toContain("undefined");
  expect(out).not.toContain("epoch: 0");
});

// formatInboxPreview is a security-sensitive function: it must NOT leak
// message content or reply cues into the preview notification channel,
// because the preview path can't update dedupe state and a Codex that
// surfaces both paths would otherwise reply twice. These tests are the
// guard-rail against that regression.

test("formatInboxPreview carries sender identity and pointer to next tool call", () => {
  const msg: LeasedMessage = {
    id: 99,
    from_id: "id-99",
    from_name: "claude-frontend",
    from_peer_type: "claude",
    from_cwd: "/x",
    from_summary: "",
    to_id: "peer-target-99",
    text: "SECRET BODY THAT MUST NOT LEAK INTO PREVIEW",
    sent_at: "2026-04-15T00:00:00.000Z",
    lease_token: "tok-99",
  };
  const out = formatInboxPreview(msg);

  // Sender identity present.
  expect(out).toContain("claude-frontend");
  expect(out).toContain("claude");
  // Pointer to authoritative delivery path present.
  expect(out).toMatch(/\[PEER INBOX\]|check_messages/);
  expect(out).not.toContain(msg.lease_token);
  expect(out).not.toContain(msg.from_id);
  expect(out).not.toContain(msg.to_id);
});

test("formatInboxPreview does NOT include message body (no double-reply risk)", () => {
  const msg: LeasedMessage = {
    id: 1,
    from_id: "id-1",
    from_name: "alpha",
    from_peer_type: "claude",
    from_cwd: "/x",
    from_summary: "",
    to_id: "peer-target-1",
    text: "UNIQUE_BODY_TOKEN_12345",
    sent_at: "2026-04-15T00:00:00.000Z",
    lease_token: "tok-1",
  };
  expect(formatInboxPreview(msg)).not.toContain("UNIQUE_BODY_TOKEN_12345");
});

test("formatInboxPreview does NOT include reply_action / send_message cues", () => {
  const msg: LeasedMessage = {
    id: 1,
    from_id: "id-1",
    from_name: "alpha",
    from_peer_type: "claude",
    from_cwd: "/x",
    from_summary: "",
    to_id: "peer-target-2",
    text: "hi",
    sent_at: "2026-04-15T00:00:00.000Z",
    lease_token: "tok-1",
  };
  const out = formatInboxPreview(msg);
  // If these cues appeared in the preview, a Codex that surfaces the log
  // notification could reply immediately — then see the same message
  // again in the [PEER INBOX] block and reply a second time.
  expect(out).not.toContain("reply_action");
  expect(out).not.toContain("send_message(to_id");
});

test("formatInboxBlock numbers multiple messages and repeats the banner at head + foot", () => {
  const out = formatInboxBlock([m(1, "a"), m(2, "b", "beta")]);
  expect(out).toContain("message 1 of 2");
  expect(out).toContain("message 2 of 2");
  expect(out).toContain("send_message(to_id=\"alpha\"");
  expect(out).toContain("send_message(to_id=\"beta\"");
  // Banner present at top AND bottom for summarization resilience.
  const bannerCount = (out.match(/PEER INBOX/g) ?? []).length;
  expect(bannerCount).toBeGreaterThanOrEqual(2);
});
