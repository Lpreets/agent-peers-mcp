import { describe, expect, test } from "bun:test";
import {
  isLoopbackHost,
  isWildcardHost,
  resolveBrokerBindConfig,
  resolveBrokerClientConfig,
} from "../shared/broker-config.ts";

describe("broker config", () => {
  test("defaults to loopback local mode", () => {
    const cfg = resolveBrokerClientConfig({});
    expect(cfg.brokerUrl).toBe("http://127.0.0.1:7900");
    expect(cfg.remoteMode).toBe(false);
  });

  test("AGENT_PEERS_BROKER_HOST selects remote mode for non-loopback host", () => {
    const cfg = resolveBrokerClientConfig({ AGENT_PEERS_BROKER_HOST: "10.23.1.102" });
    expect(cfg.brokerUrl).toBe("http://10.23.1.102:7900");
    expect(cfg.remoteMode).toBe(true);
  });

  test("non-loopback host remains remote even if AGENT_PEERS_REMOTE is not 1", () => {
    const cfg = resolveBrokerClientConfig({
      AGENT_PEERS_BROKER_HOST: "10.23.1.102",
      AGENT_PEERS_REMOTE: "0",
    });
    expect(cfg.remoteMode).toBe(true);
  });

  test("AGENT_PEERS_BROKER_URL wins over host and port", () => {
    const cfg = resolveBrokerClientConfig({
      AGENT_PEERS_BROKER_HOST: "10.23.1.102",
      AGENT_PEERS_PORT: "7905",
      AGENT_PEERS_BROKER_URL: "http://127.0.0.1:7999/",
      AGENT_PEERS_REMOTE: "1",
    });
    expect(cfg.brokerUrl).toBe("http://127.0.0.1:7999");
    expect(cfg.remoteMode).toBe(true);
  });

  test("IPv6 loopback and wildcard classification are explicit", () => {
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
    expect(isWildcardHost("::0")).toBe(true);
    expect(isLoopbackHost("::")).toBe(false);
  });

  test("bind config defaults loopback and treats wildcard as non-loopback", () => {
    expect(resolveBrokerBindConfig({}).bindHost).toBe("127.0.0.1");
    const cfg = resolveBrokerBindConfig({ AGENT_PEERS_BIND: "::" });
    expect(cfg.bindHost).toBe("::");
    expect(cfg.nonLoopback).toBe(true);
  });
});
