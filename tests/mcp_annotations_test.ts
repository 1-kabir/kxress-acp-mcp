import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp } from "./helpers/mcp_wire.ts";

const expectedAnnotations: Record<
  string,
  {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  }
> = {
  list_agents: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_models: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  run_task: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  start_session: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  load_session: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  prompt: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  get_events: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  cancel_prompt: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  list_sessions: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  get_session: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  set_config_option: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  set_mode: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  resolve_permission: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  close_session: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  list_stale_workspaces: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  cleanup_stale_workspaces: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

Deno.test("every public MCP tool explicitly advertises accurate annotations", async () => {
  const manager = new SessionManager({});
  const server = createMcpServer({}, manager);
  const mcp = await connectMcp(server);
  try {
    const wire = await mcp.listTools().response as {
      result?: { tools?: Array<Record<string, unknown>> };
    };
    const tools = wire.result?.tools ?? [];
    const actualNames = tools.map((tool) => String(tool.name)).sort();
    const expectedNames = Object.keys(expectedAnnotations).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error(
        `MCP tool list changed; review annotation decisions: ${
          JSON.stringify(actualNames)
        }`,
      );
    }

    for (const tool of tools) {
      const name = String(tool.name);
      const annotations = tool.annotations as
        | Record<string, unknown>
        | undefined;
      if (!annotations) {
        throw new Error(`${name} has no explicit tool annotations`);
      }
      const expected = expectedAnnotations[name];
      for (
        const key of [
          "readOnlyHint",
          "destructiveHint",
          "idempotentHint",
          "openWorldHint",
        ] as const
      ) {
        if (typeof annotations[key] !== "boolean") {
          throw new Error(`${name}.${key} must be explicitly boolean`);
        }
        if (annotations[key] !== expected[key]) {
          throw new Error(
            `${name}.${key}: expected ${expected[key]}, got ${
              annotations[key]
            }`,
          );
        }
      }
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});
