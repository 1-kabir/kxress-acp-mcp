import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { AgentMap } from "../agents/config.ts";
import {
  type AgentFailureClassifiers,
  classifyAgentFailure,
} from "../agents/failure_classifiers.ts";
import { classifyOpenCodeFailure } from "../agents/opencode_failure_classifier.ts";
import { findExecutablePath } from "../runtime/process.ts";
import { discoverAdvertisedModels } from "../models/discovery.ts";
import {
  enrichAdvertisedModels,
  fetchOpenCodeZenCatalog,
  type OpenCodeCatalog,
} from "../models/opencode_zen.ts";
import { SessionManager } from "../sessions/manager.ts";

type McpServerOptions = {
  loadOpenCodeCatalog?: (signal: AbortSignal) => Promise<OpenCodeCatalog>;
  failureClassifiers?: AgentFailureClassifiers;
};

const defaultFailureClassifiers: AgentFailureClassifiers = {
  opencode: classifyOpenCodeFailure,
};

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() => {
    if (abort) signal.removeEventListener("abort", abort);
  });
}

function runTaskFailure(
  status: "failed" | "timed_out" | "cancelled",
  kind: string,
  stage: string,
  acpCode?: number,
  classification?: ReturnType<typeof classifyAgentFailure>,
) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        status,
        error: {
          kind,
          stage,
          ...(acpCode === undefined ? {} : { acpCode }),
          ...(classification ? { classification } : {}),
        },
      }),
    }],
  };
}

export function createMcpServer(
  agents: AgentMap,
  manager: SessionManager,
  options: McpServerOptions = {},
) {
  const server = new McpServer({ name: "acp-mcp", version: "0.2.0" });
  const loadOpenCodeCatalog = options.loadOpenCodeCatalog ??
    ((signal) => fetchOpenCodeZenCatalog(signal));
  const failureClassifiers = {
    ...defaultFailureClassifiers,
    ...options.failureClassifiers,
  };
  server.registerTool("list_agents", {
    description:
      "List configured ACP agents and whether their launch executable is present. commandFound does not verify authentication or provider access.",
    inputSchema: z.object({}),
  }, async (): Promise<CallToolResult> => {
    const listedAgents = await Promise.all(
      Object.entries(agents).map(async ([id, agent]) => ({
        id,
        displayName: agent.displayName ?? id,
        commandFound: !!await findExecutablePath(agent.command),
        installHint: agent.installHint,
      })),
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify(listedAgents),
      }],
    };
  });
  server.registerTool("start_session", {
    description: "Start an ACP session and optionally send an initial prompt",
    inputSchema: {
      agentId: z.string(),
      cwd: z.string().optional(),
      config: z.record(z.string(), z.string()).optional(),
      modeId: z.string().optional(),
      permissionPolicy: z.enum([
        "read_only",
        "operator",
        "allow_all",
        "deny_all",
      ]).optional(),
      prompt: z.string().optional(),
    },
  }, async ({ agentId, cwd, config, modeId, permissionPolicy, prompt }) => {
    try {
      const session = await manager.start(
        agentId,
        cwd,
        config,
        modeId,
        permissionPolicy,
      );
      try {
        const result = prompt
          ? await manager.prompt(session.id, prompt)
          : undefined;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              sessionId: session.id,
              acpSessionId: session.acpSessionId,
              agentId,
              result,
            }),
          }],
        };
      } catch (e) {
        await manager.close(session.id);
        throw e;
      }
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  });
  server.registerTool(
    "run_task",
    {
      description:
        "Run one task through a configured ACP agent and return only its final answer. Failures include a compact generic kind and stage; ACP codes are protocol codes, not provider HTTP status. No automatic retries or model fallback are performed. Use explicit session tools for multi-turn work or event inspection. The task and repository content read by the agent may be sent to its configured model provider. permissionPolicy controls ACP permission responses; it does not prevent external data disclosure or sandbox the agent process. Host approval policies still apply.",
      annotations: {
        title: "Run ACP task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        agentId: z.string().describe("Configured ACP agent to run"),
        task: z.string().describe(
          "Task instructions. Repository context is read by the ACP agent; do not include file contents unless intended for its model provider.",
        ),
        cwd: z.string().optional().describe(
          "Working directory the ACP agent may inspect. Files it reads may be sent to its configured model provider.",
        ),
        config: z.record(z.string(), z.string()).optional().describe(
          "Generic ACP configuration options, such as a model ID",
        ),
        modeId: z.string().optional(),
        permissionPolicy: z.enum([
          "read_only",
          "operator",
          "allow_all",
          "deny_all",
        ]).optional().describe(
          "ACP permission response policy (defaults to read_only); this does not sandbox the process or keep data local",
        ),
        idleTimeoutMs: z.number().int().min(1).max(3600000).optional()
          .describe(
            "Maximum consecutive time without ACP activity (defaults to 600000); active tasks may run longer",
          ),
        permissionLeaseMs: z.number().int().min(1).max(600000).optional()
          .describe(
            "How long an unresolved operator permission handoff remains available (defaults to 120000)",
          ),
      },
    },
    async (
      {
        agentId,
        task: text,
        cwd,
        config,
        modeId,
        permissionPolicy = "read_only",
        idleTimeoutMs = 600000,
        permissionLeaseMs = 120000,
      },
      extra,
    ) => {
      let sessionId: string | undefined;
      let closed = false;
      let failureStage = "session_start";
      let promptRecord: ReturnType<SessionManager["beginPrompt"]> | undefined;
      let abortHandler: (() => void) | undefined;
      const close = async () => {
        if (!sessionId || closed) return;
        closed = true;
        try {
          await manager.close(sessionId);
        } catch { /* already closed */ }
      };
      try {
        const session = await manager.start(
          agentId,
          cwd,
          config,
          modeId,
          permissionPolicy,
        );
        sessionId = session.id;
        failureStage = "prompt_start";
        promptRecord = manager.beginPrompt(session.id, text);
        failureStage = "prompt";
        const signal = extra.mcpReq.signal;
        let resolveAbort!: () => void;
        const aborted = new Promise<"cancelled">((resolve) => {
          resolveAbort = () => resolve("cancelled");
        });
        if (signal.aborted) resolveAbort();
        else {
          abortHandler = resolveAbort;
          signal.addEventListener("abort", abortHandler, { once: true });
        }
        while (promptRecord.state === "running") {
          if (signal?.aborted) {
            await manager.cancelPrompt(session.id, promptRecord.id);
            await close();
            return runTaskFailure("cancelled", "cancelled", "prompt");
          }
          if (
            permissionPolicy === "operator" && session.pendingPermissions.size
          ) {
            const pending = [...session.pendingPermissions.values()][0];
            const call = pending.toolCall as Record<string, unknown> | null;
            const action = call && typeof call === "object"
              ? Object.fromEntries(
                ["kind", "title", "name"].flatMap((key) =>
                  typeof call[key] === "string" ? [[key, call[key]]] : []
                ),
              )
              : {};
            session.permissionLease = setTimeout(() => {
              session.permissionLease = undefined;
              void close();
            }, permissionLeaseMs);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: "permission_required",
                  sessionId,
                  permissionId: pending.id,
                  leaseTimeoutMs: permissionLeaseMs,
                  action,
                  choices: pending.options,
                }),
              }],
            };
          }
          const activityVersion = promptRecord.activityVersion;
          const remaining = idleTimeoutMs -
            (performance.now() - promptRecord.lastActivityAt);
          if (remaining <= 0) {
            if (signal.aborted) {
              await manager.cancelPrompt(session.id, promptRecord.id);
              await close();
              return runTaskFailure("cancelled", "cancelled", "prompt");
            }
            if (
              promptRecord.activityVersion !== activityVersion ||
              performance.now() - promptRecord.lastActivityAt < idleTimeoutMs
            ) continue;
            await manager.cancelPrompt(session.id, promptRecord.id);
            await close();
            return runTaskFailure("timed_out", "timeout", "prompt");
          }
          const activity = manager.waitForPromptActivity(
            session.id,
            promptRecord.id,
            activityVersion,
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          const idleExpired = new Promise<"idle_timeout">((resolve) => {
            timer = setTimeout(() => resolve("idle_timeout"), remaining);
          });
          const outcome = await Promise.race([
            promptRecord.done.then(() => "prompt_done" as const),
            activity.promise.then(() => "activity" as const),
            idleExpired,
            aborted,
          ]);
          if (timer !== undefined) clearTimeout(timer);
          activity.cancel();
          if (outcome === "cancelled" || signal.aborted) {
            await manager.cancelPrompt(session.id, promptRecord.id);
            await close();
            return runTaskFailure("cancelled", "cancelled", "prompt");
          }
          if (outcome === "idle_timeout") {
            if (
              promptRecord.activityVersion !== activityVersion ||
              performance.now() - promptRecord.lastActivityAt < idleTimeoutMs
            ) continue;
            await manager.cancelPrompt(session.id, promptRecord.id);
            await close();
            return runTaskFailure("timed_out", "timeout", "prompt");
          }
        }
        if (promptRecord.state === "completed") {
          if (!promptRecord.text.trim()) {
            await close();
            return runTaskFailure(
              "failed",
              "invalid_response",
              "prompt_complete",
            );
          }
          const result = {
            status: "completed",
            response: promptRecord.text,
            stopReason: promptRecord.stopReason,
          };
          await close();
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (promptRecord.state === "cancelled") {
          await close();
          return runTaskFailure("cancelled", "cancelled", "prompt");
        }
        await close();
        const classification = classifyAgentFailure(
          agents,
          failureClassifiers,
          agentId,
          {
            agentId,
            model: agents[agentId]?.modelConfigId
              ? config?.[agents[agentId].modelConfigId!]
              : undefined,
            stage: "prompt",
            acpCode: promptRecord.errorCode,
            errorMessage: promptRecord.error,
            errorData: promptRecord.errorData,
          },
        );
        return runTaskFailure(
          "failed",
          "prompt_failed",
          "prompt",
          promptRecord.errorCode,
          classification,
        );
      } catch {
        await close();
        return runTaskFailure(
          "failed",
          failureStage === "session_start"
            ? "session_start_failed"
            : "prompt_start_failed",
          failureStage,
          promptRecord?.errorCode,
        );
      } finally {
        if (abortHandler) {
          extra.mcpReq.signal.removeEventListener("abort", abortHandler);
        }
      }
    },
  );
  server.registerTool(
    "list_models",
    {
      description:
        "List model choices advertised by a live ACP session, with optional OpenCode metadata",
      inputSchema: {
        agentId: z.string(),
        cwd: z.string().optional(),
        enrich: z.boolean().optional(),
        timeoutMs: z.number().int().min(1).max(120000).optional(),
      },
    },
    async (
      { agentId, cwd, enrich = false, timeoutMs = 30000 },
      extra,
    ) => {
      const definition = agents[agentId];
      if (!definition) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: JSON.stringify({ status: "failed", stage: "acp_discovery" }),
          }],
        };
      }
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([extra.mcpReq.signal, timeoutSignal]);
      let session: Awaited<ReturnType<typeof manager.start>> | undefined;
      let startPromise: ReturnType<typeof manager.start> | undefined;
      try {
        startPromise = manager.start(
          agentId,
          cwd,
          {},
          undefined,
          "read_only",
        );
        session = await abortable(startPromise, signal);
        if (extra.mcpReq.signal.aborted) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: JSON.stringify({ status: "failed", stage: "cancelled" }),
            }],
          };
        }
        const models = discoverAdvertisedModels(
          session.configOptions,
          definition,
        );
        let enrichedModels = models;
        let enrichment: { source?: string; status: string; sourceUrl?: string };
        if (!enrich) {
          enrichment = { status: "not_requested" };
        } else if (definition.modelEnrichment !== "opencode_zen") {
          enrichment = { status: "not_supported" };
        } else {
          try {
            const catalog = await loadOpenCodeCatalog(signal);
            enrichedModels = enrichAdvertisedModels(models, catalog);
            enrichment = {
              source: "opencode_zen",
              status: "available",
              sourceUrl: "https://opencode.ai/docs/zen/",
            };
          } catch {
            if (extra.mcpReq.signal.aborted) {
              return {
                isError: true,
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    status: "failed",
                    stage: "cancelled",
                  }),
                }],
              };
            }
            enrichedModels = models;
            enrichment = {
              source: "opencode_zen",
              status: "unavailable",
              sourceUrl: "https://opencode.ai/docs/zen/",
            };
          }
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "completed",
              availabilitySource: "acp",
              models: enrichedModels,
              enrichment,
            }),
          }],
        };
      } catch {
        const timedOut = timeoutSignal.aborted && !extra.mcpReq.signal.aborted;
        if (!session && startPromise) {
          void startPromise.then((lateSession) => manager.close(lateSession.id))
            .catch(() => undefined);
        }
        return {
          isError: true,
          content: [{
            type: "text",
            text: JSON.stringify({
              status: timedOut ? "timed_out" : "failed",
              stage: "acp_discovery",
            }),
          }],
        };
      } finally {
        if (session) {
          try {
            await manager.close(session.id);
          } catch { /* Session may have closed during request cancellation. */ }
        }
      }
    },
  );
  server.registerTool("load_session", {
    description:
      "Load an existing ACP session when the agent advertises session/load support",
    inputSchema: {
      agentId: z.string(),
      acpSessionId: z.string(),
      cwd: z.string(),
      permissionPolicy: z.enum([
        "read_only",
        "operator",
        "allow_all",
        "deny_all",
      ]).optional(),
    },
  }, async ({ agentId, acpSessionId, cwd, permissionPolicy }) => {
    try {
      const session = await manager.load(
        agentId,
        acpSessionId,
        cwd,
        permissionPolicy,
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            sessionId: session.id,
            acpSessionId: session.acpSessionId,
            agentId,
            configOptions: session.configOptions,
            modes: session.modes,
          }),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  });
  server.registerTool("prompt", {
    description:
      "Send a prompt to an active ACP session; wait=false returns a prompt ID for polling",
    inputSchema: {
      sessionId: z.string(),
      text: z.string(),
      wait: z.boolean().optional(),
      waitMs: z.number().int().min(0).max(120000).optional(),
    },
  }, async ({ sessionId, text, wait = true, waitMs = 60000 }) => {
    try {
      const prompt = manager.beginPrompt(sessionId, text);
      if (wait) await manager.waitPrompt(sessionId, prompt.id, waitMs);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            promptId: prompt.id,
            state: prompt.state,
            text: prompt.text,
            stopReason: prompt.stopReason,
            error: prompt.error,
          }),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  });
  server.registerTool(
    "get_events",
    {
      description: "Read buffered ACP session updates after a sequence cursor",
      inputSchema: {
        sessionId: z.string(),
        afterSequence: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        waitMs: z.number().int().min(0).max(30000).optional(),
        includeRaw: z.boolean().optional(),
        includeThoughts: z.boolean().optional(),
      },
    },
    async (
      {
        sessionId,
        afterSequence = 0,
        limit = 100,
        waitMs = 0,
        includeRaw = false,
        includeThoughts = false,
      },
    ) => {
      try {
        if (
          waitMs > 0 &&
          manager.getEvents(sessionId, afterSequence, limit).events.length === 0
        ) await new Promise((resolve) => setTimeout(resolve, waitMs));
        const result = manager.getEvents(sessionId, afterSequence, limit);
        const events = result.events.filter((event) =>
          includeThoughts || !event.kind.toLowerCase().includes("thought")
        ).map(({ raw, ...event }) => includeRaw ? { ...event, raw } : event);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ...result, events }),
          }],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    },
  );
  server.registerTool("cancel_prompt", {
    description: "Cancel a running prompt using ACP session/cancel",
    inputSchema: { sessionId: z.string(), promptId: z.string() },
  }, async ({ sessionId, promptId }) => {
    try {
      const p = await manager.cancelPrompt(sessionId, promptId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            promptId,
            state: p.state,
            stopReason: p.stopReason,
          }),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  });
  server.registerTool("list_sessions", {
    description: "List managed ACP sessions",
    inputSchema: z.object({}),
  }, (): Promise<CallToolResult> =>
    Promise.resolve({
      content: [{
        type: "text",
        text: JSON.stringify(
          [...manager.sessions.values()].map((
            { id, agentId, cwd, acpSessionId, promptActive },
          ) => ({ id, agentId, cwd, acpSessionId, promptActive })),
        ),
      }],
    }));
  server.registerTool("get_session", {
    description: "Get capabilities and live configuration metadata",
    inputSchema: { sessionId: z.string() },
  }, ({ sessionId }) => {
    try {
      const s = manager.get(sessionId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            id: s.id,
            agentId: s.agentId,
            cwd: s.cwd,
            acpSessionId: s.acpSessionId,
            capabilities: s.capabilities,
            authMethods: s.authMethods,
            configOptions: s.configOptions,
            modes: s.modes,
            permissionPolicy: s.permissionPolicy,
            pendingPermissions: [...s.pendingPermissions.values()].map((
              { id, toolCall, options },
            ) => ({ id, toolCall, options })),
            prompt: s.prompt
              ? {
                id: s.prompt.id,
                state: s.prompt.state,
                text: s.prompt.text,
                stopReason: s.prompt.stopReason,
              }
              : undefined,
            nextSequence: s.nextSequence - 1,
          }),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  });
  server.registerTool("set_config_option", {
    description: "Set an advertised ACP session configuration option",
    inputSchema: {
      sessionId: z.string(),
      configId: z.string(),
      value: z.string(),
    },
  }, async ({ sessionId, configId, value }) => {
    try {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            configOptions: await manager.setConfigOption(
              sessionId,
              configId,
              value,
            ),
          }),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  });
  server.registerTool("set_mode", {
    description: "Set an advertised ACP session mode",
    inputSchema: { sessionId: z.string(), modeId: z.string() },
  }, async ({ sessionId, modeId }) => {
    try {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            modes: await manager.setMode(sessionId, modeId),
          }),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  });
  server.registerTool("resolve_permission", {
    description:
      "Resolve an operator permission request using one of its advertised option IDs",
    inputSchema: {
      sessionId: z.string(),
      permissionId: z.string(),
      optionId: z.string(),
    },
  }, ({ sessionId, permissionId, optionId }) => {
    try {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            manager.resolvePermission(sessionId, permissionId, optionId),
          ),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  });
  server.registerTool("close_session", {
    description: "Close an ACP session",
    inputSchema: { sessionId: z.string() },
  }, async ({ sessionId }) => {
    try {
      await manager.close(sessionId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ closed: true, sessionId }),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  });
  return server;
}
