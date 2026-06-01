import { test, expect } from "bun:test";
import { checkInitialParentLiveness } from "../shared/parent-liveness.ts";

test("does not mark a live unchanged parent as lost", () => {
  const res = checkInitialParentLiveness(100, 100, () => true);
  expect(res).toEqual({ lost: false, ppidChanged: false });
});

test("marks parent lost when initial parent no longer exists", () => {
  const res = checkInitialParentLiveness(100, 1, () => false);
  expect(res).toEqual({ lost: true, ppidChanged: true });
});

test("marks init-reparented server lost even if initial parent pid was reused", () => {
  const res = checkInitialParentLiveness(100, 1, () => true);
  expect(res).toEqual({ lost: true, ppidChanged: true });
});

test("detects systemd-subreaper reparenting when initial parent is gone", () => {
  const res = checkInitialParentLiveness(100, 200, () => false);
  expect(res).toEqual({ lost: true, ppidChanged: true });
});

test("ppid change alone is corroborating, not fatal", () => {
  const res = checkInitialParentLiveness(100, 200, () => true);
  expect(res).toEqual({ lost: false, ppidChanged: true });
});

test("ignores init-launched processes without a meaningful parent", () => {
  const res = checkInitialParentLiveness(1, 1, () => false);
  expect(res).toEqual({ lost: false, ppidChanged: false });
});
