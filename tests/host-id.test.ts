import { expect, test } from "bun:test";
import { normalizeHostId, resolveHostId } from "../shared/host-id.ts";

test("normalizeHostId trims and lowercases host token", () => {
  expect(normalizeHostId(" Lpreet-PCO ")).toBe("lpreet-pco");
  expect(normalizeHostId("")).toBeNull();
  expect(normalizeHostId("   ")).toBeNull();
});

test("resolveHostId uses AGENT_PEERS_HOST_ID before hostname fallback", () => {
  expect(resolveHostId({ AGENT_PEERS_HOST_ID: " Lpreet-PC " }, () => "other-host")).toBe("lpreet-pc");
  expect(resolveHostId({}, () => "Lpreet-PCO")).toBe("lpreet-pco");
});
