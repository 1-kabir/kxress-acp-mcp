import { test } from "node:test";
import {
  compatHelp,
  createCompatInvocation,
  parseCompatAgent,
  runCompat,
} from "../scripts/compat.ts";
function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function assertRejects(
  fn: () => Promise<unknown>,
  errorClass: typeof Error,
) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof errorClass) return;
    throw error;
  }
  throw new Error(`Expected ${errorClass.name} rejection`);
}

test("compat runner requires an explicit live target", async () => {
  let invoked = false;
  assertEquals(parseCompatAgent([]), "help");
  assertEquals(parseCompatAgent(["--help"]), "help");
  assert(compatHelp().includes("LIVE"));
  assertEquals(
    await runCompat([], () => {
      invoked = true;
      return Promise.resolve(0);
    }),
    0,
  );
  assertEquals(invoked, false);
});

test("compat runner accepts known targets and rejects unknown targets", async () => {
  assertEquals(parseCompatAgent(["claude"]), {
    agent: "claude",
    protocol: "v1",
  });
  assertEquals(parseCompatAgent(["claude", "--protocol", "v2"]), {
    agent: "claude",
    protocol: "v2",
  });
  await assertRejects(
    () => Promise.resolve(parseCompatAgent(["toString"])),
    Error,
  );
  await assertRejects(
    () => Promise.resolve(parseCompatAgent(["codex", "--all"])),
    Error,
  );
  await assertRejects(
    () => Promise.resolve(parseCompatAgent(["opencode", "--protocol", "v2"])),
    Error,
  );
});

test("compat runner selects existing tests and isolates opt-in flags", () => {
  const invocation = createCompatInvocation("antigravity", "v1", {
    PATH: "fixture-path",
    ANTHROPIC_BASE_URL: "https://provider.invalid",
    OPENROUTER_API_KEY: "FAKE_SECRET_VALUE",
    ACPMCP_CLAUDE_TEST: "1",
  });
  assertEquals(
    invocation.args.at(-1),
    "tests/agent_compatibility_integration.test.ts",
  );
  assertEquals(invocation.env.ACPMCP_ANTIGRAVITY_TEST, "1");
  assertEquals(invocation.env.ACPMCP_OPENCODE_TEST, "0");
  assertEquals(invocation.env.ACPMCP_CODEX_TEST, "0");
  assertEquals(invocation.env.ACPMCP_CLAUDE_TEST, "0");
  assertEquals(invocation.env.PATH, "fixture-path");
  assertEquals(invocation.env.ANTHROPIC_BASE_URL, "https://provider.invalid");
  assertEquals(invocation.env.OPENROUTER_API_KEY, "FAKE_SECRET_VALUE");
  assertEquals(invocation.protocol, "v1");
  assertEquals(invocation.env.ACPMCP_COMPAT_PROTOCOL, "v1");
  assertEquals(
    createCompatInvocation("claude", "v2").env.ACPMCP_COMPAT_PROTOCOL,
    "v2",
  );
  assertEquals(createCompatInvocation("opencode").args.slice(-3), [
    "tests/opencode_integration.test.ts",
    "tests/opencode_idle_timeout.test.ts",
    "tests/opencode_model_discovery.test.ts",
  ]);
});

test("compat runner propagates test process exit code", async () => {
  let passedArgs: string[] = [];
  let passedEnv: NodeJS.ProcessEnv = {};
  const code = await runCompat(["claude", "--protocol", "v2"], (args, env) => {
    passedArgs = args;
    passedEnv = env;
    return Promise.resolve(7);
  });
  assertEquals(code, 7);
  assertEquals(
    passedArgs.at(-1),
    "tests/agent_compatibility_integration.test.ts",
  );
  assertEquals(passedEnv.ACPMCP_CLAUDE_TEST, "1");
  assertEquals(passedEnv.ACPMCP_COMPAT_PROTOCOL, "v2");
});
