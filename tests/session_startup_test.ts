import { SessionManager } from "../src/sessions/manager.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

const fixturePath = new URL("./fixtures/fake_acp_agent.ts", import.meta.url)
  .pathname;
const absoluteFixturePath = Deno.build.os === "windows"
  ? decodeURIComponent(fixturePath.replace(/^\//, ""))
  : fixturePath;

function managerFor(extra: string[] = [], timeoutMs = 100) {
  return new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        absoluteFixturePath,
        ...extra,
      ],
    },
  }, timeoutMs);
}

Deno.test("startup failures remain session-start failures without registration", async () => {
  for (
    const [argument, expected] of [
      ["--initialize-fail", "Could not start fake:"],
      ["--initialize-exit", "Could not start fake:"],
      ["--session-fail", "Could not start fake:"],
      ["--session-exit", "Could not start fake:"],
    ] as const
  ) {
    const manager = managerFor([argument]);
    try {
      let failure = "";
      try {
        await manager.start("fake", Deno.cwd());
      } catch (error) {
        failure = String(error);
      }
      if (!failure.includes(expected) || manager.sessions.size !== 0) {
        throw new Error(
          `${argument} did not fail cleanly: ${failure}; sessions=${manager.sessions.size}`,
        );
      }
    } finally {
      await manager.closeAll();
    }
  }
});

Deno.test("initialize and session creation hangs hit bounded startup timeout", async () => {
  for (const argument of ["--initialize-hang", "--session-hang"]) {
    const manager = managerFor([argument], 40);
    const startedAt = performance.now();
    try {
      let failure = "";
      try {
        await manager.start("fake", Deno.cwd());
      } catch (error) {
        failure = String(error);
      }
      const elapsed = performance.now() - startedAt;
      if (
        !failure.includes("ACP session startup timed out after 40ms") ||
        elapsed > 2_500 || manager.sessions.size !== 0
      ) {
        throw new Error(
          `${argument} was not bounded/cleaned: ${
            JSON.stringify({
              failure,
              elapsed,
              sessions: manager.sessions.size,
            })
          }`,
        );
      }
      if (manager.sessions.size !== 0) {
        throw new Error(`${argument} left a failed start registered`);
      }
    } finally {
      await manager.closeAll();
    }
  }
});

Deno.test("missing launch command does not create a managed session", async () => {
  const manager = new SessionManager({
    missing: { command: "acp-mcp-no-such-fixture-command", args: [] },
  }, 100);
  let failed = false;
  try {
    await manager.start("missing", Deno.cwd());
  } catch {
    failed = true;
  }
  if (!failed || manager.sessions.size !== 0) {
    throw new Error("Missing command left a session registered");
  }
});

Deno.test("run_task reports bounded startup timeout at session_start", async () => {
  const manager = managerFor(["--initialize-hang"], 40);
  const agents = {
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        absoluteFixturePath,
        "--initialize-hang",
      ],
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
      JSON.stringify(result.error) !== JSON.stringify({
          kind: "session_start_failed",
          stage: "session_start",
        }) ||
      manager.sessions.size !== 0
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
