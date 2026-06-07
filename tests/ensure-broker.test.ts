import { expect, test } from "bun:test";
import { ensureBroker } from "../shared/ensure-broker.ts";

test("ensureBroker does not spawn a local broker in remote mode", async () => {
  await expect(ensureBroker(
    async () => false,
    new URL("../broker.ts", import.meta.url).href,
    { remoteMode: true, brokerUrl: "http://127.0.0.1:7999" },
  )).rejects.toThrow(/remote mode disables local broker auto-spawn/);
});

test("ensureBroker returns immediately when broker is already alive in remote mode", async () => {
  await expect(ensureBroker(
    async () => true,
    new URL("../broker.ts", import.meta.url).href,
    { remoteMode: true, brokerUrl: "http://127.0.0.1:7999" },
  )).resolves.toBeUndefined();
});
