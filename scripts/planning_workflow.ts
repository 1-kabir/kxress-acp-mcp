import { InMemoryTransport } from "@modelcontextprotocol/server";
import { resolveConfiguration } from "../src/config/discovery.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import {
  type PlannerCandidate,
  type PlanningModelList,
  type PlanningPrivacyPolicy,
  type PlanningTaskResult,
  runPlanningWorkflow,
  summarizeModelCandidates,
} from "../src/workspaces/planning_workflow.ts";
import {
  cloneWorkspaceSnapshot,
  createWorkspaceSnapshot,
} from "../src/workspaces/snapshot.ts";

type RpcReply = {
  id?: unknown;
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: { message?: string };
};

function parseCandidate(value: string): PlannerCandidate {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Candidate must be agentId:modelId: ${value}`);
  }
  return {
    agentId: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}

function parseArgs(args: string[]) {
  const operation = args[0];
  if (!operation || !["models", "configs", "run"].includes(operation)) {
    throw new Error("First argument must be models, configs, or run");
  }
  args = args.slice(1);
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (
      ["--allow-rate-limited-fallback", "--free-only", "--no-subscription"]
        .includes(arg)
    ) {
      flags.add(arg);
      continue;
    }
    if (!arg.startsWith("--") || !args[i + 1]) {
      throw new Error(`Unexpected or incomplete argument: ${arg}`);
    }
    const list = values.get(arg) ?? [];
    list.push(args[++i]);
    values.set(arg, list);
  }
  const one = (name: string, required = false) => {
    const all = values.get(name) ?? [];
    if (all.length > 1) throw new Error(`${name} may only be supplied once`);
    if (required && !all[0]) throw new Error(`${name} is required`);
    return all[0];
  };
  const privacyPolicy = one(
    "--privacy-policy",
    operation !== "configs",
  ) as PlanningPrivacyPolicy;
  if (
    privacyPolicy && ![
      "allow_any",
      "require_no_training",
      "require_no_training_and_zero_retention",
    ].includes(privacyPolicy)
  ) {
    throw new Error(`Unknown privacy policy: ${privacyPolicy}`);
  }
  const maxAttemptsText = one("--max-attempts");
  const maxAttempts = maxAttemptsText === undefined
    ? undefined
    : Number(maxAttemptsText);
  if (maxAttemptsText !== undefined && !Number.isInteger(maxAttempts)) {
    throw new Error("--max-attempts must be an integer");
  }
  const agentId = one("--agent", true)!;
  const modelId =
    one("--model", operation === "run" || operation === "configs") ?? "";
  const config: Record<string, string> = {};
  for (const item of values.get("--config-option") ?? []) {
    const separator = item.indexOf("=");
    if (separator <= 0 || separator === item.length - 1) {
      throw new Error(`Config option must be id=value: ${item}`);
    }
    const id = item.slice(0, separator);
    if (id === "model" || id in config) {
      throw new Error(`Config option may not override or repeat ${id}`);
    }
    config[id] = item.slice(separator + 1);
  }
  if (operation !== "run" && values.has("--fallback")) {
    throw new Error("--fallback is only valid with run");
  }
  if (operation !== "run" && values.has("--config-option")) {
    throw new Error("--config-option is only valid with run");
  }
  if (operation !== "run" && flags.has("--allow-rate-limited-fallback")) {
    throw new Error("--allow-rate-limited-fallback is only valid with run");
  }
  if (
    operation === "configs" &&
    (flags.has("--free-only") || flags.has("--no-subscription"))
  ) {
    throw new Error("Cost filters are only valid with models or run");
  }
  if (operation !== "run" && one("--mode")) {
    throw new Error("--mode is only valid with run");
  }
  const offset = Number(one("--offset") ?? "0");
  const limit = Number(one("--limit") ?? "30");
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("--offset must be a nonnegative integer");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be 1..100");
  }
  return {
    operation,
    repository: one("--repo") ?? Deno.cwd(),
    task: one("--task", operation === "run") ?? "",
    agentId,
    modelId,
    selected: { agentId, modelId },
    fallbacks: (values.get("--fallback") ?? []).map(parseCandidate),
    privacyPolicy,
    costPolicy: {
      freeOnly: flags.has("--free-only"),
      noSubscription: flags.has("--no-subscription"),
    },
    config,
    modeId: one("--mode"),
    search: one("--search"),
    offset,
    limit,
    allowRateLimitedFallback: flags.has("--allow-rate-limited-fallback"),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    configPath: one("--config"),
  };
}

function usage() {
  return `Usage:
  .../planning_workflow.ts models --agent <agentId> --privacy-policy <policy> [--free-only] [--no-subscription] [--search <text>] [--limit <1..100>] [--offset <n>]
  .../planning_workflow.ts configs --agent <agentId> --model <exact-id> [--repo <path>]
  .../planning_workflow.ts run --agent <agentId> --model <exact-id> --repo <path> --task <text> --privacy-policy <policy> [--free-only] [--no-subscription] [--fallback <agentId:modelId>]... [--config-option <id=value>]... [--mode <modeId>] [--allow-rate-limited-fallback]

Discovery is live and compact; no model or agent is selected automatically.
Execution requires an exact agent and model. Fallbacks are caller supplied.`;
}

async function connectLocalServer(server: ReturnType<typeof createMcpServer>) {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  let nextId = 0;
  const pending = new Map<number, (reply: RpcReply) => void>();
  client.onmessage = (message) => {
    if (
      "id" in message && typeof message.id === "number" &&
      pending.has(message.id)
    ) {
      pending.get(message.id)!(message as RpcReply);
      pending.delete(message.id);
    }
  };
  await client.start();

  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    const reply = new Promise<RpcReply>((resolve) => pending.set(id, resolve));
    void client.send({ jsonrpc: "2.0", id, method, params } as never);
    return { id, reply };
  };
  const initialize = request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "acp-mcp-planning-workflow", version: "1" },
  });
  const initialized = await initialize.reply;
  if (initialized.error) {
    throw new Error("Could not initialize local MCP server");
  }
  await client.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  } as never);

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const { id, reply } = request("tools/call", {
      name,
      arguments: args,
    });
    const cancel = () => {
      void client.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, reason: "planning workflow cancelled" },
      } as never);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await reply;
      if (response.error) throw new Error("MCP tool request failed");
      const text = response.result?.content?.find((item) =>
        item.type === "text"
      )
        ?.text;
      if (!text) throw new Error("MCP tool returned no structured result");
      return JSON.parse(text) as Record<string, unknown>;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };

  return {
    callTool,
    close: () => client.close(),
  };
}

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs(Deno.args);
} catch (error) {
  console.error(`${error}\n${usage()}`);
  Deno.exit(2);
}

const abortController = new AbortController();
const onInterrupt = () => abortController.abort();
Deno.addSignalListener("SIGINT", onInterrupt);
const startup = await resolveConfiguration({
  explicitConfigPath: parsed.configPath,
  cwd: parsed.repository,
  includeProject: false,
});
const agents = startup.agents;
const manager = new SessionManager(agents);
const server = createMcpServer(agents, manager, {
  resolveConfiguration: () =>
    resolveConfiguration({
      explicitConfigPath: parsed.configPath,
      cwd: parsed.repository,
    }),
});
let local: Awaited<ReturnType<typeof connectLocalServer>> | undefined;
const workspaceHandles = new Set<string>();
try {
  local = await connectLocalServer(server);
  const listModels = async (
    agentId: string,
    cwd: string,
    signal: AbortSignal = abortController.signal,
  ): Promise<PlanningModelList> => {
    const value = await local!.callTool("list_models", {
      agentId,
      cwd,
      enrich: true,
    }, signal);
    return {
      status: value.status === "completed"
        ? "completed"
        : value.status === "timed_out"
        ? "timed_out"
        : value.stage === "cancelled"
        ? "cancelled"
        : "failed",
      models: Array.isArray(value.models)
        ? value.models as PlanningModelList["models"]
        : [],
    };
  };
  const trackSnapshot = <T extends { cwd: string; cleanup(): Promise<void> }>(
    snapshot: T,
  ): T => {
    workspaceHandles.add(snapshot.cwd);
    const cleanup = snapshot.cleanup.bind(snapshot);
    snapshot.cleanup = async () => {
      await cleanup();
      workspaceHandles.delete(snapshot.cwd);
    };
    return snapshot;
  };
  const withListing = async <T>(
    fn: (cwd: string) => Promise<T>,
  ): Promise<T> => {
    const canonical = await createWorkspaceSnapshot(parsed.repository);
    trackSnapshot(canonical);
    try {
      const discovery = trackSnapshot(
        await cloneWorkspaceSnapshot(canonical.cwd),
      );
      try {
        return await fn(discovery.cwd);
      } finally {
        await discovery.cleanup();
      }
    } finally {
      await canonical.cleanup();
    }
  };
  const withClone = async <T>(
    canonicalPath: string,
    fn: (cwd: string) => Promise<T>,
  ) => {
    const clone = trackSnapshot(await cloneWorkspaceSnapshot(canonicalPath));
    try {
      return await fn(clone.cwd);
    } finally {
      await clone.cleanup();
    }
  };
  if (parsed.operation === "models") {
    const listing = await withListing((cwd) => listModels(parsed.agentId, cwd));
    if (listing.status !== "completed") {
      console.log(
        JSON.stringify({ status: listing.status, agentId: parsed.agentId }),
      );
      Deno.exitCode = 1;
    } else {
      const summary = summarizeModelCandidates(listing.models ?? [], {
        privacyPolicy: parsed.privacyPolicy,
        costPolicy: parsed.costPolicy,
        search: parsed.search,
        offset: parsed.offset,
        limit: parsed.limit,
      });
      console.log(
        JSON.stringify({
          status: "completed",
          agentId: parsed.agentId,
          ...summary,
        }),
      );
    }
  } else if (parsed.operation === "configs") {
    const output = await withListing(async (cwd) => {
      const listing = await listModels(parsed.agentId, cwd);
      const selected = listing.models?.find((model) =>
        model.available && model.id === parsed.modelId
      );
      if (listing.status !== "completed" || !selected) {
        return {
          status: "failed",
          reason: listing.status === "completed"
            ? "not_advertised"
            : "model_discovery_failed",
          agentId: parsed.agentId,
          modelId: parsed.modelId,
        };
      }
      const started = await local!.callTool("start_session", {
        agentId: parsed.agentId,
        cwd,
        config: { [selected.configId]: selected.id },
        permissionPolicy: "read_only",
      }, abortController.signal);
      if (typeof started.sessionId !== "string") {
        throw new Error(
          "ACP session could not be started for config discovery",
        );
      }
      const sessionId = started.sessionId;
      try {
        const session = await local!.callTool("get_session", { sessionId });
        const options = Array.isArray(session.configOptions)
          ? session.configOptions as Array<Record<string, unknown>>
          : [];
        const configs = options.filter((option) => option.category !== "model")
          .map((option) => ({
            id: option.id,
            name: option.name,
            category: option.category,
            currentValue: option.currentValue,
            options: Array.isArray(option.options)
              ? option.options.slice(0, 40).map((choice) => {
                const item = choice as Record<string, unknown>;
                return { value: item.value, name: item.name };
              })
              : [],
            optionsTruncated: Array.isArray(option.options) &&
              option.options.length > 40,
          }));
        return {
          status: "completed",
          agentId: parsed.agentId,
          modelId: parsed.modelId,
          configs,
        };
      } finally {
        await local!.callTool("close_session", { sessionId });
      }
    });
    console.log(JSON.stringify(output));
    if (output.status !== "completed") Deno.exitCode = 1;
  } else {
    const workflowResult = await runPlanningWorkflow({
      repository: parsed.repository,
      task: parsed.task,
      selected: parsed.selected,
      fallbacks: parsed.fallbacks,
      privacyPolicy: parsed.privacyPolicy,
      costPolicy: parsed.costPolicy,
      config: parsed.config,
      modeId: parsed.modeId,
      allowRateLimitedFallback: parsed.allowRateLimitedFallback,
      ...(parsed.maxAttempts !== undefined
        ? { maxAttempts: parsed.maxAttempts }
        : {}),
      signal: abortController.signal,
    }, {
      async createSnapshot(repository) {
        return trackSnapshot(await createWorkspaceSnapshot(repository));
      },
      async cloneSnapshot(path) {
        return trackSnapshot(await cloneWorkspaceSnapshot(path));
      },
      async listModels(agentId, cwd, signal): Promise<PlanningModelList> {
        return await listModels(agentId, cwd, signal);
      },
      async validateConfiguration(args) {
        return await withClone(args.canonicalSnapshotPath, async (cwd) => {
          const started = await local!.callTool("start_session", {
            agentId: args.agentId,
            cwd,
            config: { [args.configId]: args.modelId },
            permissionPolicy: "read_only",
          }, abortController.signal);
          if (typeof started.sessionId !== "string") {
            return { valid: false, reason: "config_session_start_failed" };
          }
          const sessionId = started.sessionId;
          try {
            const session = await local!.callTool("get_session", { sessionId });
            const options = Array.isArray(session.configOptions)
              ? session.configOptions as Array<Record<string, unknown>>
              : [];
            for (const [id, value] of Object.entries(args.config ?? {})) {
              if (id === args.configId) {
                return {
                  valid: false,
                  reason: "model_config_is_selected_separately",
                };
              }
              const option = options.find((entry) => entry.id === id);
              const advertised = Array.isArray(option?.options) &&
                option.options.some((choice) =>
                  (choice as Record<string, unknown>).value === value
                );
              if (!advertised) {
                return { valid: false, reason: "config_value_not_advertised" };
              }
            }
            if (args.modeId) {
              const mode = options.find((entry) =>
                entry.category === "mode" || entry.id === "mode"
              );
              const advertised = Array.isArray(mode?.options) &&
                mode.options.some((choice) =>
                  (choice as Record<string, unknown>).value === args.modeId
                );
              if (!advertised) {
                return { valid: false, reason: "mode_not_advertised" };
              }
            }
            return { valid: true };
          } finally {
            await local!.callTool("close_session", { sessionId });
          }
        });
      },
      async runTask(args): Promise<PlanningTaskResult> {
        const config = {
          ...(args.config ?? {}),
          [args.configId]: args.modelId,
        };
        const value = await local!.callTool("run_task", {
          agentId: args.agentId,
          task: args.task,
          cwd: args.cwd,
          config,
          ...(args.modeId ? { modeId: args.modeId } : {}),
          permissionPolicy: "read_only",
        }, args.signal);
        return value as unknown as PlanningTaskResult;
      },
    });
    console.log(JSON.stringify(workflowResult));
    if (workflowResult.status !== "completed") Deno.exitCode = 1;
    if (abortController.signal.aborted) Deno.exitCode = 130;
  }
} catch (error) {
  console.error(String(error));
  console.log(
    JSON.stringify({ status: "failed", reason: "workflow_setup_failed" }),
  );
  Deno.exitCode = abortController.signal.aborted ? 130 : 1;
} finally {
  Deno.removeSignalListener("SIGINT", onInterrupt);
  try {
    await local?.close();
  } finally {
    await manager.closeAll();
    await server.close();
    for (const workspace of workspaceHandles) {
      try {
        await (await import("../src/workspaces/snapshot.ts"))
          .cleanupWorkspaceSnapshot(workspace);
      } catch (error) {
        console.error(
          `Disposable workspace may remain at ${workspace}: ${error}`,
        );
      }
    }
  }
}
