import { createMcpServer } from "../src/mcp/server.ts";
import type { AgentMap } from "../src/agents/config.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

Deno.test({
  name: "OpenCode ACP model discovery with official enrichment",
  ignore: Deno.env.get("ACPMCP_OPENCODE_TEST") !== "1",
  fn: async () => {
    const agents: AgentMap = {
      opencode: {
        command: "opencode",
        args: ["acp"],
        modelConfigId: "model",
        modelEnrichment: "opencode_zen",
      },
    };
    const manager = new SessionManager(agents);
    const server = createMcpServer(agents, manager);
    const mcp = await connectMcp(server);
    try {
      const result = parseToolResult(
        await mcp.callTool("discover_models", {
          agentId: "opencode",
          cwd: Deno.cwd(),
          enrich: true,
        }).response,
      );
      if (
        result.status !== "completed" || result.availabilitySource !== "acp"
      ) {
        throw new Error(`OpenCode discovery failed: ${JSON.stringify(result)}`);
      }
      const models = result.models as Array<Record<string, unknown>>;
      const fledge = models.find((model) =>
        model.id === "opencode/fledge-alpha-free"
      );
      console.log(
        `OpenCode discovery: ${models.length} ACP-advertised models; Fledge advertised=${
          Boolean(fledge)
        }; enrichment=${
          (result.enrichment as Record<string, unknown>)?.status
        }`,
      );
      if (
        models.length === 0 ||
        models.some((model) =>
          model.available !== true || model.configId !== "model"
        )
      ) {
        throw new Error(
          "OpenCode did not return live advertised model choices",
        );
      }
      if (fledge) {
        const metadata = fledge.metadata as Record<string, unknown> | undefined;
        if (metadata?.free !== true) {
          throw new Error(
            "Advertised Fledge Alpha Free did not receive official free metadata",
          );
        }
      }
      if (manager.sessions.size !== 0) {
        throw new Error("OpenCode discovery leaked its temporary ACP session");
      }
    } finally {
      await mcp.close();
      await manager.closeAll();
      await server.close();
    }
  },
});
