import { loadAgents } from "../src/agents/config.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { findExecutablePath } from "../src/runtime/process.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

async function runIntegration(
  agentId: "codex" | "claude" | "antigravity",
): Promise<void> {
  const missingConfig = `${Deno.cwd()}${
    Deno.build.os === "windows" ? "\\" : "/"
  }acp-mcp-nonexistent-${crypto.randomUUID()}.json`;
  const configured = await loadAgents(
    agentId === "antigravity" ? undefined : missingConfig,
  );
  const definition = configured[agentId];
  const executable = await findExecutablePath(definition.command);
  if (!executable) {
    throw new Error(
      `${agentId} ACP executable '${definition.command}' was not found. ${definition.installHint}`,
    );
  }
  const env = { ...definition.env };
  if (agentId === "codex") {
    const existingCodex = await findExecutablePath("codex");
    if (existingCodex) env.CODEX_PATH = existingCodex;
  }
  const agents = {
    [agentId]: { ...definition, command: executable, env },
  };
  const manager = new SessionManager(agents);
  const closedChildren: Promise<Deno.CommandStatus>[] = [];
  const closedSessions: Array<{
    acpSessionId: string;
    eventCount: number;
    eventKinds: string[];
    journalBytes: number;
  }> = [];
  const close = manager.close.bind(manager);
  manager.close = async (id) => {
    const session = manager.get(id);
    closedChildren.push(session.process.child.status);
    closedSessions.push({
      acpSessionId: session.acpSessionId,
      eventCount: session.events.length,
      eventKinds: [...new Set(session.events.map((event) => event.kind))],
      journalBytes: JSON.stringify(session.events).length,
    });
    await close(id);
  };
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  try {
    if (agentId !== "codex") {
      const listed = parseToolResult(
        await mcp.callTool("list_agents", {}).response,
      );
      const row = Array.isArray(listed)
        ? listed.find((item) => (item as { id?: unknown }).id === agentId) as {
          commandFound?: unknown;
        } | undefined
        : undefined;
      if (row?.commandFound !== true) {
        throw new Error(
          `${agentId} configured executable was not launchable: ${
            JSON.stringify(listed)
          }`,
        );
      }
    }
    const discovery = parseToolResult(
      await mcp.callTool("list_models", {
        agentId,
      }).response,
    );
    if (discovery.status !== "completed" || !Array.isArray(discovery.models)) {
      throw new Error(
        `${agentId} ACP model discovery failed: ${JSON.stringify(discovery)}`,
      );
    }
    const models = discovery.models as Array<{
      configId: string;
      id: string;
      selected: boolean;
    }>;
    const requestedModel = agentId === "claude"
      ? Deno.env.get("ACPMCP_CLAUDE_MODEL")
      : undefined;
    const selectedModel = requestedModel
      ? models.find((model) => model.id === requestedModel)
      : models.find((model) => model.selected);
    if (!selectedModel) {
      throw new Error(
        requestedModel
          ? `${agentId} did not advertise the explicitly requested model '${requestedModel}'`
          : `${agentId} advertised no selected model`,
      );
    }
    const metadataSession = await manager.start(agentId);
    const runConfig: Record<string, unknown> = {
      [selectedModel.configId]: selectedModel.id,
    };
    const requestedEffort = agentId === "claude"
      ? Deno.env.get("ACPMCP_CLAUDE_EFFORT")
      : undefined;
    if (requestedEffort) {
      const effortOption = metadataSession.configOptions.find((option) =>
        option.id === "effort"
      );
      const options = Array.isArray(effortOption?.options)
        ? effortOption.options as Array<Record<string, unknown>>
        : [];
      if (
        !effortOption ||
        !options.some((option) => option.value === requestedEffort)
      ) {
        throw new Error(
          `${agentId} did not advertise requested effort '${requestedEffort}'`,
        );
      }
      runConfig[effortOption.id as string] = requestedEffort;
    }
    console.log(`${agentId} ACP auth/config: ${
      JSON.stringify({
        capabilities: metadataSession.capabilities,
        authMethods: metadataSession.authMethods,
        configOptions: metadataSession.configOptions.map((option) => ({
          id: option.id,
          category: option.category,
          type: option.type,
          currentValue: option.currentValue,
        })),
      })
    }`);
    await manager.close(metadataSession.id);
    const taskWorkspace = await Deno.makeTempDir({ prefix: "acp-mcp-live-" });
    const taskStartedAt = Date.now();
    let result: Record<string, unknown>;
    let resultDurationMs = 0;
    let callerResultBytes = 0;
    let writeProbeMetrics: Record<string, unknown> | undefined;
    let loadResult: Record<string, unknown> | undefined;
    try {
      result = parseToolResult(
        await mcp.callTool("run_task", {
          agentId,
          task:
            "Reply with exactly the two letters OK and no punctuation. Do not inspect files or use tools.",
          permissionPolicy: "read_only",
          idleTimeoutMs: 600000,
          cwd: taskWorkspace,
          config: runConfig,
        }).response,
      ) as Record<string, unknown>;
      resultDurationMs = Date.now() - taskStartedAt;
      callerResultBytes = JSON.stringify(result).length;
      if (agentId === "claude") {
        const sourceSession = closedSessions.at(-1);
        if (
          metadataSession.capabilities &&
          (metadataSession.capabilities as { loadSession?: unknown })
              .loadSession === true &&
          sourceSession
        ) {
          const loaded = await manager.load(
            agentId,
            sourceSession.acpSessionId,
            taskWorkspace,
          );
          loadResult = {
            supported: true,
            loaded: loaded.acpSessionId === sourceSession.acpSessionId,
          };
          await manager.close(loaded.id);
          if (loadResult.loaded !== true) {
            throw new Error("Claude ACP did not resume the saved session");
          }
        } else {
          loadResult = { supported: false };
        }
        const writeProbeDir = await Deno.makeTempDir({
          prefix: "acp-mcp-claude-write-",
        });
        try {
          const writeStartedAt = Date.now();
          const writeProbeResult = parseToolResult(
            await mcp.callTool("run_task", {
              agentId,
              task:
                "Create a file named CLAUDE_WRITE_TEST.txt containing TEST. Then report whether the file was created.",
              permissionPolicy: "read_only",
              idleTimeoutMs: 600000,
              cwd: writeProbeDir,
              config: runConfig,
            }).response,
          ) as Record<string, unknown>;
          let fileCreated = false;
          try {
            await Deno.stat(`${writeProbeDir}/CLAUDE_WRITE_TEST.txt`);
            fileCreated = true;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          const probeSession = closedSessions.at(-1);
          writeProbeMetrics = {
            status: writeProbeResult.status,
            response: writeProbeResult.response,
            stopReason: writeProbeResult.stopReason,
            durationMs: Date.now() - writeStartedAt,
            callerResultBytes: JSON.stringify(writeProbeResult).length,
            fileCreated,
            permissionRequestObserved:
              probeSession?.eventKinds.includes("permission_request") ?? false,
            eventKinds: probeSession?.eventKinds ?? [],
            journalBytes: probeSession?.journalBytes,
          };
        } finally {
          await Deno.remove(writeProbeDir, { recursive: true });
        }
      }
    } finally {
      await Deno.remove(taskWorkspace, { recursive: true });
    }
    if (result.status !== "completed" || result.response !== "OK") {
      throw new Error(
        `${agentId} harmless run_task failed: ${JSON.stringify(result)}`,
      );
    }
    if (manager.sessions.size) {
      throw new Error(`${agentId} left a session active`);
    }
    const statuses = await Promise.all(closedChildren);
    const sessionMetrics = closedSessions.map(({
      acpSessionId: _acpSessionId,
      ...metrics
    }) => metrics);
    console.log(
      `${agentId}: ${discovery.models.length} ACP-advertised models; ` +
        `model config IDs=${
          JSON.stringify([...new Set(models.map((model) => model.configId))])
        }; ` +
        `selected=${
          JSON.stringify(
            models.filter((model) => model.selected).map((model) => model.id),
          )
        }; ` +
        `run config=${JSON.stringify(runConfig)}; ` +
        `read-only OK task completed; session events=${
          JSON.stringify(sessionMetrics)
        }; ` +
        `caller result=${
          JSON.stringify(result)
        } (${callerResultBytes} bytes); ` +
        `task duration=${resultDurationMs}ms; ` +
        (writeProbeMetrics
          ? `write probe=${JSON.stringify(writeProbeMetrics)}; `
          : "") +
        (loadResult ? `session/load=${JSON.stringify(loadResult)}; ` : "") +
        `${statuses.length} ACP child processes exited with codes=${
          JSON.stringify(statuses.map((status) => status.code))
        }`,
    );
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
}

Deno.test({
  name: "Codex ACP adapter integration (opt in)",
  ignore: Deno.env.get("ACPMCP_CODEX_TEST") !== "1",
  fn: () => runIntegration("codex"),
});

Deno.test({
  name: "Antigravity ACP server integration (opt in)",
  ignore: Deno.env.get("ACPMCP_ANTIGRAVITY_TEST") !== "1",
  fn: () => runIntegration("antigravity"),
});

Deno.test({
  name: "Claude Agent ACP integration (opt in)",
  ignore: Deno.env.get("ACPMCP_CLAUDE_TEST") !== "1",
  fn: () => runIntegration("claude"),
});
