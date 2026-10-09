export type CompatAgent = "opencode" | "codex" | "antigravity" | "claude";

const OPT_IN_ENV: Record<CompatAgent, string> = {
  opencode: "ACPMCP_OPENCODE_TEST",
  codex: "ACPMCP_CODEX_TEST",
  antigravity: "ACPMCP_ANTIGRAVITY_TEST",
  claude: "ACPMCP_CLAUDE_TEST",
};

const AGENT_TESTS: Record<CompatAgent, string[]> = {
  opencode: [
    "tests/opencode_integration_test.ts",
    "tests/opencode_idle_timeout_test.ts",
    "tests/opencode_model_discovery_test.ts",
  ],
  codex: ["tests/agent_compatibility_integration_test.ts"],
  antigravity: ["tests/agent_compatibility_integration_test.ts"],
  claude: ["tests/agent_compatibility_integration_test.ts"],
};

export interface CompatInvocation {
  agent: CompatAgent;
  args: string[];
  env: Record<string, string>;
}

export function parseCompatAgent(args: string[]): CompatAgent | "help" {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    if (args.length > 1) throw new Error("Unexpected arguments after help");
    return "help";
  }
  if (args.length !== 1) throw new Error("Expected exactly one agent ID");
  const agent = args[0] as CompatAgent;
  if (!Object.hasOwn(OPT_IN_ENV, agent)) {
    throw new Error(`Unknown agent '${args[0]}'`);
  }
  return agent;
}

export function createCompatInvocation(agent: CompatAgent): CompatInvocation {
  const env = Object.fromEntries(
    Object.values(OPT_IN_ENV).map((name) => [name, "0"]),
  );
  env[OPT_IN_ENV[agent]] = "1";
  return {
    agent,
    args: [
      "test",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      "--allow-write",
      "--allow-net=opencode.ai",
      ...AGENT_TESTS[agent],
    ],
    env,
  };
}

export function compatHelp(): string {
  return [
    "Run an opt-in LIVE ACP compatibility test (may use provider quota/API billing).",
    "Usage: deno task compat <agent>",
    "Agents: opencode, codex, antigravity, claude",
    "Requires the selected agent and its provider credentials to be configured.",
    "See README.md for setup. No provider runs without an explicit agent ID.",
  ].join("\n");
}

type Invoke = (args: string[], env: Record<string, string>) => Promise<number>;

async function invokeDenoTest(args: string[], env: Record<string, string>) {
  const child = new Deno.Command(Deno.execPath(), {
    args,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await child.status).code;
}

export async function runCompat(
  args: string[],
  invoke: Invoke = invokeDenoTest,
): Promise<number> {
  const agent = parseCompatAgent(args);
  if (agent === "help") {
    console.log(compatHelp());
    return 0;
  }
  const invocation = createCompatInvocation(agent);
  console.log(
    `Running LIVE ${agent} ACP compatibility test. This may use provider quota or API billing.`,
  );
  return await invoke(invocation.args, invocation.env);
}

if (import.meta.main) {
  try {
    Deno.exit(await runCompat(Deno.args));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(compatHelp());
    Deno.exit(2);
  }
}
