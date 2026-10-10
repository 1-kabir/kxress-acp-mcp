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
    let failureDiagnostic: { error?: string; data?: unknown } | undefined;
    const start = manager.start.bind(manager);
    manager.start = (agentId, cwd, config, modeId, permissionPolicy) => {
      delegatedPolicy = permissionPolicy;
      return start(agentId, cwd, config, modeId, permissionPolicy);
    };
    const close = manager.close.bind(manager);
    manager.close = async (id) => {
      if (manager.hasSession(id)) {
        internalActivityBytes = Math.max(
          internalActivityBytes,
          JSON.stringify(manager.getEvents(id).events).length,
        );
        const session = manager.getSessionSnapshot(id);
        if (session.prompt?.state === "failed") {
          failureDiagnostic = {
            error: session.prompt.error,
            data: session.prompt.errorData,
          };
        }
      }
      await close(id);
    };
    const agents = {
      opencode: {
        command: "opencode",
        args: ["acp"],
        modelConfigId: "model",
        failureClassifier: "opencode",
      },
    };
    const server = createMcpServer(agents, manager);
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
          "Skipping OpenCode run_task: target free model is not advertised",
        );
        return;
      }
      mcp = await connectMcp(server);
      const outcomes: Array<
        { model: string; result: Record<string, unknown> }
      > = [];
      let fledgeWire: unknown;
      for (
        const modelId of [
          "opencode/fledge-alpha-free",
          "opencode/longcat-2.5-preview-free",
        ]
      ) {
        const wire = await mcp.callTool("run_task", {
          agentId: "opencode",
          config: { model: modelId },
          task: "Reply exactly OK. Do not inspect files or use tools.",
        }).response;
        if (modelId === "opencode/fledge-alpha-free") fledgeWire = wire;
        outcomes.push({ model: modelId, result: parseToolResult(wire) });
        if (
          JSON.stringify(wire).includes("PRIVATE_PROVIDER_DIAGNOSTIC_SENTINEL")
        ) {
          throw new Error(
            "Private diagnostic sentinel leaked in integration result",
          );
        }
      }
      const fledge = outcomes[0].result;
      if (fledge.status !== "completed" || fledge.response !== "OK") {
        throw new Error(`Fledge run_task failed: ${JSON.stringify(fledge)}`);
      }
      const longcat = outcomes[1].result;
      if (longcat.status === "failed") {
        const error = longcat.error as Record<string, unknown>;
        const diagnostic = failureDiagnostic
          ? `${failureDiagnostic.error ?? ""} ${
            JSON.stringify(failureDiagnostic.data ?? "")
          }`
          : "";
        if (/\b(?:rate limit exceeded|too many requests)\b/i.test(diagnostic)) {
          const classification = error?.classification as
            | Record<string, unknown>
            | undefined;
          if (
            classification?.reason !== "rate_limited" ||
            classification?.source !== "opencode" ||
            classification?.evidence !== "message_heuristic"
          ) {
            throw new Error(
              `Explicit LongCat rate limit was not classified: ${
                JSON.stringify(longcat)
              }`,
            );
          }
        } else if (error && "classification" in error) {
          throw new Error(
            "Unrelated LongCat error was classified as rate limited",
          );
        }
        console.log(`LongCat live run_task result: ${JSON.stringify(longcat)}`);
      } else if (longcat.status !== "completed") {
        throw new Error(
          `Unexpected LongCat result: ${JSON.stringify(longcat)}`,
        );
      }
      if (delegatedPolicy !== "read_only") {
        throw new Error(
          `Expected delegate default policy read_only, got ${delegatedPolicy}`,
        );
      }
      const mcpResult = (fledgeWire as { result?: Record<string, unknown> })
        .result;
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
        `OpenCode Fledge run_task: ${callerResultBytes} caller-result bytes; ${internalActivityBytes} internal event bytes`,
      );
      if (manager.sessionCount) {
        throw new Error("OpenCode run_task left a managed session active");
      }
    } finally {
      await mcp?.close();
      await manager.closeAll();
      await server.close();
    }
  },
});
