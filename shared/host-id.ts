import { hostname } from "node:os";

export function normalizeHostId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function resolveHostId(
  env: Record<string, string | undefined> = process.env,
  hostnameFn: () => string = hostname,
): string | null {
  return normalizeHostId(env.AGENT_PEERS_HOST_ID) ?? normalizeHostId(hostnameFn());
}
