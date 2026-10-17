import { test } from "node:test";
import process from "node:process";
import { SessionManager } from "../src/sessions/manager.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

const fixturePath = new URL("./fixtures/fake_acp_agent.ts", import.meta.url)
  .pathname;
const absoluteFixturePath =
  process.platform === "win32"
    ? decodeURIComponent(fixturePath.replace(/^\//, ""))
    : fixturePath;

function managerFor(extra: string[] = [], timeoutMs = 100) {
  return new SessionManager(
    {
      fake: {
        command: process.execPath,
        args: [absoluteFixturePath, ...extra],
      },
    },
    timeoutMs,
  );
}

test("startup failures remain session-start failures without registration", async () => {
  for (const [argument, expected] of [
    ["--initialize-fail", "Could not start fake:"],
    ["--initialize-exit", "Could not start fake:"],
    ["--session-fail", "Could not start fake:"],
    ["--session-exit", "Could not start fake:"],
  ] as const) {
    const manager = managerFor([argument]);
    try {
      let failure = "";
      try {
        await manager.start("fake", process.cwd());
      } catch (error) {
        failure = String(error);
      }
      if (!failure.includes(expected) || manager.sessionCount !== 0) {
        throw new Error(
          `${argument} did not fail cleanly: ${failure}; sessions=${manager.sessionCount}`,
        );
      }
    } finally {
      await manager.closeAll();
    }
  }
});

test("initialize and session creation hangs hit bounded startup timeout", async () => {
  for (const argument of ["--initialize-hang", "--session-hang"]) {
    const manager = managerFor([argument], 40);
    const startedAt = performance.now();
    try {
      let failure = "";
      try {
        await manager.start("fake", process.cwd());
      } catch (error) {
        failure = String(error);
      }
      const elapsed = performance.now() - startedAt;
      if (
        !failure.includes("ACP session startup timed out after 40ms") ||
        elapsed > 2_500 ||
        manager.sessionCount !== 0
      ) {
        throw new Error(
          `${argument} was not bounded/cleaned: ${JSON.stringify({
            failure,
            elapsed,
            sessions: manager.sessionCount,
          })}`,
        );
      }
      if (manager.sessionCount !== 0) {
        throw new Error(`${argument} left a failed start registered`);
      }
    } finally {
      await manager.closeAll();
    }
  }
});

test("missing launch command does not create a managed session", async () => {
  const manager = new SessionManager(
    {
      missing: { command: "acp-mcp-no-such-fixture-command", args: [] },
    },
    100,
  );
  let failed = false;
  try {
    await manager.start("missing", process.cwd());
  } catch {
    failed = true;
  }
  if (!failed || manager.sessionCount !== 0) {
    throw new Error("Missing command left a session registered");
  }
});

test("startup stderr is not returned to MCP callers", async () => {
  const canary = `ACP_MCP_TEST_SECRET_${crypto.randomUUID()}`;
  const definition = {
    command: process.execPath,
    args: [absoluteFixturePath, "--stderr-env-canary", "--initialize-exit"],
    env: { ACP_MCP_TEST_SECRET: canary },
  };
  const agents = { fake: definition };
  const manager = new SessionManager(agents, 100);
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  try {
    const reply = await mcp.callTool("start_session", { agentId: "fake" })
      .response;
    const serialized = JSON.stringify(reply);
    if (
      serialized.includes(canary) ||
      !serialized.includes("Could not start fake") ||
      manager.sessionCount
    ) {
      throw new Error("Startup error leaked child stderr or kept a session");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

test("run_task reports bounded startup timeout at session_start", async () => {
  const manager = managerFor(["--initialize-hang"], 40);
  const agents = {
    fake: {
      command: process.execPath,
      args: [absoluteFixturePath, "--initialize-hang"],
    },
  };
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  try {
    const result = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "unused",
      }).response,
    );
    if (
      result.status !== "failed" ||
      JSON.stringify(result.error) !==
        JSON.stringify({
          kind: "session_start_failed",
          stage: "session_start",
        }) ||
      manager.sessionCount !== 0
    ) {
      throw new Error(
        `Unexpected bounded startup result: ${JSON.stringify(result)}`,
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});
