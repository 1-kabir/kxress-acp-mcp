import { test } from "node:test";
import process from "node:process";
import { createMcpServer } from "../src/mcp/server.ts";
import type { AgentMap } from "../src/agents/config.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

test(
  "OpenCode ACP model listing with official enrichment",
  {
    skip: process.env["ACPMCP_OPENCODE_TEST"] !== "1",
  },
  async () => {
    const agents: AgentMap = {
      opencode: {
        command: "opencode",
        args: ["acp"],
        modelConfigId: "model",
        modelEnrichment: "opencode_catalog",
      },
    };
    const manager = new SessionManager(agents);
    const server = createMcpServer(agents, manager);
    const mcp = await connectMcp(server);
    try {
      const result = parseToolResult(
        await mcp.callTool("list_models", {
          agentId: "opencode",
          cwd: process.cwd(),
          enrich: true,
        }).response,
      );
      if (
        result.status !== "completed" ||
        result.availabilitySource !== "acp"
      ) {
        throw new Error(`OpenCode discovery failed: ${JSON.stringify(result)}`);
      }
      const models = result.models as Array<Record<string, unknown>>;
      const fledge = models.find(
        (model) => model.id === "opencode/fledge-alpha-free",
      );
      const metadataSummary = models
        .filter((model) =>
          [
            "opencode/fledge-alpha-free",
            "opencode/longcat-2.5-preview-free",
            "opencode/jev-1.13-free",
            "opencode/space-bunny-free",
            "opencode/muse-spark-1.3-contributor-free",
            "opencode-go/space-bunny",
            "opencode-go/longcat-2.5-preview-free",
            "opencode-go/muse-spark-1.3-contributor",
          ].includes(String(model.id)),
        )
        .map((model) => ({
          id: model.id,
          metadata: model.metadata,
        }));
      console.log(
        `OpenCode discovery: ${models.length} ACP-advertised models; Fledge advertised=${Boolean(
          fledge,
        )}; enrichment=${
          (result.enrichment as Record<string, unknown>)?.status
        }`,
      );
      console.log(
        `OpenCode routing metadata: ${JSON.stringify(metadataSummary)}`,
      );
      console.log(
        `OpenCode catalog coverage: ${JSON.stringify({
          advertised: models.length,
          withPricing: models.filter(
            (model) =>
              (model.metadata as Record<string, unknown> | undefined)?.pricing,
          ).length,
          currentlyFreePerToken: models.filter(
            (model) =>
              (model.metadata as Record<string, unknown> | undefined)?.free ===
              true,
          ).length,
          freeModelIds: models
            .filter(
              (model) =>
                (model.metadata as Record<string, unknown> | undefined)
                  ?.free === true,
            )
            .map((model) => model.id),
          withCounterpart: models.filter(
            (model) =>
              (model.metadata as Record<string, unknown> | undefined)
                ?.paidCounterpart,
          ).length,
          withCostTier: models.filter(
            (model) =>
              (model.metadata as Record<string, unknown> | undefined)
                ?.underlyingCostTier,
          ).length,
          withPrivacy: models.filter(
            (model) =>
              (model.metadata as Record<string, unknown> | undefined)?.privacy,
          ).length,
          withoutCatalogDetails: models.filter((model) => !model.metadata)
            .length,
        })}`,
      );
      if (
        models.length === 0 ||
        models.some(
          (model) => model.available !== true || model.configId !== "model",
        )
      ) {
        throw new Error(
          "OpenCode did not return live advertised model choices",
        );
      }
      if (fledge) {
        const metadata = fledge.metadata as Record<string, unknown> | undefined;
        if (metadata?.free !== true) {
          throw new Error(
            "Advertised Fledge Alpha Free did not receive official free metadata",
          );
        }
        if (metadata.underlyingCostTier || metadata.paidCounterpart) {
          throw new Error(
            "Fledge received an unsupported counterpart or economic tier",
          );
        }
      }
      const longcat = models.find(
        (model) => model.id === "opencode/longcat-2.5-preview-free",
      );
      if (longcat) {
        const metadata = longcat.metadata as
          | Record<string, unknown>
          | undefined;
        if (metadata?.underlyingCostTier || metadata?.paidCounterpart) {
          throw new Error(
            "LongCat received an unsupported counterpart or economic tier",
          );
        }
      }
      if (manager.sessionCount !== 0) {
        throw new Error("OpenCode discovery leaked its temporary ACP session");
      }
    } finally {
      await mcp.close();
      await manager.closeAll();
      await server.close();
    }
  },
);
