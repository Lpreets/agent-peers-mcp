export const SPARK_FAMILY_AGENT_TYPES = [
  "spark",
  "spark-reviewer",
  "spark-tester",
  "spark-lint-fix",
  "spark-codemod",
  "spark-fixture",
] as const;

export const ALLOWED_FANOUT_AGENT_TYPES = [
  "fast_explorer",
  "fast_worker",
  ...SPARK_FAMILY_AGENT_TYPES,
] as const;

export const POSITIVE_CONTROL_AGENT_TYPES = [
  "fast_explorer",
  "fast_worker",
  "spark",
] as const;

export type AllowedFanoutAgentType = typeof ALLOWED_FANOUT_AGENT_TYPES[number];

const ALLOWED = new Set<string>(ALLOWED_FANOUT_AGENT_TYPES);

export function assertExplicitFanoutAgentType(
  agentType: string | null | undefined,
): AllowedFanoutAgentType {
  if (!agentType) {
    throw new Error("fanout requires an explicit overlay-equipped agent_type");
  }
  if (!ALLOWED.has(agentType)) {
    throw new Error(`agent_type ${JSON.stringify(agentType)} is not approved for fanout`);
  }
  return agentType as AllowedFanoutAgentType;
}

export function agentConfigFileName(agentType: string): string {
  const approved = assertExplicitFanoutAgentType(agentType);
  return approved === "fast_explorer"
    ? "fast-explorer.toml"
    : approved === "fast_worker"
      ? "fast-worker.toml"
      : `${approved}.toml`;
}

/**
 * Narrow TOML contract check. It intentionally recognizes only a literal
 * `enabled = false` inside `[mcp_servers.agent-peers]`; missing, inherited,
 * malformed, or true values all fail closed.
 */
export function hasDisabledAgentPeersOverlay(toml: string): boolean {
  let inAgentPeersSection = false;
  let sawDisabled = false;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inAgentPeersSection = line === "[mcp_servers.agent-peers]";
      continue;
    }
    if (inAgentPeersSection && /^enabled\s*=/.test(line)) {
      if (sawDisabled || !/^enabled\s*=\s*false(?:\s*#.*)?$/.test(line)) return false;
      sawDisabled = true;
    }
  }
  return sawDisabled;
}
