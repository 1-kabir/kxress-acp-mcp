import { InMemoryTransport } from "@modelcontextprotocol/server";
import { loadAgents } from "../src/agents/config.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import {
  type PlannerCandidate,
  type PlanningModelList,
  type PlanningPrivacyPolicy,
  type PlanningTaskResult,
  runPlanningWorkflow,
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
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--allow-rate-limited-fallback") {
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
  const privacyPolicy = one("--privacy-policy", true) as PlanningPrivacyPolicy;
  if (
    ![
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
  return {
    repository: one("--repo", true)!,
    task: one("--task", true)!,
    preferred: parseCandidate(
      one("--preferred") ?? "opencode:opencode/nemotron-3-ultra-free",
    ),
    fallbacks: (values.get("--fallback") ?? []).map(parseCandidate),
    privacyPolicy,
    allowRateLimitedFallback: flags.has("--allow-rate-limited-fallback"),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    configPath: one("--config"),
  };
}

function usage() {
  return `Usage: deno run --allow-env --allow-read --allow-write --allow-run --allow-net=opencode.ai scripts/planning_workflow.ts --repo <path> --task <text> --privacy-policy <allow_any|require_no_training|require_no_training_and_zero_retention> [--preferred <agentId:modelId>] [--fallback <agentId:modelId>]... [--allow-rate-limited-fallback] [--max-attempts <1..5>] [--config <path>]

The preferred model defaults to opencode:opencode/nemotron-3-ultra-free.
Fallback candidates are never added automatically. Heuristic rate-limit
fallback requires --allow-rate-limited-fallback.`;
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
const agents = await loadAgents(parsed.configPath);
const manager = new SessionManager(agents);
const server = createMcpServer(agents, manager);
let local: Awaited<ReturnType<typeof connectLocalServer>> | undefined;
try {
  local = await connectLocalServer(server);
  const workflowResult = await runPlanningWorkflow({
    ...parsed,
    signal: abortController.signal,
  }, {
    async createSnapshot(repository) {
      return await createWorkspaceSnapshot(repository);
    },
    async cloneSnapshot(path) {
      return await cloneWorkspaceSnapshot(path);
    },
    async listModels(agentId, cwd, signal): Promise<PlanningModelList> {
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
    },
    async runTask(args): Promise<PlanningTaskResult> {
      const value = await local!.callTool("run_task", {
        agentId: args.agentId,
        task: args.task,
        cwd: args.cwd,
        config: { [args.configId]: args.modelId },
        permissionPolicy: "read_only",
      }, args.signal);
      return value as unknown as PlanningTaskResult;
    },
  });
  console.log(JSON.stringify(workflowResult));
  if (workflowResult.status !== "completed") Deno.exitCode = 1;
  if (abortController.signal.aborted) Deno.exitCode = 130;
} catch (error) {
  console.log(JSON.stringify({
    status: "failed",
    stopReason: "workflow_setup_failed",
    attempts: [],
    cleanupWarnings: [],
  }));
  console.error(String(error));
  Deno.exitCode = 1;
} finally {
  Deno.removeSignalListener("SIGINT", onInterrupt);
  try {
    await local?.close();
  } finally {
    await manager.closeAll();
    await server.close();
  }
}
