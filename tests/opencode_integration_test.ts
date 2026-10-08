import { SessionManager } from "../src/sessions/manager.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

Deno.test({
  name: "OpenCode ACP smoke test (opt in)",
  ignore: Deno.env.get("ACPMCP_OPENCODE_TEST") !== "1",
  fn: async () => {
    const manager = new SessionManager({
      opencode: { command: "opencode", args: ["acp"] },
    });
    let delegatedPolicy: string | undefined;
    let internalActivityBytes = 0;
    const start = manager.start.bind(manager);
    manager.start = (agentId, cwd, config, modeId, permissionPolicy) => {
      delegatedPolicy = permissionPolicy;
      return start(agentId, cwd, config, modeId, permissionPolicy);
    };
    const close = manager.close.bind(manager);
    manager.close = async (id) => {
      if (manager.sessions.has(id)) {
        internalActivityBytes = Math.max(
          internalActivityBytes,
          JSON.stringify(manager.get(id).events).length,
        );
      }
      await close(id);
    };
    const server = createMcpServer({
      opencode: { command: "opencode", args: ["acp"] },
    }, manager);
    let mcp: Awaited<ReturnType<typeof connectMcp>> | undefined;
    try {
      const probe = await start("opencode", Deno.cwd());
      const model = probe.configOptions.find((option) => option.id === "model");
      const advertised =
        (model?.options as Array<Record<string, unknown>> | undefined)
          ?.flatMap((entry) =>
            Array.isArray(entry.options)
              ? entry.options as Array<Record<string, unknown>>
              : [entry]
          ).some((entry) =>
            entry.value === "opencode/longcat-2.5-preview-free"
          ) ?? false;
      await manager.close(probe.id);
      if (!advertised) {
        console.log(
          "Skipping OpenCode delegate call: target free model is not advertised",
        );
        return;
      }
      mcp = await connectMcp(server);
      const wire = await mcp.callTool("delegate", {
        agentId: "opencode",
        config: { model: "opencode/longcat-2.5-preview-free" },
        prompt:
          "Inspect this repository enough to understand its purpose. Return exactly two short paragraphs and do not add headings, bullets, or numbering: paragraph one explains what the project does; paragraph two explains how MCP and ACP are separated architecturally.",
      }).response;
      const result = parseToolResult(wire);
      const response = String(result.response ?? "");
      if (result.status !== "completed" || !response.trim()) {
        throw new Error(
          `OpenCode delegate did not complete: ${JSON.stringify(result)}`,
        );
      }
      const substantiveParagraphs = response.split(/\n\s*\n/).filter(
        (paragraph) =>
          paragraph.trim() &&
          !/^\*\*[^*]+\*\*$/.test(paragraph.trim()),
      );
      if (substantiveParagraphs.length !== 2 || response.length > 1800) {
        throw new Error(
          `OpenCode response was not two concise paragraphs: ${response}`,
        );
      }
      if (delegatedPolicy !== "read_only") {
        throw new Error(
          `Expected delegate default policy read_only, got ${delegatedPolicy}`,
        );
      }
      const mcpResult = (wire as { result?: Record<string, unknown> }).result;
      if (
        (mcpResult?.content as unknown[])?.length !== 1 ||
        mcpResult?.structuredContent
      ) {
        throw new Error("OpenCode result was duplicated in MCP output");
      }
      const callerResultBytes = JSON.stringify(mcpResult).length;
      if (internalActivityBytes <= callerResultBytes) {
        throw new Error(
          `OpenCode event activity was not larger than the caller result (${internalActivityBytes}/${callerResultBytes} bytes)`,
        );
      }
      console.log(
        `OpenCode delegate: ${callerResultBytes} caller-result bytes; ${internalActivityBytes} internal event bytes`,
      );
      if (manager.sessions.size) {
        throw new Error("OpenCode delegate left a managed session active");
      }
    } finally {
      await mcp?.close();
      await manager.closeAll();
      await server.close();
    }
  },
});
