import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  ALLOWED_FANOUT_AGENT_TYPES,
  POSITIVE_CONTROL_AGENT_TYPES,
  SPARK_FAMILY_AGENT_TYPES,
  agentConfigFileName,
  assertExplicitFanoutAgentType,
  hasDisabledAgentPeersOverlay,
} from "../shared/fanout-agent-contract.ts";
import { heartbeatPeer, initDb, pollMessages, registerPeer, sendMessage } from "../broker.ts";

const AGENT_CONFIG_DIR = process.env.CODEX_AGENT_CONFIG_DIR ?? "";
const overlayIntegrationTest = AGENT_CONFIG_DIR ? test : test.skip;

function readAgentConfig(agentType: string): string {
  const path = join(AGENT_CONFIG_DIR, agentConfigFileName(agentType));
  expect(existsSync(path), `missing explicit agent overlay: ${path}`).toBe(true);
  return readFileSync(path, "utf8");
}

test("allowed fanout contract enumerates every explicit helper role", () => {
  expect(ALLOWED_FANOUT_AGENT_TYPES).toEqual([
    "fast_explorer",
    "fast_worker",
    "spark",
    "spark-reviewer",
    "spark-tester",
    "spark-lint-fix",
    "spark-codemod",
    "spark-fixture",
  ]);

  for (const agentType of ALLOWED_FANOUT_AGENT_TYPES) {
    expect(assertExplicitFanoutAgentType(agentType)).toBe(agentType);
  }
});

overlayIntegrationTest("every allowed TOML overlay disables agent-peers", () => {
  for (const agentType of ALLOWED_FANOUT_AGENT_TYPES) {
    expect(hasDisabledAgentPeersOverlay(readAgentConfig(agentType))).toBe(true);
  }
});

overlayIntegrationTest("SPARK_FAMILY canon and TOML overlays match the executable contract", () => {
  const familyPath = join(AGENT_CONFIG_DIR, "SPARK_FAMILY.md");
  expect(existsSync(familyPath), `missing Spark family canon: ${familyPath}`).toBe(true);
  const declared = [...readFileSync(familyPath, "utf8").matchAll(/^- `([^`]+)`:/gm)]
    .map((match) => match[1]);
  expect(declared).toEqual([...SPARK_FAMILY_AGENT_TYPES]);
  for (const agentType of SPARK_FAMILY_AGENT_TYPES) {
    expect(hasDisabledAgentPeersOverlay(readAgentConfig(agentType))).toBe(true);
  }
});

test("bare or unknown agent_type is rejected before fanout", () => {
  expect(() => assertExplicitFanoutAgentType(null)).toThrow(/explicit overlay-equipped agent_type/);
  expect(() => assertExplicitFanoutAgentType(undefined)).toThrow(/explicit overlay-equipped agent_type/);
  expect(() => assertExplicitFanoutAgentType("default")).toThrow(/not approved for fanout/);
});

test("agent-peers overlay check fails closed on missing, enabled, or duplicate values", () => {
  expect(hasDisabledAgentPeersOverlay("[mcp_servers.other]\nenabled = false\n")).toBe(false);
  expect(hasDisabledAgentPeersOverlay("[mcp_servers.agent-peers]\nenabled = true\n")).toBe(false);
  expect(hasDisabledAgentPeersOverlay(
    "[mcp_servers.agent-peers]\nenabled = false\n[mcp_servers.agent-peers]\nenabled = true\n",
  )).toBe(false);
});

overlayIntegrationTest("overlay-disabled positive controls leave parent outbound authorization intact", () => {
  const dbPath = `/tmp/agent-peers-fanout-contract-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const db = initDb(dbPath);
  try {
    const parent = registerPeer(db, {
      peer_type: "codex", host: "lpreet-pco", pid: 100, cwd: "/parent",
      git_root: null, tty: "/dev/pts/parent", summary: "parent",
      name: "contract-parent",
    });
    const receiver = registerPeer(db, {
      peer_type: "claude", host: "lpreet-pco", pid: 101, cwd: "/receiver",
      git_root: null, tty: "/dev/pts/receiver", summary: "receiver",
      name: "contract-receiver",
    });

    for (const agentType of POSITIVE_CONTROL_AGENT_TYPES) {
      expect(assertExplicitFanoutAgentType(agentType)).toBe(agentType);
      expect(hasDisabledAgentPeersOverlay(readAgentConfig(agentType))).toBe(true);
      const sent = sendMessage(db, {
        from_id: parent.id,
        session_token: parent.session_token,
        to_id_or_name: receiver.id,
        text: `parent continuity after ${agentType}`,
      });
      expect(sent.ok).toBe(true);
      expect(() => heartbeatPeer(db, parent.id, parent.session_token)).not.toThrow();
    }

    const received = pollMessages(db, receiver.id, receiver.session_token);
    expect(received.map((message) => message.text)).toEqual(
      POSITIVE_CONTROL_AGENT_TYPES.map((agentType) => `parent continuity after ${agentType}`),
    );
  } finally {
    db.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  }
});
