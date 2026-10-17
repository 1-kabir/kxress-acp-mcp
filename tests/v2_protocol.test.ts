import { test } from "node:test";
import process from "node:process";
import * as nodeFs from "#fs";
import { loadAgents } from "../src/agents/config.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

function fixturePath() {
  const path = new URL("./fixtures/fake_acp_v2_agent.ts", import.meta.url)
    .pathname;
  return process.platform === "win32"
    ? decodeURIComponent(path.replace(/^\//, ""))
    : path;
}

function v1FixturePath() {
  const path = new URL("./fixtures/fake_acp_agent.ts", import.meta.url)
    .pathname;
  return process.platform === "win32"
    ? decodeURIComponent(path.replace(/^\//, ""))
    : path;
}

function managerFor(
  protocol: "v1" | "v2" = "v2",
  extra: string[] = [],
  env?: Record<string, string>,
) {
  return new SessionManager({
    fake: {
      command: process.execPath,
      args: [fixturePath(), ...extra],
      acpProtocol: protocol,
      env,
    },
  });
}

test("ACP v2 normalizes config, mode, streaming, snapshots, and unknown updates", async () => {
  const cwd = await nodeFs.makeTempDir({ prefix: "acp-mcp-v2-" });
  const manager = managerFor();
  try {
    const session = await manager.start(
      "fake",
      cwd,
      {
        model: "fake-v2-model",
        "boolean-option": "true",
      },
      "act",
    );
    if (
      session.acpProtocol !== "v2" ||
      !session.configOptions.some((option) => option.id === "model") ||
      session.modes?.currentModeId !== "act"
    ) {
      throw new Error(
        `ACP v2 config/mode data was not normalized: ${JSON.stringify({
          options: session.configOptions,
          modes: session.modes,
        })}`,
      );
    }
    const prompt = await manager.prompt(session.id, "snapshot");
    if (prompt.text !== "replacement" || prompt.stopReason !== "end_turn") {
      throw new Error(`Unexpected v2 completion: ${JSON.stringify(prompt)}`);
    }
    const events = manager.getEvents(session.id).events;
    if (
      !events.some((event) => event.kind === "_future_v2_update") ||
      !events.some((event) => event.kind === "state_update")
    )
      throw new Error("V2 raw/unknown updates were not journaled");
    await manager.setConfigOption(session.id, "model", "fake-v2-model");
    const mode = await manager.setMode(session.id, "plan");
    if (mode?.currentModeId !== "plan") {
      throw new Error("ACP v2 mode config mapping failed");
    }
  } finally {
    await manager.closeAll();
    await nodeFs.removePath(cwd, { recursive: true });
  }
});

test("ACP v2 prompt acknowledgement is not turn completion", async () => {
  const manager = managerFor();
  try {
    const session = await manager.start("fake", process.cwd());
    const prompt = manager.beginPrompt(session.id, "delayed-completion");
    let sawStreamedOutput = false;
    for (let i = 0; i < 100; i++) {
      const events = manager.getEvents(session.id).events;
      sawStreamedOutput = events.some(
        (event) => event.kind === "agent_message_chunk",
      );
      if (sawStreamedOutput) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!sawStreamedOutput) {
      throw new Error("V2 streamed output did not arrive after prompt ack");
    }
    if (prompt.state !== "running") {
      throw new Error(`V2 prompt completed before idle state: ${prompt.state}`);
    }
    await prompt.done;
    const events = manager.getEvents(session.id).events;
    if (
      String(prompt.state) !== "completed" ||
      prompt.stopReason !== "end_turn" ||
      prompt.text !== "still working then done" ||
      events.filter((event) => event.kind === "state_update").length < 2
    ) {
      throw new Error(
        `V2 idle completion was not observed: ${JSON.stringify({
          state: prompt.state,
          stopReason: prompt.stopReason,
          text: prompt.text,
          events,
        })}`,
      );
    }
  } finally {
    await manager.closeAll();
  }
});

test("ACP v2 permission requests use the generic permission policy", async () => {
  const manager = managerFor();
  try {
    const session = await manager.start(
      "fake",
      process.cwd(),
      {},
      undefined,
      "read_only",
    );
    const result = await manager.prompt(session.id, "permission");
    if (!result.text.includes("reject")) {
      throw new Error(
        `ACP v2 command permission was not denied: ${result.text}`,
      );
    }
    const permission = manager
      .getEvents(session.id)
      .events.find((event) => event.kind === "permission_request");
    if (!permission) throw new Error("V2 permission request was not journaled");
  } finally {
    await manager.closeAll();
  }
});

test("ACP v2 idle error state becomes a structured prompt failure", async () => {
  const manager = managerFor();
  try {
    const session = await manager.start("fake", process.cwd());
    const prompt = manager.beginPrompt(session.id, "error");
    await prompt.done;
    if (
      prompt.state !== "failed" ||
      prompt.stopReason !== "error" ||
      prompt.error !== "fixture prompt error" ||
      prompt.errorCode !== -32042 ||
      JSON.stringify(prompt.errorData) !== JSON.stringify({ kind: "test" })
    ) {
      throw new Error(
        `ACP v2 error state was not normalized: ${JSON.stringify({
          state: prompt.state,
          stopReason: prompt.stopReason,
          error: prompt.error,
          errorCode: prompt.errorCode,
          errorData: prompt.errorData,
          events: manager.getEvents(session.id).events,
        })}`,
      );
    }
  } finally {
    await manager.closeAll();
  }
});

test("ACP v2 cancellation waits for its idle completion update", async () => {
  const manager = managerFor();
  try {
    const session = await manager.start("fake", process.cwd());
    const prompt = manager.beginPrompt(session.id, "wait");
    for (let i = 0; i < 50; i++) {
      if (
        manager
          .getEvents(session.id)
          .events.some(
            (event) =>
              (event.update as { state?: string })?.state === "running",
          )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = await manager.cancelPrompt(session.id, prompt.id);
    if (result.state !== "cancelled" || result.stopReason !== "cancelled") {
      throw new Error(`V2 cancellation did not complete: ${result.state}`);
    }
  } finally {
    await manager.closeAll();
  }
});

test("unknown ACP v2 updates reset run_task's idle timeout", async () => {
  const cwd = await nodeFs.makeTempDir({ prefix: "acp-mcp-v2-activity-" });
  const agents = {
    fake: {
      command: process.execPath,
      args: [fixturePath()],
      acpProtocol: "v2" as const,
    },
  };
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  try {
    const result = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "activity",
        cwd,
        idleTimeoutMs: 100,
      }).response,
    );
    if (
      result.status !== "completed" ||
      result.response !== "activity kept the task alive"
    ) {
      throw new Error(
        `ACP v2 activity did not reset the idle timeout: ${JSON.stringify(
          result,
        )}`,
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
    await nodeFs.removePath(cwd, { recursive: true });
  }
});

test("ACP v2 adapter maps load_session to session/resume", async () => {
  const manager = managerFor();
  try {
    const session = await manager.load("fake", "existing-id", process.cwd());
    if (
      session.acpSessionId !== "existing-id" ||
      session.acpProtocol !== "v2"
    ) {
      throw new Error("ACP v2 resume did not retain the session ID");
    }
  } finally {
    await manager.closeAll();
  }
});

test("Claude built-in v2 selection applies profile launch metadata", async () => {
  const dir = await nodeFs.makeTempDir({
    prefix: "acp-mcp-claude-v2-profile-",
  });
  const configPath = `${dir}/config.json`;
  await nodeFs.writeText(
    configPath,
    JSON.stringify({
      agents: {
        claude: {
          command: process.execPath,
          args: [fixturePath(), "--expect-claude-v2-env"],
          acpProtocol: "v2",
        },
      },
    }),
  );
  const agents = await loadAgents(configPath);
  const manager = new SessionManager(agents);
  try {
    const session = await manager.start("claude");
    if (session.acpProtocol !== "v2") {
      throw new Error("Claude's configured ACP v2 protocol was not selected");
    }
  } finally {
    await manager.closeAll();
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("agent launch composes inherited, user, and protocol environment", async () => {
  const dir = await nodeFs.makeTempDir({ prefix: "acp-mcp-env-compose-" });
  const configPath = `${dir}/config.json`;
  const parentKey = "ACPMCP_FIXTURE_PARENT_VALUE";
  const previousParentValue = process.env[parentKey];
  process.env[parentKey] = "parent-runtime";
  await nodeFs.writeText(
    configPath,
    JSON.stringify({
      agents: {
        claude: {
          command: process.execPath,
          args: [fixturePath(), "--expect-composed-launch-env"],
          acpProtocol: "v2",
          env: {
            ACPMCP_FIXTURE_USER_VALUE: "user-config",
            OPENROUTER_API_KEY: "FAKE_SECRET_VALUE",
            CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: "user-override",
          },
        },
      },
    }),
  );
  const agents = await loadAgents(configPath);
  const manager = new SessionManager(agents);
  try {
    const session = await manager.start("claude");
    if (session.acpProtocol !== "v2") {
      throw new Error("Configured protocol was not retained");
    }
  } finally {
    await manager.closeAll();
    if (previousParentValue === undefined) delete process.env[parentKey];
    else process.env[parentKey] = previousParentValue;
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("built-in profile protocol mismatch is rejected before spawning", async () => {
  const dir = await nodeFs.makeTempDir({ prefix: "acp-mcp-v2-profile-" });
  const marker = `${dir}/launches.txt`;
  const manager = new SessionManager({
    builtIn: {
      command: process.execPath,
      args: [fixturePath()],
      acpProtocol: "v2",
      supportedProtocols: ["v1"],
      env: { ACPMCP_V2_FIXTURE_LAUNCH_MARKER: marker },
    },
  });
  try {
    let rejected = false;
    try {
      await manager.start("builtIn");
    } catch (error) {
      rejected = String(error).includes("does not confirm ACP v2 support");
    }
    let launched = true;
    try {
      await nodeFs.stat(marker);
    } catch (error) {
      if (nodeFs.isErrorCode(error, "ENOENT")) launched = false;
      else throw error;
    }
    if (!rejected || launched) {
      throw new Error("Unconfirmed built-in ACP v2 was spawned");
    }
  } finally {
    await manager.closeAll();
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("ACP v2 protocol mismatch fails without retrying v1", async () => {
  const dir = await nodeFs.makeTempDir({ prefix: "acp-mcp-v2-mismatch-" });
  const marker = `${dir}/launches.txt`;
  const manager = managerFor("v2", ["--v1-only"], {
    ACPMCP_V2_FIXTURE_LAUNCH_MARKER: marker,
  });
  try {
    let message = "";
    try {
      await manager.start("fake", process.cwd());
    } catch (error) {
      message = String(error);
    }
    const launches = await nodeFs.readText(marker);
    if (
      !message.includes("ACP v2 required") ||
      manager.sessionCount ||
      launches.trim().split(/\r?\n/).length !== 1
    ) {
      throw new Error(`V2 mismatch was hidden or retried: ${message}`);
    }
  } finally {
    await manager.closeAll();
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("ACP v1 protocol mismatch fails without retrying v2", async () => {
  const dir = await nodeFs.makeTempDir({ prefix: "acp-mcp-v1-mismatch-" });
  const marker = `${dir}/launches.txt`;
  const manager = managerFor("v1", [], {
    ACPMCP_V2_FIXTURE_LAUNCH_MARKER: marker,
  });
  try {
    let failed = false;
    try {
      await manager.start("fake", process.cwd());
    } catch {
      failed = true;
    }
    const launches = await nodeFs.readText(marker);
    if (
      !failed ||
      manager.sessionCount ||
      launches.trim().split(/\r?\n/).length !== 1
    ) {
      throw new Error(`V1 mismatch was hidden or retried: ${launches}`);
    }
  } finally {
    await manager.closeAll();
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("ACP v2 model discovery normalizes exact advertised config IDs", async () => {
  const dir = await nodeFs.makeTempDir({ prefix: "acp-mcp-v2-models-" });
  const configPath = `${dir}/config.json`;
  await nodeFs.writeText(configPath, JSON.stringify({ agents: {} }));
  const agents = await loadAgents(configPath);
  agents.fake = {
    command: process.execPath,
    args: [fixturePath()],
    acpProtocol: "v2",
  };
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  try {
    const result = parseToolResult(
      await mcp.callTool("list_models", { agentId: "fake" }).response,
    );
    const models = result.models as Array<Record<string, unknown>>;
    if (
      result.status !== "completed" ||
      !models.some((item) => item.id === "fake-v2-model")
    )
      throw new Error(`V2 model discovery failed: ${JSON.stringify(result)}`);
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("v1 and v2 run_task keep the same compact product result shape", async () => {
  const cwd = await nodeFs.makeTempDir({ prefix: "acp-mcp-cross-protocol-" });
  const cases: Array<{
    protocol: "v1" | "v2";
    command: string;
    args: string[];
  }> = [
    {
      protocol: "v1",
      command: process.execPath,
      args: [v1FixturePath()],
    },
    {
      protocol: "v2",
      command: process.execPath,
      args: [fixturePath()],
    },
  ];
  try {
    for (const definition of cases) {
      const agents = {
        fake: { ...definition, acpProtocol: definition.protocol },
      };
      const manager = new SessionManager(agents);
      const server = createMcpServer(agents, manager);
      const mcp = await connectMcp(server);
      try {
        const result = parseToolResult(
          await mcp.callTool("run_task", {
            agentId: "fake",
            task: "contract",
            cwd,
          }).response,
        );
        const keys = Object.keys(result).sort().join(",");
        if (
          result.status !== "completed" ||
          result.stopReason !== "end_turn" ||
          typeof result.response !== "string" ||
          keys !== "response,status,stopReason"
        ) {
          throw new Error(
            `${definition.protocol} run_task result differs: ${JSON.stringify(
              result,
            )}`,
          );
        }
      } finally {
        await mcp.close();
        await manager.closeAll();
        await server.close();
      }
    }
  } finally {
    await nodeFs.removePath(cwd, { recursive: true });
  }
});

test("v2 task completion survives nonzero child exit during cleanup", async () => {
  const agents = {
    fake: {
      command: process.execPath,
      args: [fixturePath(), "--exit-nonzero-after-close"],
      acpProtocol: "v2" as const,
    },
  };
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  try {
    const result = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "contract",
        cwd: process.cwd(),
      }).response,
    );
    if (
      result.status !== "completed" ||
      result.response !== "v2 reply" ||
      manager.sessionCount !== 0
    ) {
      throw new Error(
        `V2 cleanup exit changed task completion: ${JSON.stringify(result)}`,
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});
