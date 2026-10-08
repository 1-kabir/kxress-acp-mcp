import { createMcpServer } from "../src/mcp/server.ts";
import type { AgentMap } from "../src/agents/config.ts";
import {
  fetchOpenCodeZenCatalog,
  OPENCODE_ZEN_DOCS_URL,
  OPENCODE_ZEN_MODELS_URL,
} from "../src/models/opencode_zen.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

const modelFixture = {
  command: Deno.execPath(),
  args: [
    "run",
    "--allow-env",
    "--allow-read",
    "tests/fixtures/fake_acp_agent.ts",
    "--advertise-models",
  ],
};

function serverFor(
  agentIds: string[],
  options: {
    loadOpenCodeCatalog?: (
      signal: AbortSignal,
    ) => Promise<Awaited<ReturnType<typeof fetchOpenCodeZenCatalog>>>;
  } = {},
) {
  const agents: AgentMap = Object.fromEntries(agentIds.map((id) => [
    id,
    {
      ...(id === "models" || id === "opencode" ? modelFixture : {
        command: Deno.execPath(),
        args: [
          "run",
          "--allow-env",
          "--allow-read",
          "tests/fixtures/fake_acp_agent.ts",
          ...(id === "bad" ? ["--session-fail"] : []),
          ...(id === "slow" ? ["--session-delay-ms=150"] : []),
        ],
      }),
      ...(id === "models" ? { modelConfigId: "backend-choice" } : {}),
      ...(id === "opencode"
        ? { modelConfigId: "model", modelEnrichment: "opencode_zen" as const }
        : {}),
    },
  ]));
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager, options);
  return { agents, manager, server };
}

const mockCatalog = () =>
  fetchOpenCodeZenCatalog(
    new AbortController().signal,
    (input) => {
      const url = String(input);
      if (url === OPENCODE_ZEN_MODELS_URL) {
        return Promise.resolve(Response.json({
          data: [
            { id: "fledge-alpha-free", owned_by: "opencode" },
            { id: "remote-only-model", owned_by: "opencode" },
            { id: "paid-model", owned_by: "opencode" },
          ],
        }));
      }
      if (url === OPENCODE_ZEN_DOCS_URL) {
        return Promise.resolve(
          new Response(`
        <table><tr><th>Model</th><th>ID</th></tr>
        <tr><td>Fledge Alpha Free</td><td>fledge-alpha-free</td></tr>
        <tr><td>Paid Model</td><td>paid-model</td></tr></table>
        <table><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th></tr>
        <tr><td>Fledge Alpha Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
        <tr><td>Paid Model</td><td>$0.25</td><td>$1.50</td><td>$0.05</td><td>$0.10</td></tr></table>
      `),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    },
  );

Deno.test("generic model discovery uses ACP options and cleans its temporary session", async () => {
  const { manager, server } = serverFor(["models"]);
  const mcp = await connectMcp(server);
  try {
    const result = parseToolResult(
      await mcp.callTool("discover_models", {
        agentId: "models",
      }).response,
    );
    const models = result.models as Array<Record<string, unknown>>;
    if (result.status !== "completed" || result.availabilitySource !== "acp") {
      throw new Error("Generic discovery did not report ACP availability");
    }
    if (models.length !== 4) {
      throw new Error(`Expected 3 advertised models, got ${models.length}`);
    }
    if (
      models.some((model) =>
        model.id === "hidden/model" || model.id === "remote-only-model"
      )
    ) {
      throw new Error("A non-model option or remote-only model was exposed");
    }
    const tagged = models.find((model) =>
      model.id === "opencode/fledge-alpha-free"
    );
    const mapped = models.find((model) => model.id === "local/model-z");
    if (tagged?.configId !== "engine-selector" || tagged.selected !== true) {
      throw new Error("Model-category option or selected ID was not retained");
    }
    if (mapped?.configId !== "backend-choice") {
      throw new Error("Profile modelConfigId mapping was not applied");
    }
    if (manager.sessions.size !== 0) {
      throw new Error("Discovery leaked its temporary session");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("no advertised model option returns an empty generic model list", async () => {
  const { manager, server } = serverFor(["plain"]);
  const mcp = await connectMcp(server);
  try {
    const result = parseToolResult(
      await mcp.callTool("discover_models", {
        agentId: "plain",
      }).response,
    );
    if (
      result.status !== "completed" || (result.models as unknown[]).length !== 0
    ) {
      throw new Error(
        "Agent without model options should return an empty list",
      );
    }
    if (manager.sessions.size !== 0) {
      throw new Error("Empty discovery leaked its session");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("OpenCode enrichment exactly matches ACP-advertised IDs and normalizes official pricing", async () => {
  const { server, manager } = serverFor(["opencode"], {
    loadOpenCodeCatalog: () => mockCatalog(),
  });
  const mcp = await connectMcp(server);
  try {
    const result = parseToolResult(
      await mcp.callTool("discover_models", {
        agentId: "opencode",
        enrich: true,
      }).response,
    );
    const models = result.models as Array<Record<string, unknown>>;
    if (models.length !== 3) {
      throw new Error("Enrichment changed ACP availability");
    }
    if (models.some((model) => model.id === "opencode/remote-only-model")) {
      throw new Error(
        "Remote-only model was added to the available model list",
      );
    }
    const free = models.find((model) =>
      model.id === "opencode/fledge-alpha-free"
    );
    const freeMetadata = free?.metadata as Record<string, unknown> | undefined;
    const pricing = freeMetadata?.pricing as
      | Record<string, unknown>
      | undefined;
    if (
      free?.available !== true || freeMetadata?.free !== true ||
      pricing?.input !== 0
    ) {
      throw new Error("Official free-model metadata was not attached");
    }
    if (
      result.enrichment &&
      (result.enrichment as Record<string, unknown>).source !== "opencode_zen"
    ) {
      throw new Error("Enrichment provenance was not retained");
    }
    const wrongProvider = models.find((model) => model.id === "local/model-z");
    if (wrongProvider?.metadata) {
      throw new Error("Metadata crossed an unrelated provider namespace");
    }
    const unmatched = models.find((model) =>
      model.id === "opencode/available-without-metadata"
    );
    if (unmatched?.available !== true || unmatched.metadata) {
      throw new Error(
        "Unmatched advertised model lost availability or gained fabricated metadata",
      );
    }
    const paid = models.find((model) => model.id === "opencode/paid-model");
    const paidPricing = (paid?.metadata as Record<string, unknown> | undefined)
      ?.pricing as Record<string, unknown> | undefined;
    if (paidPricing?.input !== 0.25 || paidPricing.output !== 1.5) {
      throw new Error("Paid model pricing was not normalized");
    }
    if (manager.sessions.size !== 0) {
      throw new Error("Enriched discovery leaked its temporary session");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("metadata failure preserves ACP availability and ACP failure remains an error", async () => {
  const { server, manager } = serverFor(["opencode", "bad"], {
    loadOpenCodeCatalog: () =>
      Promise.reject(new Error("metadata unavailable")),
  });
  const mcp = await connectMcp(server);
  try {
    const partial = parseToolResult(
      await mcp.callTool("discover_models", {
        agentId: "opencode",
        enrich: true,
      }).response,
    );
    if (
      partial.status !== "completed" ||
      (partial.models as unknown[]).length !== 3
    ) {
      throw new Error("Enrichment failure discarded ACP-advertised models");
    }
    if (
      (partial.enrichment as Record<string, unknown>).status !== "unavailable"
    ) {
      throw new Error("Metadata failure was not reported compactly");
    }
    const failure = parseToolResult(
      await mcp.callTool("discover_models", {
        agentId: "bad",
      }).response,
    );
    if (failure.status !== "failed" || failure.stage !== "acp_discovery") {
      throw new Error(
        "ACP discovery failure was not distinguished from metadata failure",
      );
    }
    if (manager.sessions.size !== 0) {
      throw new Error("Failure cleanup did not leave the server clean");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("model discovery timeout and MCP cancellation close late sessions", async () => {
  const { server, manager } = serverFor(["slow"]);
  const mcp = await connectMcp(server);
  try {
    const timeout = parseToolResult(
      await mcp.callTool("discover_models", {
        agentId: "slow",
        timeoutMs: 10,
      }).response,
    );
    if (timeout.status !== "timed_out") {
      throw new Error(
        "Timed-out ACP discovery did not return a compact timeout status",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (manager.sessions.size !== 0) {
      throw new Error("Late timed-out session was not closed");
    }

    const request = mcp.callTool("discover_models", { agentId: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await mcp.cancel(request.id);
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (manager.sessions.size !== 0) {
      throw new Error("Cancelled discovery leaked a late session");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});
