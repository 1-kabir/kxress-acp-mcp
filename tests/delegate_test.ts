import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import type { AgentFailureClassifiers } from "../src/agents/failure_classifiers.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

function managerFor(agentId: "raw" | "fake" = "fake") {
  const fixturePath = new URL(
    `./fixtures/${
      agentId === "raw" ? "raw_wire_acp_agent" : "fake_acp_agent"
    }.ts`,
    import.meta.url,
  ).pathname;
  const absoluteFixturePath = Deno.build.os === "windows"
    ? decodeURIComponent(fixturePath.replace(/^\//, ""))
    : fixturePath;
  return new SessionManager({
    [agentId]: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        absoluteFixturePath,
      ],
    },
  });
}

function sessionInternalsForTest(manager: SessionManager, id: string) {
  type TestSession = {
    process: {
      child: { status: Promise<Deno.CommandStatus> };
      stderrTail: () => string;
    };
  };
  const sessions =
    (manager as unknown as { sessions: Map<string, TestSession> })
      .sessions;
  const session = sessions.get(id);
  if (!session) throw new Error(`Missing test session ${id}`);
  return session;
}

async function harness(
  agentId: "raw" | "fake" = "fake",
  failureClassifier?: string,
  failureClassifiers?: AgentFailureClassifiers,
) {
  const manager = managerFor(agentId);
  const closedChildren: Promise<Deno.CommandStatus>[] = [];
  const closedStderr: Array<() => string> = [];
  const originalClose = manager.close.bind(manager);
  manager.close = async (id) => {
    const process = sessionInternalsForTest(manager, id).process;
    closedChildren.push(process.child.status);
    closedStderr.push(process.stderrTail);
    await originalClose(id);
  };
  const server = createMcpServer(
    {
      [agentId]: {
        command: "unused",
        args: [],
        ...(failureClassifier ? { failureClassifier } : {}),
      },
    },
    manager,
    { failureClassifiers },
  );
  const mcp = await connectMcp(server);
  return { manager, server, mcp, closedChildren, closedStderr };
}

Deno.test("run_task enriches only recognized OpenCode failures", async () => {
  const { manager, server, mcp } = await harness(
    "fake",
    "opencode",
  );
  try {
    const rateLimited = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "rate limit failure",
      }).response,
    );
    const failure = rateLimited.error as Record<string, unknown>;
    if (
      rateLimited.status !== "failed" || failure.kind !== "prompt_failed" ||
      failure.stage !== "prompt" || failure.acpCode !== -32603
    ) {
      throw new Error(
        `Generic failure fields changed: ${JSON.stringify(failure)}`,
      );
    }
    if (
      JSON.stringify(failure.classification) !== JSON.stringify({
        reason: "rate_limited",
        source: "opencode",
        evidence: "message_heuristic",
      })
    ) {
      throw new Error(
        `Rate limit was not classified: ${JSON.stringify(failure)}`,
      );
    }
    const raw = JSON.stringify(rateLimited);
    if (raw.includes("PRIVATE_PROVIDER_DIAGNOSTIC_SENTINEL")) {
      throw new Error("OpenCode diagnostic text leaked to caller");
    }

    const unrelated = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "unrelated provider failure",
      }).response,
    );
    const unrelatedError = unrelated.error as Record<string, unknown>;
    if ("classification" in unrelatedError) {
      throw new Error("Unrelated OpenCode error was classified");
    }
    if (
      JSON.stringify(unrelated).includes("PRIVATE_PROVIDER_DIAGNOSTIC_SENTINEL")
    ) {
      throw new Error("Unrelated diagnostic text leaked to caller");
    }
    if (manager.sessionCount) throw new Error("Failure leaked a session");
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("generic agents do not infer rate limits from ACP -32603", async () => {
  const { manager, server, mcp } = await harness();
  try {
    const result = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "rate limit failure",
      }).response,
    );
    const error = result.error as Record<string, unknown>;
    if (
      result.status !== "failed" || error.kind !== "prompt_failed" ||
      error.stage !== "prompt" || error.acpCode !== -32603 ||
      "classification" in error
    ) {
      throw new Error(
        `Generic agent failure was enriched: ${JSON.stringify(result)}`,
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("MCP session queries preserve public metadata without manager internals", async () => {
  const { manager, server, mcp } = await harness();
  try {
    const started = parseToolResult(
      await mcp.callTool("start_session", { agentId: "fake" }).response,
    );
    const sessionId = String(started.sessionId);
    if (
      started.agentId !== "fake" || !started.acpSessionId ||
      started.acpProtocol !== "v1"
    ) {
      throw new Error(
        `start_session metadata changed: ${JSON.stringify(started)}`,
      );
    }
    const listedResult = parseToolResult(
      await mcp.callTool("list_sessions", {}).response,
    );
    if (!Array.isArray(listedResult)) {
      throw new Error("list_sessions did not return an array");
    }
    const listed = listedResult as unknown as Array<Record<string, unknown>>;
    if (
      listed.length !== 1 || listed[0].id !== sessionId ||
      listed[0].agentId !== "fake" ||
      listed[0].acpSessionId !== started.acpSessionId
    ) {
      throw new Error(
        `list_sessions metadata changed: ${JSON.stringify(listed)}`,
      );
    }
    const details = parseToolResult(
      await mcp.callTool("get_session", { sessionId }).response,
    );
    const expected = [
      "acpProtocol",
      "acpSessionId",
      "agentId",
      "authMethods",
      "capabilities",
      "configOptions",
      "cwd",
      "id",
      "nextSequence",
      "pendingPermissions",
      "permissionPolicy",
    ];
    const detailKeys = Object.keys(details);
    if (
      details.id !== sessionId ||
      expected.some((key) => !detailKeys.includes(key)) ||
      detailKeys.some((key) =>
        ["driver", "process", "events", "permissionLease"].includes(key)
      ) ||
      !Array.isArray(details.pendingPermissions)
    ) {
      throw new Error(
        `get_session metadata changed: ${JSON.stringify(details)}`,
      );
    }
    await mcp.callTool("close_session", { sessionId }).response;
    if (manager.sessionCount !== 0) {
      throw new Error("MCP close_session did not release its managed session");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("failure classifier exceptions preserve generic failures", async () => {
  const { manager, server, mcp } = await harness(
    "fake",
    "thrower",
    {
      thrower: () => {
        throw new Error("PRIVATE_CLASSIFIER_SENTINEL");
      },
    },
  );
  try {
    const result = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "rate limit failure",
      }).response,
    );
    const error = result.error as Record<string, unknown>;
    if (
      result.status !== "failed" || error.kind !== "prompt_failed" ||
      error.stage !== "prompt" || error.acpCode !== -32603 ||
      "classification" in error ||
      JSON.stringify(result).includes("PRIVATE_CLASSIFIER_SENTINEL")
    ) {
      throw new Error(
        `Classifier exception affected failure: ${JSON.stringify(result)}`,
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("run_task advertises external disclosure and mutation accurately", async () => {
  const { manager, server, mcp } = await harness();
  try {
    const reply = await mcp.listTools().response as {
      result?: { tools?: Array<Record<string, unknown>> };
    };
    const tool = reply.result?.tools?.find((item) => item.name === "run_task");
    if (!tool) throw new Error("run_task tool was not advertised");
    const names = (reply.result?.tools ?? []).map((item) => item.name);
    if (names.includes("delegate") || names.includes("discover_models")) {
      throw new Error("Deprecated high-level tool aliases were advertised");
    }
    if (!names.includes("list_models") || !names.includes("list_agents")) {
      throw new Error("Everyday ACP discovery tools are incomplete");
    }
    const annotations = tool.annotations as Record<string, unknown>;
    if (
      annotations.readOnlyHint !== false ||
      annotations.destructiveHint !== true ||
      annotations.idempotentHint !== false ||
      annotations.openWorldHint !== true
    ) {
      throw new Error(
        `Inaccurate run_task annotations: ${JSON.stringify(annotations)}`,
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
        throw new Error(`run_task description omitted: ${phrase}`);
      }
    }
    const schema = tool.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };
    if (
      !schema.properties?.task || schema.properties.prompt ||
      !String(schema.properties.task.description).includes("ACP agent")
    ) {
      throw new Error("run_task did not advertise its task input");
    }
    const policyDescription = schema.properties?.permissionPolicy?.description;
    if (!policyDescription?.includes("does not sandbox")) {
      throw new Error(
        "permissionPolicy description conflates permission and isolation",
      );
    }
    if (
      !policyDescription.includes("may act without requesting permission") ||
      !policyDescription.includes(
        "allows agent-reported read, search, fetch, and think kinds",
      )
    ) {
      throw new Error(
        "permissionPolicy description overstates read_only guarantees",
      );
    }
    if (
      !schema.properties?.idleTimeoutMs ||
      !schema.properties?.permissionLeaseMs ||
      schema.properties.timeoutMs
    ) {
      throw new Error("run_task timeout schema was not migrated clearly");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("run_task returns one compact answer while retaining internal ACP updates", async () => {
  const { manager, server, mcp, closedChildren } = await harness("raw");
  let observed: Array<{ kind: string; raw: unknown }> = [];
  const close = manager.close.bind(manager);
  manager.close = async (id) => {
    observed = manager.getEvents(id).events.map(({ kind, raw }) => ({
      kind,
      raw,
    }));
    await close(id);
  };
  try {
    const { response } = mcp.callTool("run_task", {
      agentId: "raw",
      task: "delegate isolation",
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
    if (manager.sessionCount !== 0) {
      throw new Error("Successful delegation leaked its session");
    }
    const second = await mcp.callTool("run_task", {
      agentId: "raw",
      task: "again",
    }).response;
    if (
      parseToolResult(second).status !== "completed" ||
      manager.sessionCount !== 0
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

Deno.test("completed run_task result survives nonzero child cleanup exit", async () => {
  const { manager, server, mcp, closedChildren } = await harness();
  try {
    const result = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "complete then exit nonzero on close",
      }).response,
    );
    if (
      JSON.stringify(result) !== JSON.stringify({
        status: "completed",
        response: "fake reply",
        stopReason: "end_turn",
      })
    ) {
      throw new Error(
        `Nonzero cleanup exit changed completed result: ${
          JSON.stringify(result)
        }`,
      );
    }
    const [status] = await Promise.all(closedChildren);
    if (closedChildren.length !== 1 || status.code !== 23) {
      throw new Error(
        `Expected one terminated child with diagnostic exit code 23, got ${
          JSON.stringify(status)
        }`,
      );
    }
    if (manager.sessionCount) {
      throw new Error("Completed run leaked its session after child exit");
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
    const reply = await mcp.callTool("run_task", {
      agentId: "fake",
      task: "operator delegate",
      permissionPolicy: "operator",
      idleTimeoutMs: 50,
      permissionLeaseMs: 250,
    }).response;
    const wire = reply as { result: { content: Array<{ text: string }> } };
    const handoff = parseToolResult(reply);
    if (
      handoff.status !== "permission_required" ||
      handoff.leaseTimeoutMs !== 250
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
    const expiringSession = manager.getSessionSnapshot(sessionId);
    const promptCompletion = expiringSession.prompt
      ? manager.waitForPromptCompletion(sessionId, expiringSession.prompt.id)
      : Promise.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!manager.hasSession(sessionId)) {
      throw new Error("Prompt idle timeout overrode the permission lease");
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (manager.hasSession(sessionId)) {
      throw new Error("Permission lease did not close the session");
    }
    const expiredPrompt = await promptCompletion;
    if (expiredPrompt?.state === "running" || manager.hasSession(sessionId)) {
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
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "operator delegate",
        permissionPolicy: "operator",
        idleTimeoutMs: 50,
        permissionLeaseMs: 250,
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
    const continuationSessionId = String(continuation.sessionId);
    const continuationSnapshot = manager.getSessionSnapshot(
      continuationSessionId,
    );
    const continuationPrompt = continuationSnapshot.prompt
      ? manager.waitForPromptCompletion(
        continuationSessionId,
        continuationSnapshot.prompt.id,
      )
      : undefined;
    if (continuationSnapshot.pendingPermissions.length !== 0) {
      throw new Error("Resolved permission remained pending in session state");
    }
    await continuationPrompt;
    const session = parseToolResult(
      await mcp.callTool("get_session", {
        sessionId: continuation.sessionId,
      }).response,
    );
    if (session.id !== continuation.sessionId) {
      throw new Error("Resolved continuation was not inspectable");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!manager.hasSession(String(continuation.sessionId))) {
      throw new Error("Resolved permission lease closed the continued session");
    }
    await mcp.callTool("close_session", { sessionId: continuation.sessionId })
      .response;
    if (manager.hasSession(String(continuation.sessionId))) {
      throw new Error("Manual continuation close failed");
    }
    const subsequent = await mcp.callTool("run_task", {
      agentId: "fake",
      task: "hello",
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

Deno.test("permission leases are invalidated by cancellation and close", async () => {
  const { manager, server, mcp, closedChildren } = await harness();
  try {
    const cancelled = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "operator delegate",
        permissionPolicy: "operator",
        idleTimeoutMs: 1000,
        permissionLeaseMs: 200,
      }).response,
    );
    const cancelledId = String(cancelled.sessionId);
    const cancelledSession = manager.getSessionSnapshot(cancelledId);
    if (!cancelledSession.prompt) {
      throw new Error("Permission continuation did not keep a prompt record");
    }
    await manager.cancelPrompt(cancelledId, cancelledSession.prompt.id);
    const cancelledSnapshot = manager.getSessionSnapshot(cancelledId);
    if (
      cancelledSnapshot.prompt?.state !== "cancelled" ||
      cancelledSnapshot.pendingPermissions.length !== 0
    ) {
      throw new Error("Cancellation did not finalize permission state");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!manager.hasSession(cancelledId)) {
      throw new Error("Cancelled prompt's lease later closed the session");
    }
    await manager.close(cancelledId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (manager.hasSession(cancelledId)) {
      throw new Error("Closed session was resurrected by its old lease");
    }

    const closed = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "operator delegate",
        permissionPolicy: "operator",
        idleTimeoutMs: 1000,
        permissionLeaseMs: 200,
      }).response,
    );
    const closedId = String(closed.sessionId);
    await manager.close(closedId);
    const replacement = await manager.start("fake");
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (
      !manager.hasSession(replacement.id) || manager.sessionCount !== 1
    ) {
      throw new Error("An old lease affected a later managed session");
    }
    await manager.close(replacement.id);
    await Promise.all(closedChildren);
    if (closedChildren.length !== 3) {
      throw new Error(
        "Cancellation/close lease cleanup leaked child processes",
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("prompt completion clears a pending permission continuation lease", async () => {
  const { manager, server, mcp } = await harness();
  try {
    const handoff = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "permission then complete",
        permissionPolicy: "operator",
        idleTimeoutMs: 1000,
        permissionLeaseMs: 200,
      }).response,
    );
    if (handoff.status !== "permission_required") {
      throw new Error(
        `Expected permission handoff, got ${JSON.stringify(handoff)}`,
      );
    }
    const sessionId = String(handoff.sessionId);
    const started = manager.getSessionSnapshot(sessionId);
    if (!started.prompt) throw new Error("Missing active prompt after handoff");
    const prompt = await manager.waitForPromptCompletion(
      sessionId,
      started.prompt.id,
    );
    const completed = manager.getSessionSnapshot(sessionId);
    if (
      prompt.state !== "completed" ||
      completed.pendingPermissions.length !== 0
    ) {
      throw new Error("Prompt completion retained pending permission state");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!manager.hasSession(sessionId)) {
      throw new Error("Completed prompt's lease later closed its session");
    }
    await manager.close(sessionId);
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("run_task applies allow_all only when requested and defaults to read_only", async () => {
  const { manager, server, mcp, closedChildren } = await harness();
  let permissionRequests = 0;
  const close = manager.close.bind(manager);
  manager.close = async (id) => {
    permissionRequests +=
      manager.getEvents(id).events.filter((event) =>
        event.kind === "permission_request"
      ).length;
    await close(id);
  };
  try {
    const denied = await mcp.callTool("run_task", {
      agentId: "fake",
      task: "permission",
    }).response;
    if (parseToolResult(denied).response !== "reject") {
      throw new Error("Default read_only policy changed");
    }
    const allowed = await mcp.callTool("run_task", {
      agentId: "fake",
      task: "permission",
      permissionPolicy: "allow_all",
    }).response;
    if (parseToolResult(allowed).response !== "allow") {
      throw new Error("Explicit allow_all was not applied");
    }
    await Promise.all(closedChildren);
    if (closedChildren.length !== 2 || permissionRequests !== 2) {
      throw new Error(
        `Expected two closed sessions and permission requests; closed=${closedChildren.length}, requests=${permissionRequests}`,
      );
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("read_only cannot stop a fake agent's direct process write", async () => {
  const dir = await Deno.makeTempDir();
  const { manager, server, mcp, closedChildren } = await harness(
    "fake",
  );
  let eventKinds: string[] = [];
  const close = manager.close.bind(manager);
  manager.close = async (id) => {
    eventKinds = manager.getEvents(id).events.map((event) => event.kind);
    await close(id);
  };
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  const writtenFile = `${dir}${separator}DIRECT_WRITE.txt`;
  try {
    const result = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "direct write without permission",
        cwd: dir,
        permissionPolicy: "read_only",
      }).response,
    );
    if (
      result.status !== "completed" || result.response !==
        "Wrote DIRECT_WRITE.txt"
    ) {
      throw new Error(
        `Unexpected direct-write task result: ${JSON.stringify(result)}`,
      );
    }
    if (
      await Deno.readTextFile(writtenFile) !== "written without ACP permission"
    ) {
      throw new Error("Fake agent did not write through its OS process access");
    }
    if (eventKinds.includes("permission_request")) {
      throw new Error(
        "Direct fake-agent write unexpectedly requested ACP permission",
      );
    }
    await Promise.all(closedChildren);
    if (closedChildren.length !== 1 || manager.sessionCount) {
      throw new Error("Direct-write test leaked its ACP child or session");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run_task reports startup failures without exposing their detail", async () => {
  const { manager, server, mcp } = await harness();
  manager.start = () => {
    throw new Error("PRIVATE_START_FAILURE_SENTINEL");
  };
  try {
    const reply = await mcp.callTool("run_task", {
      agentId: "fake",
      task: "hello",
    }).response;
    const result = parseToolResult(reply);
    if (
      result.status !== "failed" ||
      JSON.stringify(result.error) !== JSON.stringify({
          kind: "session_start_failed",
          stage: "session_start",
        })
    ) {
      throw new Error(
        `Unexpected startup failure result: ${JSON.stringify(result)}`,
      );
    }
    if (JSON.stringify(reply).includes("PRIVATE_START_FAILURE_SENTINEL")) {
      throw new Error("Startup error details leaked to the MCP caller");
    }
    if (manager.sessionCount) {
      throw new Error("Startup failure left a managed session active");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("run_task timeout, MCP cancellation, prompt failure, process exit, and empty output clean up", async () => {
  const { manager, server, mcp, closedChildren, closedStderr } =
    await harness();
  try {
    const timed = await mcp.callTool("run_task", {
      agentId: "fake",
      task: "wait",
      idleTimeoutMs: 50,
    }).response;
    const timeoutResult = parseToolResult(timed);
    if (
      timeoutResult.status !== "timed_out" ||
      (timeoutResult.error as Record<string, unknown>)?.kind !== "timeout" ||
      (timeoutResult.error as Record<string, unknown>)?.stage !== "prompt" ||
      manager.sessionCount
    ) {
      throw new Error("Timeout did not return compactly and clean up");
    }
    const cancelled = mcp.callTool("run_task", {
      agentId: "fake",
      task: "active stream",
      idleTimeoutMs: 5000,
    });
    for (let i = 0; i < 100 && manager.sessionCount === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!manager.sessionCount) {
      throw new Error("Delegation did not start before cancellation");
    }
    let runningSession = manager.listSessionSnapshots()[0];
    for (
      let i = 0;
      i < 100 && (!runningSession?.prompt ||
        !manager.getPromptHandle(runningSession.id, runningSession.prompt.id)
          .activityVersion);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      runningSession = manager.listSessionSnapshots()[0];
    }
    if (
      !runningSession?.prompt || !manager.getPromptHandle(
        runningSession.id,
        runningSession.prompt.id,
      ).activityVersion
    ) {
      throw new Error("Active cancellation fixture did not emit updates");
    }
    await mcp.cancel(cancelled.id);
    for (let i = 0; i < 100 && manager.sessionCount > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (manager.sessionCount) {
      throw new Error("MCP request cancellation leaked a session");
    }
    for (
      const prompt of [
        "late response",
        "prompt failure",
        "process crash",
        "empty response",
      ]
    ) {
      const reply = await mcp.callTool("run_task", {
        agentId: "fake",
        task: prompt,
        ...(prompt === "late response" ? { idleTimeoutMs: 40 } : {}),
      })
        .response;
      const result = parseToolResult(reply);
      const failure = result.error as Record<string, unknown> | undefined;
      const expectedKind = prompt === "empty response"
        ? "invalid_response"
        : prompt === "late response"
        ? "timeout"
        : "prompt_failed";
      const expectedStage = prompt === "empty response"
        ? "prompt_complete"
        : "prompt";
      const expectedStatus = prompt === "late response"
        ? "timed_out"
        : "failed";
      if (
        result.status !== expectedStatus || !failure ||
        failure.kind !== expectedKind || failure.stage !== expectedStage ||
        Object.keys(result).sort().join(",") !== "error,status"
      ) {
        throw new Error(
          `Unexpected structured failure for '${prompt}': ${
            JSON.stringify(result)
          }`,
        );
      }
      if (
        prompt === "prompt failure" && typeof failure.acpCode !== "number"
      ) {
        throw new Error("ACP JSON-RPC error code was not retained");
      }
      if (
        JSON.stringify((reply as { result?: unknown }).result).includes(
          "PRIVATE_FAILURE_SENTINEL",
        )
      ) {
        throw new Error("Prompt error details leaked to the MCP caller");
      }
      if (manager.sessionCount) {
        throw new Error(`Session leaked after '${prompt}'`);
      }
    }
    const next = await mcp.callTool("run_task", {
      agentId: "fake",
      task: "hello",
    }).response;
    if (parseToolResult(next).status !== "completed") {
      throw new Error("Server unusable after failure cleanup");
    }
    await Promise.all(closedChildren);
    if (closedChildren.length !== 7) {
      throw new Error(
        `Expected cleanup for seven child processes, got ${closedChildren.length}`,
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

Deno.test("run_task idle timeout resets on known and unknown ACP updates", async () => {
  const { manager, server, mcp } = await harness();
  try {
    for (const task of ["active heartbeat", "unknown heartbeat"]) {
      const reply = await mcp.callTool("run_task", {
        agentId: "fake",
        task,
        idleTimeoutMs: 100,
      }).response;
      const result = parseToolResult(reply);
      if (
        result.status !== "completed" ||
        result.response !== "heartbeat completed"
      ) {
        throw new Error(
          `${task} did not outlive its idle timeout: ${JSON.stringify(result)}`,
        );
      }
      if (manager.sessionCount) throw new Error(`${task} leaked a session`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (manager.sessionCount) {
      throw new Error("A completed idle timer affected later task state");
    }
    const reusable = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "hello",
      }).response,
    );
    if (reusable.status !== "completed") {
      throw new Error("Server was not reusable after activity-based timeouts");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("stderr output alone does not reset the run_task idle timeout", async () => {
  const { manager, server, mcp, closedChildren, closedStderr } =
    await harness();
  try {
    const result = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "fake",
        task: "stderr only",
        idleTimeoutMs: 60,
      }).response,
    );
    if (
      result.status !== "timed_out" ||
      (result.error as Record<string, unknown>)?.stage !== "prompt" ||
      manager.sessionCount !== 0
    ) {
      throw new Error(`stderr kept the task alive: ${JSON.stringify(result)}`);
    }
    await Promise.all(closedChildren);
    if (
      closedChildren.length !== 1 ||
      !closedStderr[0]().includes("stderr heartbeat")
    ) {
      throw new Error("The stderr-only fixture did not exercise cleanup");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("activity in another session does not reset a silent task", async () => {
  const { manager, server, mcp } = await harness();
  try {
    const silentCall = mcp.callTool("run_task", {
      agentId: "fake",
      task: "wait",
      idleTimeoutMs: 100,
    });
    for (let i = 0; i < 100 && manager.sessionCount === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (manager.sessionCount !== 1) {
      throw new Error("Silent task did not start before second session");
    }
    const activeReply = mcp.callTool("run_task", {
      agentId: "fake",
      task: "active heartbeat",
      idleTimeoutMs: 100,
    });
    const [silentWire, activeWire] = await Promise.all([
      silentCall.response,
      activeReply.response,
    ]);
    if (parseToolResult(silentWire).status !== "timed_out") {
      throw new Error("Other-session updates prevented silent task timeout");
    }
    if (parseToolResult(activeWire).status !== "completed") {
      throw new Error("Active task did not remain isolated from peer timeout");
    }
    if (manager.sessionCount) {
      throw new Error("Concurrent tasks leaked sessions");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});
