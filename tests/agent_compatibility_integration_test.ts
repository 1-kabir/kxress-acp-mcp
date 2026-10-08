import { loadAgents } from "../src/agents/config.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { findExecutablePath } from "../src/runtime/process.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

async function runIntegration(
  agentId: "codex" | "antigravity",
): Promise<void> {
  const missingConfig = `${Deno.cwd()}${
    Deno.build.os === "windows" ? "\\" : "/"
  }acp-mcp-nonexistent-${crypto.randomUUID()}.json`;
  const configured = await loadAgents(missingConfig);
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
  const closedSessions: Array<{ eventCount: number; eventKinds: string[] }> =
    [];
  const close = manager.close.bind(manager);
  manager.close = async (id) => {
    const session = manager.get(id);
    closedChildren.push(session.process.child.status);
    closedSessions.push({
      eventCount: session.events.length,
      eventKinds: [...new Set(session.events.map((event) => event.kind))],
    });
    await close(id);
  };
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  try {
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
    const result = parseToolResult(
      await mcp.callTool("run_task", {
        agentId,
        task:
          "Reply with exactly the two letters OK and no punctuation. Do not inspect files or use tools.",
        permissionPolicy: "read_only",
        idleTimeoutMs: 600000,
      }).response,
    );
    if (result.status !== "completed" || result.response !== "OK") {
      throw new Error(
        `${agentId} harmless run_task failed: ${JSON.stringify(result)}`,
      );
    }
    if (manager.sessions.size) {
      throw new Error(`${agentId} left a session active`);
    }
    const statuses = await Promise.all(closedChildren);
    if (statuses.some((status) => !status.success)) {
      throw new Error(`${agentId} ACP child did not exit successfully`);
    }
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
        `read-only OK task completed; session events=${
          JSON.stringify(closedSessions)
        }; ` +
        `${statuses.length} ACP child processes exited`,
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
