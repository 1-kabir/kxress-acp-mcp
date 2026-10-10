import { createMcpServer } from "../src/mcp/server.ts";
import type { AgentMap } from "../src/agents/config.ts";
import {
  economicTier,
  enrichAdvertisedModels,
  fetchOpenCodeCatalog,
  OPENCODE_GO_DOCS_URL,
  OPENCODE_GO_MODELS_URL,
  OPENCODE_ZEN_DOCS_URL,
  OPENCODE_ZEN_MODELS_URL,
} from "../src/models/opencode_catalog.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { discoverAdvertisedModels } from "../src/models/discovery.ts";
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
    ) => Promise<Awaited<ReturnType<typeof fetchOpenCodeCatalog>>>;
  } = {},
) {
  const agents: AgentMap = Object.fromEntries(agentIds.map((id) => [
    id,
    {
      ...(id === "models" || id === "opencode" || id === "generic"
        ? modelFixture
        : {
          command: Deno.execPath(),
          args: [
            "run",
            "--allow-env",
            "--allow-read",
            "tests/fixtures/fake_acp_agent.ts",
            ...(id === "bad" ? ["--session-fail"] : []),
            ...(id === "slow" ? ["--session-delay-ms=150"] : []),
            ...(id === "async-models" ? ["--async-models"] : []),
            ...(id === "bool" ? ["--advertise-bool"] : []),
          ],
        }),
      ...(id === "models" ? { modelConfigId: "backend-choice" } : {}),
      ...(id === "opencode"
        ? {
          modelConfigId: "model",
          modelEnrichment: "opencode_catalog" as const,
        }
        : {}),
      ...(id === "async-models" ? { modelConfigId: "model" } : {}),
    },
  ]));
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager, options);
  return { agents, manager, server };
}

const mockCatalog = () =>
  fetchOpenCodeCatalog(
    new AbortController().signal,
    (input) => {
      const url = String(input);
      if (url === OPENCODE_ZEN_MODELS_URL) {
        return Promise.resolve(Response.json({
          data: [
            { id: "fledge-alpha-free", owned_by: "opencode" },
            { id: "space-bunny-free", owned_by: "opencode" },
            { id: "remote-only-model", owned_by: "opencode" },
            { id: "paid-model", owned_by: "opencode" },
            { id: "jev-1.13-free", owned_by: "opencode" },
            { id: "jev-1.13", owned_by: "opencode" },
            { id: "longcat-2.5-preview-free", owned_by: "opencode" },
            { id: "example-free", owned_by: "opencode" },
            { id: "example", owned_by: "opencode" },
            { id: "muse-spark-1.3-contributor-free", owned_by: "opencode" },
            { id: "nemotron-3-ultra-free", owned_by: "opencode" },
          ],
        }));
      }
      if (url === OPENCODE_ZEN_DOCS_URL) {
        return Promise.resolve(
          new Response(`
        <table><tr><th>Model</th><th>ID</th></tr>
        <tr><td>Fledge Alpha Free</td><td>fledge-alpha-free</td></tr>
        <tr><td>Paid Model</td><td>paid-model</td></tr>
        <tr><td>Jev 1.13 Free</td><td>jev-1.13-free</td></tr>
        <tr><td>Jev 1.13</td><td>jev-1.13</td></tr>
        <tr><td>Space Bunny Free</td><td>space-bunny-free</td></tr>
        <tr><td>LongCat 2.5 Preview Free</td><td>longcat-2.5-preview-free</td></tr>
        <tr><td>Example Free</td><td>example-free</td></tr>
        <tr><td>Example</td><td>example</td></tr>
        <tr><td>Muse Spark 1.3 Contributor Free</td><td>muse-spark-1.3-contributor-free</td></tr>
        <tr><td>Nemotron 3 Ultra Free</td><td>nemotron-3-ultra-free</td></tr></table>
        <table><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th></tr>
        <tr><td>Fledge Alpha Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
        <tr><td>Space Bunny Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
        <tr><td>Paid Model</td><td>$0.25</td><td>$1.50</td><td>$0.05</td><td>$0.10</td></tr>
        <tr><td>Jev 1.13 Free</td><td>Free</td><td>Free</td><td>-</td><td>-</td></tr>
        <tr><td>Jev 1.13</td><td>$0.042</td><td>Free</td><td>-</td><td>-</td></tr>
        <tr><td>LongCat 2.5 Preview Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
        <tr><td>Example Free</td><td>Free</td><td>Free</td><td>-</td><td>-</td></tr>
        <tr><td>Example</td><td>$0.20</td><td>$1.30</td><td>-</td><td>-</td></tr>
        <tr><td>Muse Spark 1.3 Contributor Free</td><td>Free</td><td>Free</td><td>-</td><td>-</td></tr>
        <tr><td>Nemotron 3 Ultra Free</td><td>Free</td><td>Free</td><td>-</td><td>-</td></tr></table>
        <h2>Privacy</h2>
        <p>All our models are hosted in the US and EU. Providers follow zero-retention and do not use data for model training, except:</p>
        <ul>
          <li>Fledge Alpha Free: Collected data may be used to improve the model.</li>
          <li>Space Bunny Free: Provider follows zero-retention and does not use data for model training.</li>
          <li>LongCat 2.5 Preview Free: Provider follows zero-retention and does not use data for model training.</li>
          <li>Muse Spark 1.3 Contributor Free: Prompts and completions may be used for future Meta model training.</li>
          <li>Nemotron 3 Ultra Free: Trial prompts are logged for security and product improvement.</li>
        </ul>
      `),
        );
      }
      if (url === OPENCODE_GO_MODELS_URL) {
        return Promise.resolve(Response.json({
          data: [
            { id: "space-bunny", owned_by: "opencode" },
            { id: "longcat-2.5-preview-free", owned_by: "opencode" },
            { id: "muse-spark-1.3-contributor", owned_by: "opencode" },
          ],
        }));
      }
      if (url === OPENCODE_GO_DOCS_URL) {
        return Promise.resolve(
          new Response(`
          <table><tr><th>Model</th><th>Model ID</th><th>Endpoint</th></tr>
            <tr><td>Space Bunny</td><td>space-bunny</td><td>go</td></tr>
            <tr><td>LongCat 2.5 Preview Free</td><td>longcat-2.5-preview-free</td><td>go</td></tr>
            <tr><td>Muse Spark 1.3 Contributor</td><td>muse-spark-1.3-contributor</td><td>go</td></tr>
          </table>
          <table><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Monthly limit</th></tr>
            <tr><td>Space Bunny</td><td>$0.15</td><td>$0.60</td><td>$0.03</td><td>-</td><td>$120</td></tr>
            <tr><td>LongCat 2.5 Preview Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td><td>Unlimited</td></tr>
            <tr><td>Muse Spark 1.3 Contributor</td><td>$0.10</td><td>$0.20</td><td>$0.002</td><td>-</td><td>$120</td></tr>
          </table>
          <table><tr><th>Model</th><th>Model training</th><th>Data retention</th></tr>
            <tr><td>Space Bunny</td><td>Not used</td><td>0 days</td></tr>
            <tr><td>LongCat 2.5 Preview Free</td><td>Not used</td><td>0 days</td></tr>
            <tr><td>Muse Spark 1.3 Contributor</td><td>Yes</td><td>Not ZDR</td></tr>
          </table>
        `),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    },
  );

Deno.test("MCP advertises canonical high-level tool names without aliases", async () => {
  const { server, manager } = serverFor(["plain"]);
  const mcp = await connectMcp(server);
  try {
    const reply = await mcp.listTools().response as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = (reply.result?.tools ?? []).map((tool) => tool.name);
    for (const expected of ["run_task", "list_models", "list_agents"]) {
      if (!names.includes(expected)) {
        throw new Error(`Missing canonical tool ${expected}`);
      }
    }
    for (const removed of ["delegate", "discover_models"]) {
      if (names.includes(removed)) {
        throw new Error(`Deprecated tool ${removed} is still advertised`);
      }
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("generic model discovery uses ACP options and cleans its temporary session", async () => {
  const { manager, server } = serverFor(["models"]);
  const mcp = await connectMcp(server);
  try {
    const result = parseToolResult(
      await mcp.callTool("list_models", {
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

Deno.test("asynchronous ACP config updates drive model discovery and selection", async () => {
  const { manager, server } = serverFor(["async-models"]);
  const mcp = await connectMcp(server);
  try {
    const discovered = parseToolResult(
      await mcp.callTool("list_models", {
        agentId: "async-models",
        timeoutMs: 2_000,
      }).response,
    );
    const models = discovered.models as Array<Record<string, unknown>>;
    const expected = [
      "claude-opus-5-5-low",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-high",
    ];
    if (
      JSON.stringify(models.map((model) => model.id)) !==
        JSON.stringify(expected)
    ) {
      throw new Error("Late advertised model IDs were not preserved exactly");
    }
    if (manager.sessions.size !== 0) {
      throw new Error("Asynchronous discovery leaked its temporary session");
    }

    const started = parseToolResult(
      await mcp.callTool("start_session", {
        agentId: "async-models",
        config: { model: "claude-opus-5-5-high" },
      }).response,
    );
    const sessionId = started.sessionId as string;
    const session = manager.get(sessionId);
    const selected = session.configOptions.find((option) =>
      option.id === "model"
    );
    if (selected?.currentValue !== "claude-opus-5-5-high") {
      throw new Error("Late model selection was not applied to the session");
    }
    if (
      !manager.getEvents(sessionId).events.some((event) =>
        event.kind === "config_option_update"
      )
    ) {
      throw new Error("The asynchronous config update was not journaled");
    }
    await mcp.callTool("close_session", { sessionId }).response;
    if (manager.sessions.size !== 0) {
      throw new Error("Closing the async-config session leaked it");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});

Deno.test("unprofiled agents use ACP model categories and ignore conflicting profile fallbacks", async () => {
  const { server, manager } = serverFor(["generic"]);
  const mcp = await connectMcp(server);
  try {
    const result = parseToolResult(
      await mcp.callTool("list_models", { agentId: "generic" }).response,
    );
    const models = result.models as Array<Record<string, unknown>>;
    if (
      models.length !== 3 ||
      models.some((model) => model.id === "local/model-z")
    ) {
      throw new Error(
        "An unprofiled agent did not use only its ACP model category",
      );
    }
    const conflicting = discoverAdvertisedModels([{
      id: "configured-model-id",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [{ value: "high", name: "High" }],
    }], {
      command: "agent",
      args: [],
      modelConfigId: "configured-model-id",
    });
    if (conflicting.length) {
      throw new Error("A profile overrode an explicit ACP non-model category");
    }
    if (manager.sessions.size) {
      throw new Error("Unprofiled model listing leaked its temporary session");
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
      await mcp.callTool("list_models", {
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
      await mcp.callTool("list_models", {
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
      (result.enrichment as Record<string, unknown>).source !==
        "opencode_catalog"
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

Deno.test("OpenCode pricing, counterpart, tier, privacy, and provenance stay distinct", async () => {
  const catalog = await mockCatalog();
  const fledge = catalog.models.get("opencode/fledge-alpha-free");
  if (
    fledge?.free !== true || fledge.pricingStatus !== "limited_time" ||
    fledge.underlyingCostTier || fledge.paidCounterpart?.id
  ) {
    throw new Error(
      "Fledge's current promotional price was incorrectly treated as its underlying tier or counterpart",
    );
  }
  if (
    fledge.privacy?.trainingUse !== "may_be_used_for_improvement" ||
    fledge.privacy.retention !== undefined ||
    fledge.privacy.sourceUrl !== OPENCODE_ZEN_DOCS_URL
  ) {
    throw new Error("Fledge privacy metadata was not conservative/provenanced");
  }

  const longcat = catalog.models.get(
    "opencode/longcat-2.5-preview-free",
  );
  if (
    longcat?.privacy?.trainingUse !== "not_used_for_training" ||
    longcat.privacy.retention !== "zero" ||
    longcat.privacy.sourceUrl !== OPENCODE_ZEN_DOCS_URL
  ) throw new Error("Documented LongCat privacy facts were not retained");

  const museSpark = catalog.models.get(
    "opencode/muse-spark-1.3-contributor-free",
  );
  if (
    museSpark?.privacy?.trainingUse !== "may_be_used_for_training" ||
    museSpark.privacy.retention !== "not_zero" ||
    museSpark.privacy.sourceUrl !== OPENCODE_ZEN_DOCS_URL
  ) throw new Error("Documented Muse Spark data use was not normalized");
  const nemotron = catalog.models.get("opencode/nemotron-3-ultra-free");
  if (
    nemotron?.privacy?.trainingUse !== "may_be_used_for_improvement" ||
    nemotron.privacy.retention !== "not_zero"
  ) throw new Error("Documented Nemotron trial data use was not normalized");

  const jevFree = catalog.models.get("opencode/jev-1.13-free");
  if (
    jevFree?.paidCounterpart?.id !== "opencode/jev-1.13" ||
    jevFree.privacy?.trainingUse !== "not_used_for_training" ||
    jevFree.privacy.retention !== "provider_policy" ||
    jevFree.paidCounterpart.relation !== "exact_paid_counterpart" ||
    jevFree.paidCounterpart.pricing.input !== 0.042 ||
    jevFree.paidCounterpart.pricing.output !== 0 ||
    jevFree.underlyingCostTier?.value !== "low" ||
    jevFree.underlyingCostTier.basis !== "paid_counterpart" ||
    jevFree.underlyingCostTier.counterpartId !== "opencode/jev-1.13" ||
    jevFree.underlyingCostTier.confidence !== "documented_counterpart" ||
    jevFree.underlyingCostTier.sourceUrl !== OPENCODE_ZEN_DOCS_URL
  ) throw new Error("Documented Jev counterpart/tier was not derived");

  const directPriced = catalog.models.get("opencode/paid-model");
  if (
    directPriced?.underlyingCostTier?.value !== "medium" ||
    directPriced.underlyingCostTier.basis !== "published_pricing" ||
    directPriced.underlyingCostTier.confidence !== "direct" ||
    directPriced.underlyingCostTier.sourceUrl !== OPENCODE_ZEN_DOCS_URL
  ) throw new Error("Published-price tier or provenance was not retained");

  const unrelatedFree = catalog.models.get("opencode/example-free");
  if (
    unrelatedFree?.free !== true || unrelatedFree.pricingStatus ||
    unrelatedFree.paidCounterpart || unrelatedFree.underlyingCostTier
  ) throw new Error("Name similarity fabricated promotional/counterpart facts");
  if (
    catalog.models.get("opencode/remote-only-model")?.privacy ||
    catalog.models.get("opencode/remote-only-model")?.underlyingCostTier
  ) throw new Error("Unsupported metadata was fabricated for an unknown model");

  const goSpaceBunny = catalog.models.get("opencode-go/space-bunny");
  if (
    goSpaceBunny?.pricing?.input !== 0.15 ||
    goSpaceBunny.pricing.output !== 0.6 ||
    goSpaceBunny.underlyingCostTier?.value !== "low" ||
    goSpaceBunny.subscriptionRequired !== true ||
    goSpaceBunny.privacy?.trainingUse !== "not_used_for_training" ||
    goSpaceBunny.privacy.retention !== "zero" ||
    goSpaceBunny.provenance?.source !== "opencode_go"
  ) throw new Error("OpenCode Go pricing/privacy metadata was not parsed");

  const goLongcat = catalog.models.get(
    "opencode-go/longcat-2.5-preview-free",
  );
  if (
    goLongcat?.free !== true || goLongcat.subscriptionRequired !== true ||
    goLongcat.pricingStatus !== "limited_time" ||
    goLongcat.underlyingCostTier || goLongcat.paidCounterpart
  ) throw new Error("Go subscription/free-price distinction was lost");

  const goMuse = catalog.models.get(
    "opencode-go/muse-spark-1.3-contributor",
  );
  if (
    goMuse?.privacy?.trainingUse !== "may_be_used_for_training" ||
    goMuse.privacy.retention !== "not_zero" ||
    goMuse.subscriptionRequired !== true
  ) throw new Error("OpenCode Go model-specific training terms were lost");

  const enrichedGo = enrichAdvertisedModels([{
    id: "opencode-go/space-bunny",
    name: "opencode-go/Space Bunny",
    configId: "model",
    available: true,
    selected: true,
    availabilitySource: "acp",
  }], catalog)[0];
  const enrichedGoMetadata = enrichedGo.metadata as
    | Record<string, unknown>
    | undefined;
  if (
    enrichedGo.available !== true || enrichedGoMetadata?.free !== false ||
    enrichedGoMetadata.subscriptionRequired !== true
  ) throw new Error("OpenCode Go metadata did not enrich the ACP model");

  const zenSpaceBunny = catalog.models.get("opencode/space-bunny-free");
  if (
    zenSpaceBunny?.paidCounterpart || zenSpaceBunny?.underlyingCostTier
  ) throw new Error("Name similarity fabricated a Space Bunny counterpart");
});

Deno.test("underlying economic tiers use deterministic published-price bands", () => {
  const tier = (input: number, output: number) =>
    economicTier({
      currency: "USD",
      unit: "per_million_tokens",
      input,
      output,
    });
  if (
    tier(0.5, 0.99) !== "low" || tier(1, 4.99) !== "medium" ||
    tier(5, 19.99) !== "high" || tier(20, 0) !== "premium" ||
    tier(0, 0) !== undefined || economicTier(undefined) !== undefined
  ) throw new Error("Economic price bands or unknown handling changed");
});

Deno.test("metadata failure preserves ACP availability and ACP failure remains an error", async () => {
  const { server, manager } = serverFor(["opencode", "bad"], {
    loadOpenCodeCatalog: () =>
      Promise.reject(new Error("metadata unavailable")),
  });
  const mcp = await connectMcp(server);
  try {
    const partial = parseToolResult(
      await mcp.callTool("list_models", {
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
      await mcp.callTool("list_models", {
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
      await mcp.callTool("list_models", {
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

    const request = mcp.callTool("list_models", { agentId: "slow" });
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
