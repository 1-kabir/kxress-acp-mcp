import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

function managerFor(agentId: "raw" | "fake" = "fake") {
  return new SessionManager({
    [agentId]: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        `tests/fixtures/${
          agentId === "raw" ? "raw_wire_acp_agent" : "fake_acp_agent"
        }.ts`,
      ],
    },
  });
}

async function harness(agentId: "raw" | "fake" = "fake") {
  const manager = managerFor(agentId);
  const closedChildren: Promise<unknown>[] = [];
  const closedStderr: Array<() => string> = [];
  const originalClose = manager.close.bind(manager);
  manager.close = async (id) => {
    const process = manager.get(id).process;
    closedChildren.push(process.child.status);
    closedStderr.push(process.stderrTail);
    await originalClose(id);
  };
  const server = createMcpServer(
    { [agentId]: { command: "unused", args: [] } },
    manager,
  );
  const mcp = await connectMcp(server);
  return { manager, server, mcp, closedChildren, closedStderr };
}

Deno.test("delegate advertises external disclosure and mutation accurately", async () => {
  const { manager, server, mcp } = await harness();
  try {
    const reply = await mcp.listTools().response as {
      result?: { tools?: Array<Record<string, unknown>> };
    };
    const tool = reply.result?.tools?.find((item) => item.name === "delegate");
    if (!tool) throw new Error("delegate tool was not advertised");
    const annotations = tool.annotations as Record<string, unknown>;
    if (
      annotations.readOnlyHint !== false ||
      annotations.destructiveHint !== true ||
      annotations.idempotentHint !== false ||
      annotations.openWorldHint !== true
    ) {
      throw new Error(
        `Inaccurate delegate annotations: ${JSON.stringify(annotations)}`,
      );
    }
    const description = String(tool.description);
    for (
      const phrase of [
        "may be sent to its configured model provider",
        "does not prevent external data disclosure",
        "Host approval policies still apply",
      ]
    ) {
      if (!description.includes(phrase)) {
        throw new Error(`delegate description omitted: ${phrase}`);
      }
    }
    const schema = tool.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };
    const policyDescription = schema.properties?.permissionPolicy?.description;
    if (!policyDescription?.includes("does not sandbox")) {
      throw new Error(
        "permissionPolicy description conflates permission and isolation",
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("delegate returns one compact answer while retaining internal ACP updates", async () => {
  const { manager, server, mcp, closedChildren } = await harness("raw");
  let observed: Array<{ kind: string; raw: unknown }> = [];
  const close = manager.close.bind(manager);
  manager.close = async (id) => {
    observed = manager.get(id).events.map(({ kind, raw }) => ({ kind, raw }));
    await close(id);
  };
  try {
    const { response } = mcp.callTool("delegate", {
      agentId: "raw",
      prompt: "delegate isolation",
    });
    const wire = await response as { result?: Record<string, unknown> };
    const serialized = JSON.stringify(wire.result);
    const result = parseToolResult(wire);
    if (
      JSON.stringify(result) !== JSON.stringify({
        status: "completed",
        response: "Delegation complete.",
        stopReason: "end_turn",
      })
    ) throw new Error(`Unexpected delegate result: ${JSON.stringify(result)}`);
    if (
      (wire.result?.content as unknown[])?.length !== 1 ||
      wire.result?.structuredContent
    ) {
      throw new Error(
        "MCP returned duplicate or structured result representations",
      );
    }
    for (
      const marker of [
        "INTERNAL_THOUGHT_MARKER",
        "INTERNAL_TOOL_MARKER",
        "TOOL_HISTORY_MARKER",
        "UNKNOWN_EVENT_MARKER",
        "RAW_PARAMS_MARKER",
        "agent_thought_chunk",
        "usage_update",
        "tool_call_update",
      ]
    ) {
      if (serialized.includes(marker)) {
        throw new Error(`Internal marker leaked: ${marker}`);
      }
    }
    if (
      !observed.some((event) => event.kind === "future_update") ||
      observed.length !== 8
    ) {
      throw new Error(
        "Expected internal known and unknown events in the journal",
      );
    }
    const journalBytes = JSON.stringify(observed).length;
    if (journalBytes < 45000 || serialized.length > 240) {
      throw new Error(
        `Unexpected result/journal sizes: ${serialized.length}/${journalBytes}`,
      );
    }
    console.log(
      `Delegate serialized MCP result: ${serialized.length} bytes; internal event journal: ${journalBytes} bytes`,
    );
    if (manager.sessions.size !== 0) {
      throw new Error("Successful delegation leaked its session");
    }
    const second = await mcp.callTool("delegate", {
      agentId: "raw",
      prompt: "again",
    }).response;
    if (
      parseToolResult(second).status !== "completed" ||
      manager.sessions.size !== 0
    ) {
      throw new Error("A subsequent delegation failed or leaked its session");
    }
    await Promise.all(closedChildren);
    if (closedChildren.length !== 2) {
      throw new Error("Expected both one-shot child processes to exit");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("operator delegation returns a minimal handoff and expires its lease", async () => {
  const { manager, server, mcp, closedChildren } = await harness();
  try {
    const reply = await mcp.callTool("delegate", {
      agentId: "fake",
      prompt: "operator delegate",
      permissionPolicy: "operator",
      timeoutMs: 70,
    }).response;
    const wire = reply as { result: { content: Array<{ text: string }> } };
    const handoff = parseToolResult(reply);
    if (
      handoff.status !== "permission_required" || handoff.leaseTimeoutMs !== 70
    ) {
      throw new Error(
        `Unexpected permission handoff: ${JSON.stringify(handoff)}`,
      );
    }
    if (
      Object.keys(handoff).sort().join(",") !==
        "action,choices,leaseTimeoutMs,permissionId,sessionId,status"
    ) {
      throw new Error("Permission handoff includes unrelated session data");
    }
    if (JSON.stringify(wire.result).includes("permission_request")) {
      throw new Error("Permission event journal leaked into handoff");
    }
    const sessionId = String(handoff.sessionId);
    const permissionId = String(handoff.permissionId);
    const expiringSession = manager.get(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 140));
    if (manager.sessions.has(sessionId)) {
      throw new Error("Permission lease did not close the session");
    }
    await expiringSession.prompt?.done;
    if (
      expiringSession.prompt?.state === "running" ||
      expiringSession.pendingPermissions.size
    ) {
      throw new Error(
        "Lease cleanup left a running prompt or pending permission",
      );
    }
    let rejected = false;
    try {
      manager.resolvePermission(sessionId, permissionId, "reject");
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error("Permission resolution succeeded after lease expiry");
    }
    const continuation = parseToolResult(
      await mcp.callTool("delegate", {
        agentId: "fake",
        prompt: "operator delegate",
        permissionPolicy: "operator",
        timeoutMs: 70,
      }).response,
    );
    if (continuation.status !== "permission_required") {
      throw new Error("Second operator handoff failed");
    }
    const resolved = await mcp.callTool("resolve_permission", {
      sessionId: continuation.sessionId,
      permissionId: continuation.permissionId,
      optionId: "reject",
    }).response;
    if (!parseToolResult(resolved).resolved) {
      throw new Error("Low-level permission resolution failed");
    }
    const session = parseToolResult(
      await mcp.callTool("get_session", {
        sessionId: continuation.sessionId,
      }).response,
    );
    if (session.id !== continuation.sessionId) {
      throw new Error("Resolved continuation was not inspectable");
    }
    if (manager.get(String(continuation.sessionId)).permissionLease) {
      throw new Error("Resolved permission left an unused lease timer running");
    }
    await mcp.callTool("close_session", { sessionId: continuation.sessionId })
      .response;
    if (manager.sessions.has(String(continuation.sessionId))) {
      throw new Error("Manual continuation close failed");
    }
    const subsequent = await mcp.callTool("delegate", {
      agentId: "fake",
      prompt: "hello",
    }).response;
    if (parseToolResult(subsequent).status !== "completed") {
      throw new Error("Server unusable after lease expiry");
    }
    await Promise.all(closedChildren);
    if (closedChildren.length !== 3) {
      throw new Error("Lease, manual close, or follow-up process did not exit");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("delegate applies allow_all only when requested and defaults to read_only", async () => {
  const { manager, server, mcp, closedChildren } = await harness();
  try {
    const denied = await mcp.callTool("delegate", {
      agentId: "fake",
      prompt: "permission",
    }).response;
    if (parseToolResult(denied).response !== "reject") {
      throw new Error("Default read_only policy changed");
    }
    const allowed = await mcp.callTool("delegate", {
      agentId: "fake",
      prompt: "permission",
      permissionPolicy: "allow_all",
    }).response;
    if (parseToolResult(allowed).response !== "allow") {
      throw new Error("Explicit allow_all was not applied");
    }
    await Promise.all(closedChildren);
    if (closedChildren.length !== 2) {
      throw new Error("Permission policy sessions did not close");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("delegate timeout, MCP cancellation, prompt failure, process exit, and empty output clean up", async () => {
  const { manager, server, mcp, closedChildren, closedStderr } =
    await harness();
  try {
    const timed = await mcp.callTool("delegate", {
      agentId: "fake",
      prompt: "wait",
      timeoutMs: 40,
    }).response;
    if (
      parseToolResult(timed).status !== "timed_out" || manager.sessions.size
    ) {
      throw new Error("Timeout did not return compactly and clean up");
    }
    const cancelled = mcp.callTool("delegate", {
      agentId: "fake",
      prompt: "wait",
      timeoutMs: 5000,
    });
    for (let i = 0; i < 100 && manager.sessions.size === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!manager.sessions.size) {
      throw new Error("Delegation did not start before cancellation");
    }
    await mcp.cancel(cancelled.id);
    for (let i = 0; i < 100 && manager.sessions.size > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (manager.sessions.size) {
      throw new Error("MCP request cancellation leaked a session");
    }
    for (
      const prompt of ["prompt failure", "process crash", "empty response"]
    ) {
      const reply = await mcp.callTool("delegate", { agentId: "fake", prompt })
        .response;
      const result = parseToolResult(reply);
      if (
        result.status !== "failed" || Object.keys(result).join(",") !== "status"
      ) {
        throw new Error(`Failure response was not compact for '${prompt}'`);
      }
      if (
        JSON.stringify((reply as { result?: unknown }).result).includes(
          "PRIVATE_FAILURE_SENTINEL",
        )
      ) {
        throw new Error("Prompt error details leaked to the MCP caller");
      }
      if (manager.sessions.size) {
        throw new Error(`Session leaked after '${prompt}'`);
      }
    }
    const next = await mcp.callTool("delegate", {
      agentId: "fake",
      prompt: "hello",
    }).response;
    if (parseToolResult(next).status !== "completed") {
      throw new Error("Server unusable after failure cleanup");
    }
    await Promise.all(closedChildren);
    if (closedChildren.length !== 6) {
      throw new Error(
        `Expected cleanup for six child processes, got ${closedChildren.length}`,
      );
    }
    if (!closedStderr.some((tail) => tail().includes("ACP_CANCEL_RECEIVED"))) {
      throw new Error("MCP cancellation did not reach ACP session/cancel");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});
