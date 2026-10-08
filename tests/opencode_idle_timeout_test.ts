import { SessionManager } from "../src/sessions/manager.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

Deno.test({
  name: "OpenCode planning survives the idle timeout (opt in)",
  ignore: Deno.env.get("ACPMCP_OPENCODE_TEST") !== "1",
  fn: async () => {
    const agents = {
      opencode: {
        command: "opencode",
        args: ["acp"],
        modelConfigId: "model",
        failureClassifier: "opencode",
      },
    };
    const manager = new SessionManager(agents);
    const server = createMcpServer(agents, manager);
    let permissionPolicy: string | undefined;
    let eventSummary: {
      count: number;
      kinds: Record<string, number>;
      longestGapMs: number;
      journalBytes: number;
    } | undefined;
    const start = manager.start.bind(manager);
    manager.start = (agentId, cwd, config, modeId, policy) => {
      permissionPolicy = policy;
      return start(agentId, cwd, config, modeId, policy);
    };
    const close = manager.close.bind(manager);
    manager.close = async (id) => {
      const session = manager.get(id);
      const timestamps = session.events.map((event) =>
        Date.parse(event.timestamp)
      ).filter(Number.isFinite).sort((a, b) => a - b);
      const kinds: Record<string, number> = {};
      for (const event of session.events) {
        kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
      }
      let longestGapMs = 0;
      for (let i = 1; i < timestamps.length; i++) {
        longestGapMs = Math.max(
          longestGapMs,
          timestamps[i] - timestamps[i - 1],
        );
      }
      eventSummary = {
        count: session.events.length,
        kinds,
        longestGapMs,
        journalBytes: JSON.stringify(session.events).length,
      };
      await close(id);
    };

    const mcp = await connectMcp(server);
    try {
      const startedAt = performance.now();
      const wire = await mcp.callTool("run_task", {
        agentId: "opencode",
        cwd: Deno.cwd(),
        config: { model: "opencode/fledge-alpha-free" },
        permissionPolicy: "read_only",
        idleTimeoutMs: 300000,
        task:
          "Inspect this repository yourself and produce a concise implementation plan for making run_task time out on consecutive ACP inactivity instead of total duration. Do not modify files. Mention the timeout loop, event routing, API name, cleanup, and the most important tests. Return the plan only.",
      }).response;
      const durationMs = Math.round(performance.now() - startedAt);
      const result = parseToolResult(wire);
      if (
        result.status !== "completed" || typeof result.response !== "string" ||
        result.response.trim().length < 100 || result.response.length > 5000
      ) {
        throw new Error(
          `OpenCode planning task failed: ${JSON.stringify(result)}`,
        );
      }
      if (permissionPolicy !== "read_only") {
        throw new Error(`Expected read_only; got ${permissionPolicy}`);
      }
      const mcpResult = (wire as { result?: Record<string, unknown> }).result;
      if (
        (mcpResult?.content as unknown[])?.length !== 1 ||
        mcpResult?.structuredContent
      ) {
        throw new Error(
          "OpenCode planning result has duplicate representations",
        );
      }
      if (!eventSummary || !eventSummary.count) {
        throw new Error("OpenCode planning emitted no observable ACP updates");
      }
      if (manager.sessions.size) {
        throw new Error("OpenCode planning left a managed session active");
      }
      const callerBytes = JSON.stringify(mcpResult).length;
      console.log(
        `Fledge planning: ${durationMs}ms; ${eventSummary.count} ACP updates; longest observed update gap ${eventSummary.longestGapMs}ms; compact result ${callerBytes} bytes; internal journal ${eventSummary.journalBytes} bytes; kinds ${
          JSON.stringify(eventSummary.kinds)
        }`,
      );
    } finally {
      await mcp.close();
      await manager.closeAll();
      await server.close();
    }
  },
});
