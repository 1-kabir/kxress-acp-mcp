import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { AgentMap } from "../agents/config.ts";
import { discoverAdvertisedModels } from "../models/discovery.ts";
import {
  enrichAdvertisedModels,
  fetchOpenCodeZenCatalog,
  type OpenCodeCatalog,
} from "../models/opencode_zen.ts";
import { SessionManager } from "../sessions/manager.ts";

type McpServerOptions = {
  loadOpenCodeCatalog?: (signal: AbortSignal) => Promise<OpenCodeCatalog>;
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

export function createMcpServer(
  agents: AgentMap,
  manager: SessionManager,
  options: McpServerOptions = {},
) {
  const server = new McpServer({ name: "acp-mcp", version: "0.2.0" });
  const loadOpenCodeCatalog = options.loadOpenCodeCatalog ??
    ((signal) => fetchOpenCodeZenCatalog(signal));
  server.registerTool("list_agents", {
    description: "List configured ACP agents",
    inputSchema: z.object({}),
  }, (): Promise<CallToolResult> =>
    Promise.resolve({
      content: [{
        type: "text",
        text: JSON.stringify(
          Object.entries(agents).map(([id, agent]) => ({
            id,
            displayName: agent.displayName ?? id,
            installHint: agent.installHint,
          })),
        ),
      }],
    }));
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
        "Run one task through a configured ACP agent and return only its final answer. Use this for bounded one-shot work; use explicit session tools for multi-turn work or event inspection. The task and repository content read by the agent may be sent to its configured model provider. permissionPolicy controls ACP permission responses; it does not prevent external data disclosure or sandbox the agent process. Host approval policies still apply.",
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
        timeoutMs: z.number().int().min(1).max(600000).optional().describe(
          "Maximum task duration in milliseconds (defaults to 120000)",
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
        timeoutMs = 120000,
      },
      extra,
    ) => {
      let sessionId: string | undefined;
      let closed = false;
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
        const promptRecord = manager.beginPrompt(session.id, text);
        const deadline = Date.now() + timeoutMs;
        while (promptRecord.state === "running") {
          const signal = extra.mcpReq.signal;
          if (signal?.aborted) {
            await manager.cancelPrompt(session.id, promptRecord.id);
            await close();
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ status: "failed" }),
              }],
            };
          }
          if (Date.now() >= deadline) {
            await manager.cancelPrompt(session.id, promptRecord.id);
            await close();
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ status: "timed_out" }),
              }],
            };
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
            }, timeoutMs);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: "permission_required",
                  sessionId,
                  permissionId: pending.id,
                  leaseTimeoutMs: timeoutMs,
                  action,
                  choices: pending.options,
                }),
              }],
            };
          }
          await Promise.race([
            promptRecord.done,
            new Promise((resolve) => setTimeout(resolve, 20)),
          ]);
        }
        if (promptRecord.state === "completed") {
          if (!promptRecord.text.trim()) {
            await close();
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ status: "failed" }),
              }],
            };
          }
          const result = {
            status: "completed",
            response: promptRecord.text,
            stopReason: promptRecord.stopReason,
          };
          await close();
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        await close();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "failed" }),
          }],
        };
      } catch {
        await close();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "failed" }),
          }],
        };
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
