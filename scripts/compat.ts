import process from "node:process";
import { ProcessCommand } from "#proc";
export type CompatAgent = "opencode" | "codex" | "antigravity" | "claude";

const OPT_IN_ENV: Record<CompatAgent, string> = {
  opencode: "ACPMCP_OPENCODE_TEST",
  codex: "ACPMCP_CODEX_TEST",
  antigravity: "ACPMCP_ANTIGRAVITY_TEST",
  claude: "ACPMCP_CLAUDE_TEST",
};

const AGENT_TESTS: Record<CompatAgent, string[]> = {
  opencode: [
    "tests/opencode_integration.test.ts",
    "tests/opencode_idle_timeout.test.ts",
    "tests/opencode_model_discovery.test.ts",
  ],
  codex: ["tests/agent_compatibility_integration.test.ts"],
  antigravity: ["tests/agent_compatibility_integration.test.ts"],
  claude: ["tests/agent_compatibility_integration.test.ts"],
};

export interface CompatInvocation {
  agent: CompatAgent;
  protocol: "v1" | "v2";
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function parseCompatAgent(
  args: string[],
): { agent: CompatAgent; protocol: "v1" | "v2" } | "help" {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    if (args.length > 1) throw new Error("Unexpected arguments after help");
    return "help";
  }
  if (args.length !== 1 && args.length !== 3) {
    throw new Error("Expected an agent ID and optional --protocol v1|v2");
  }
  const agent = args[0] as CompatAgent;
  if (!Object.hasOwn(OPT_IN_ENV, agent)) {
    throw new Error(`Unknown agent '${args[0]}'`);
  }
  let protocol: "v1" | "v2" = "v1";
  if (args.length === 3) {
    if (args[1] !== "--protocol") {
      throw new Error(`Unknown compatibility option '${args[1]}'`);
    }
    if (args[2] !== "v1" && args[2] !== "v2") {
      throw new Error(`Unknown ACP protocol '${args[2]}'; expected v1 or v2`);
    }
    protocol = args[2];
  }
  if (protocol === "v2" && agent !== "claude") {
    throw new Error(`ACP v2 is not confirmed for built-in agent '${agent}'`);
  }
  return { agent, protocol };
}

export function createCompatInvocation(
  agent: CompatAgent,
  protocol: "v1" | "v2" = "v1",
  inheritedEnv: NodeJS.ProcessEnv = { ...process.env },
): CompatInvocation {
  const testControlEnv = Object.fromEntries(
    Object.values(OPT_IN_ENV).map((name) => [name, "0"]),
  );
  testControlEnv[OPT_IN_ENV[agent]] = "1";
  testControlEnv.ACPMCP_COMPAT_PROTOCOL = protocol;
  // Keep the caller's runtime environment (including agent/provider setup)
  // and override only this runner's explicit test-control variables.
  const env = { ...inheritedEnv, ...testControlEnv };
  return {
    agent,
    protocol,
    args: ["--test", ...AGENT_TESTS[agent]],
    env,
  };
}

export function compatHelp(): string {
  return [
    "Run an opt-in LIVE ACP compatibility test (may use provider quota/API billing).",
    "Usage: npm run compat -- <agent> [--protocol v1|v2]",
    "Agents: opencode, codex, antigravity, claude",
    "Requires the selected agent and its provider credentials to be configured.",
    "See README.md for setup. No provider runs without an explicit agent ID.",
  ].join("\n");
}

type Invoke = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

async function invokeNodeTest(args: string[], env: NodeJS.ProcessEnv) {
  const child = new ProcessCommand(process.execPath, {
    args,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await child.status).code;
}

export async function runCompat(
  args: string[],
  invoke: Invoke = invokeNodeTest,
): Promise<number> {
  const selection = parseCompatAgent(args);
  if (selection === "help") {
    console.log(compatHelp());
    return 0;
  }
  const invocation = createCompatInvocation(
    selection.agent,
    selection.protocol,
  );
  console.log(
    `Running LIVE ${selection.agent} ACP ${selection.protocol} compatibility test. This may use provider quota or API billing.`,
  );
  return await invoke(invocation.args, invocation.env);
}

if (import.meta.main) {
  try {
    process.exit(await runCompat(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(compatHelp());
    process.exit(2);
  }
}
