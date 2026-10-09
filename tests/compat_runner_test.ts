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

Deno.test("compat runner requires an explicit live target", async () => {
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

Deno.test("compat runner accepts known targets and rejects unknown targets", async () => {
  assertEquals(parseCompatAgent(["claude"]), "claude");
  await assertRejects(
    () => Promise.resolve(parseCompatAgent(["toString"])),
    Error,
  );
  await assertRejects(
    () => Promise.resolve(parseCompatAgent(["codex", "--all"])),
    Error,
  );
});

Deno.test("compat runner selects existing tests and isolates opt-in flags", () => {
  const invocation = createCompatInvocation("antigravity");
  assertEquals(
    invocation.args.at(-1),
    "tests/agent_compatibility_integration_test.ts",
  );
  assertEquals(invocation.env.ACPMCP_ANTIGRAVITY_TEST, "1");
  assertEquals(invocation.env.ACPMCP_OPENCODE_TEST, "0");
  assertEquals(invocation.env.ACPMCP_CODEX_TEST, "0");
  assertEquals(invocation.env.ACPMCP_CLAUDE_TEST, "0");
  assertEquals(createCompatInvocation("opencode").args.slice(-3), [
    "tests/opencode_integration_test.ts",
    "tests/opencode_idle_timeout_test.ts",
    "tests/opencode_model_discovery_test.ts",
  ]);
});

Deno.test("compat runner propagates test process exit code", async () => {
  let passedArgs: string[] = [];
  let passedEnv: Record<string, string> = {};
  const code = await runCompat(["claude"], (args, env) => {
    passedArgs = args;
    passedEnv = env;
    return Promise.resolve(7);
  });
  assertEquals(code, 7);
  assertEquals(
    passedArgs.at(-1),
    "tests/agent_compatibility_integration_test.ts",
  );
  assertEquals(passedEnv.ACPMCP_CLAUDE_TEST, "1");
});
