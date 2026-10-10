import { loadAgents } from "../src/agents/config.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { findExecutablePath } from "../src/runtime/process.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

function childStatusForTest(manager: SessionManager, id: string) {
  type TestSession = {
    process: { child: { status: Promise<Deno.CommandStatus> } };
  };
  const sessions =
    (manager as unknown as { sessions: Map<string, TestSession> })
      .sessions;
  const session = sessions.get(id);
  if (!session) throw new Error(`Missing test session ${id}`);
  return session.process.child.status;
}

async function runIntegration(
  agentId: "codex" | "claude" | "antigravity",
): Promise<void> {
  const missingConfig = `${Deno.cwd()}${
    Deno.build.os === "windows" ? "\\" : "/"
  }acp-mcp-nonexistent-${crypto.randomUUID()}.json`;
  // Reuse user-local profile environment for agents whose configured launch
  // route may carry provider settings. Never log those environment values.
  const configured = await loadAgents(
    agentId === "antigravity" || agentId === "claude"
      ? undefined
      : missingConfig,
  );
  const protocol = agentId === "claude"
    ? Deno.env.get("ACPMCP_COMPAT_PROTOCOL") ?? "v1"
    : "v1";
  const definition = {
    ...configured[agentId],
    acpProtocol: protocol as "v1" | "v2",
  };
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
    closedChildren.push(childStatusForTest(manager, id));
    const events = manager.getEvents(id).events;
    closedSessions.push({
      acpSessionId: manager.getSessionSnapshot(id).acpSessionId,
      eventCount: events.length,
      eventKinds: [...new Set(events.map((event) => event.kind))],
      journalBytes: JSON.stringify(events).length,
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
    const runConfig: Record<string, string> = agentId === "claude" &&
        requestedModel === undefined
      ? {}
      : { [selectedModel.configId]: selectedModel.id };
    const metadataSession = await manager.start(agentId);
    let loadResult: Record<string, unknown> | undefined;
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
      if (result.status !== "completed" || result.response !== "OK") {
        throw new Error(
          `${agentId} ${protocol} harmless run_task failed: ${
            JSON.stringify(result)
          }`,
        );
      }
      if (agentId === "claude") {
        const sourceSession = closedSessions.at(-1);
        const capabilities = metadataSession.capabilities as {
          loadSession?: unknown;
          session?: unknown;
        } | undefined;
        const resumeSupported = protocol === "v1"
          ? capabilities?.loadSession === true
          : Boolean(capabilities?.session);
        if (resumeSupported && sourceSession) {
          const loaded = await manager.load(
            agentId,
            sourceSession.acpSessionId,
            taskWorkspace,
          );
          try {
            const sameSession =
              loaded.acpSessionId === sourceSession.acpSessionId;
            if (!sameSession) {
              throw new Error("Claude ACP did not resume the saved session");
            }
            if (protocol === "v2") {
              const replay = manager.getEvents(loaded.id).events;
              const replayedResponse = replay.some((event) =>
                (event.kind === "agent_message" ||
                  event.kind === "agent_message_chunk") &&
                updateContainsText(event.update, "OK")
              );
              if (!replayedResponse) {
                throw new Error(
                  "Claude ACP v2 resumed without replaying the completed response",
                );
              }
              const followup = await manager.prompt(
                loaded.id,
                "Reply with exactly RESUMED and no punctuation. Do not use tools.",
              );
              if (followup.text !== "RESUMED") {
                throw new Error(
                  `Claude ACP v2 resumed but follow-up failed: ${followup.text}`,
                );
              }
              loadResult = {
                supported: true,
                loaded: true,
                replayedResponse,
                followup: followup.text,
              };
            } else {
              loadResult = { supported: true, loaded: true };
            }
          } finally {
            await manager.close(loaded.id);
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
    if (manager.sessionCount) {
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
        `selected model=${selectedModel.id}; ` +
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
        (loadResult
          ? `session resume/load=${JSON.stringify(loadResult)}; `
          : "") +
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

function updateContainsText(update: unknown, expected: string): boolean {
  if (!update || typeof update !== "object") return false;
  const content = (update as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content.some((block) =>
      Boolean(
        block && typeof block === "object" &&
          typeof (block as { text?: unknown }).text === "string" &&
          (block as { text: string }).text.includes(expected),
      )
    );
  }
  return Boolean(
    content && typeof content === "object" &&
      typeof (content as { text?: unknown }).text === "string" &&
      (content as { text: string }).text.includes(expected),
  );
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
