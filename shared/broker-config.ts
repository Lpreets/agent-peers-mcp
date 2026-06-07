import { resolve } from "node:path";
import { DEFAULT_SECRET_PATH } from "./shared-secret.ts";

export const DEFAULT_BROKER_HOST = "127.0.0.1";
export const DEFAULT_BROKER_PORT = 7900;

export interface BrokerClientConfig {
  brokerUrl: string;
  brokerHost: string;
  port: number;
  remoteMode: boolean;
  secretPath: string;
}

export interface BrokerBindConfig {
  bindHost: string;
  nonLoopback: boolean;
  secretPath: string;
}

export function parsePort(value: string | undefined): number {
  const port = parseInt(value ?? String(DEFAULT_BROKER_PORT), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid AGENT_PEERS_PORT: ${value}`);
  }
  return port;
}

export function normalizeHost(host: string): string {
  return host.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "127.0.0.1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
  );
}

export function isWildcardHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "::0";
}

export function resolveSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AGENT_PEERS_SECRET_FILE ?? DEFAULT_SECRET_PATH);
}

export function resolveBrokerClientConfig(env: NodeJS.ProcessEnv = process.env): BrokerClientConfig {
  const port = parsePort(env.AGENT_PEERS_PORT);
  const explicitUrl = env.AGENT_PEERS_BROKER_URL?.trim();
  let brokerUrl: string;
  let brokerHost: string;

  if (explicitUrl) {
    const url = new URL(explicitUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`AGENT_PEERS_BROKER_URL must use http:// or https://, got ${url.protocol}`);
    }
    brokerUrl = url.toString().replace(/\/$/, "");
    brokerHost = url.hostname;
  } else {
    brokerHost = env.AGENT_PEERS_BROKER_HOST?.trim() || DEFAULT_BROKER_HOST;
    brokerUrl = `http://${formatHostForUrl(brokerHost)}:${port}`;
  }

  const explicitRemote = env.AGENT_PEERS_REMOTE === "1";
  const inferredRemote = !isLoopbackHost(brokerHost);
  return {
    brokerUrl,
    brokerHost,
    port,
    remoteMode: explicitRemote || inferredRemote,
    secretPath: resolveSecretPath(env),
  };
}

export function resolveBrokerBindConfig(env: NodeJS.ProcessEnv = process.env): BrokerBindConfig {
  const bindHost = env.AGENT_PEERS_BIND?.trim() || DEFAULT_BROKER_HOST;
  return {
    bindHost,
    nonLoopback: !isLoopbackHost(bindHost),
    secretPath: resolveSecretPath(env),
  };
}

function formatHostForUrl(host: string): string {
  const normalized = host.trim();
  if (normalized.includes(":") && !normalized.startsWith("[")) {
    return `[${normalized}]`;
  }
  return normalized;
}
