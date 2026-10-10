import { join } from "node:path";
import { loadAgents } from "../src/agents/config.ts";
import {
  diagnose,
  type DoctorDependencies,
} from "../src/diagnostics/doctor.ts";
import { resolveConfiguration } from "../src/config/discovery.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

const EFFORT_MAPPING = {
  configOption: "effort",
  values: {
    off: "off",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
    ultra: "ultra",
  },
};

function modelPolicy(
  modelSize: "medium" | "large",
  thinkingEffort: "medium" | "high",
  allowedModels: string[],
  deniedModels: string[] = [],
) {
  return {
    default: { modelSize, thinkingEffort },
    allowedModels,
    deniedModels,
    modelSizes: {
      medium: { model: "live-small" },
      large: { model: "live-large" },
    },
    thinkingEffort: EFFORT_MAPPING,
  };
}

async function writeConfig(directory: string, value: unknown): Promise<string> {
  await Deno.mkdir(directory, { recursive: true });
  const path = join(directory, ".acp-mcp.json");
  await Deno.writeTextFile(path, JSON.stringify(value));
  return path;
}

Deno.test("trusted custom ACP agents use the generic MCP, policy, and session path", async () => {
  const root = await Deno.makeTempDir({
    prefix: "acp-mcp custom integration-",
  });
  const home = join(root, "home");
  const project = join(root, "repo");
  const reportPath = join(root, "child report.json");
  const canary = `CUSTOM_AGENT_ENV_${crypto.randomUUID()}`;
  const fixture = join(Deno.cwd(), "tests", "fixtures", "custom_acp_agent.ts");
  const homeConfig = await writeConfig(home, {
    agents: {
      reviewer: {
        command: Deno.execPath(),
        args: [
          "run",
          "--allow-env=ACPMCP_CUSTOM_TEST_SECRET",
          "--allow-write",
          fixture,
          `--report=${reportPath}`,
          "structured argument with spaces",
        ],
        env: { ACPMCP_CUSTOM_TEST_SECRET: canary },
        acpProtocol: "v1",
      },
    },
  });
  const projectConfig = {
    agents: {
      reviewer: {
        models: modelPolicy(
          "large",
          "medium",
          ["live-*"],
          ["live-small"],
        ),
      },
    },
  };
  await writeConfig(project, projectConfig);
  const homeResolved = await resolveConfiguration({
    cwd: join(root, "outside-project"),
    homeDirectory: home,
  });
  const manager = new SessionManager(homeResolved.agents);
  const server = createMcpServer(homeResolved.agents, manager, {
    resolveConfiguration: (cwd) =>
      resolveConfiguration({ cwd, homeDirectory: home }),
  });
  const mcp = await connectMcp(server);
  try {
    const toolListing = await mcp.listTools().response as {
      result?: { tools?: unknown[] };
    };
    if (toolListing.result?.tools?.length !== 16) {
      throw new Error("Custom registration changed the 16-tool MCP surface");
    }

    const listed = parseToolResult(
      await mcp.callTool("list_agents", { cwd: project }).response,
    ) as unknown as Array<Record<string, unknown>>;
    const reviewer = listed.find((entry) => entry.id === "reviewer");
    if (
      !reviewer || reviewer.commandFound !== true ||
      reviewer.acpProtocol !== "v1" ||
      JSON.stringify(reviewer).includes(canary)
    ) {
      throw new Error(
        "Custom agent listing was incomplete or exposed env data",
      );
    }

    const catalog = parseToolResult(
      await mcp.callTool("list_models", { agentId: "reviewer", cwd: project })
        .response,
    );
    const models = catalog.models as Array<Record<string, unknown>>;
    if (
      catalog.status !== "completed" || models.length !== 1 ||
      models[0].id !== "live-large" || models[0].isDefault !== true
    ) {
      throw new Error(
        `Custom live catalog/policy failed: ${JSON.stringify(catalog)}`,
      );
    }

    const task = parseToolResult(
      await mcp.callTool("run_task", {
        agentId: "reviewer",
        cwd: project,
        modelSize: "large",
        thinkingEffort: "medium",
        task: "Reply exactly: CUSTOM_OK",
      }).response,
    );
    if (
      task.status !== "completed" ||
      (task.response as string | undefined)?.trim() !== "CUSTOM_OK"
    ) throw new Error(`Custom run_task failed: ${JSON.stringify(task)}`);

    const runReport = JSON.parse(await Deno.readTextFile(reportPath)) as {
      args: string[];
      env: string;
      currentConfig: Array<{ id: string; currentValue: string }>;
    };
    if (
      runReport.args.join() !== "structured argument with spaces" ||
      runReport.env !== canary ||
      runReport.currentConfig.find((item) => item.id === "model")
          ?.currentValue !== "live-large" ||
      runReport.currentConfig.find((item) => item.id === "effort")
          ?.currentValue !== "low"
    ) {
      throw new Error(
        "Structured args, env, model-size, or effort mapping failed",
      );
    }
    if (
      JSON.stringify({ listed, catalog, task }).includes(canary)
    ) throw new Error("Custom agent environment value escaped through MCP");

    const first = parseToolResult(
      await mcp.callTool("start_session", {
        agentId: "reviewer",
        cwd: project,
      }).response,
    );
    const firstId = first.sessionId as string;
    const firstState = parseToolResult(
      await mcp.callTool("get_session", { sessionId: firstId }).response,
    );
    const firstOptions = firstState.configOptions as Array<{
      id: string;
      currentValue: string;
    }>;
    if (
      firstOptions.find((item) => item.id === "model")?.currentValue !==
        "live-large" ||
      firstOptions.find((item) => item.id === "effort")?.currentValue !== "low"
    ) throw new Error("Initial session did not resolve its project policy");

    await Deno.writeTextFile(
      join(project, ".acp-mcp.json"),
      JSON.stringify({
        agents: {
          reviewer: {
            models: modelPolicy("medium", "high", ["live-small"]),
          },
        },
      }),
    );
    const unchanged = parseToolResult(
      await mcp.callTool("get_session", { sessionId: firstId }).response,
    );
    const unchangedOptions = unchanged.configOptions as typeof firstOptions;
    if (
      unchangedOptions.find((item) => item.id === "model")?.currentValue !==
        "live-large" ||
      unchangedOptions.find((item) => item.id === "effort")?.currentValue !==
        "low"
    ) throw new Error("Project edit changed an existing custom-agent session");
    const prompt = parseToolResult(
      await mcp.callTool("prompt", {
        sessionId: firstId,
        text: "Reply exactly: CUSTOM_SESSION_OK",
      }).response,
    );
    if (
      prompt.state !== "completed" || prompt.text !== "CUSTOM_SESSION_OK"
    ) throw new Error("Custom ACP session prompt did not complete");

    const second = parseToolResult(
      await mcp.callTool("start_session", {
        agentId: "reviewer",
        cwd: project,
      }).response,
    );
    const secondId = second.sessionId as string;
    const secondState = parseToolResult(
      await mcp.callTool("get_session", { sessionId: secondId }).response,
    );
    const secondOptions = secondState.configOptions as typeof firstOptions;
    if (
      secondOptions.find((item) => item.id === "model")?.currentValue !==
        "live-small" ||
      secondOptions.find((item) => item.id === "effort")?.currentValue !==
        "high"
    ) throw new Error("New session did not observe updated project policy");
    for (const sessionId of [firstId, secondId]) {
      await mcp.callTool("close_session", { sessionId }).response;
    }
    const sessions = parseToolResult(
      await mcp.callTool("list_sessions", {}).response,
    );
    if (!Array.isArray(sessions) || sessions.length) {
      throw new Error("Custom session close did not release managed sessions");
    }

    const doctorDependencies: DoctorDependencies = {
      resolveExecutable: (command) =>
        Promise.resolve(command === Deno.execPath() ? command : undefined),
      loadAgents,
      inspectStaleWorkspaces: () =>
        Promise.resolve({
          root: join(root, "workspaces"),
          dryRun: true,
          olderThanMs: 86_400_000,
          eligible: 0,
          removed: 0,
          skipped: 0,
          failed: 0,
          entries: [],
        }),
      workspaceRoot: () => Promise.resolve(join(root, "workspaces")),
      runVersionCommand: () => Promise.resolve(undefined),
      resolveConfiguration: (options) =>
        resolveConfiguration({ ...options, homeDirectory: home }),
    };
    const doctor = await diagnose({ cwd: project }, doctorDependencies);
    const reviewerCheck = doctor.checks.find((check) =>
      check.id === "agent.reviewer"
    );
    if (
      !reviewerCheck || reviewerCheck.status !== "ok" ||
      JSON.stringify(doctor).includes(canary)
    ) throw new Error("Doctor did not report the custom agent safely");

    await Deno.writeTextFile(
      homeConfig,
      JSON.stringify({
        agents: {
          missing_agent: { command: `missing-${crypto.randomUUID()}` },
        },
      }),
    );
    const missingDoctor = await diagnose({ configPath: homeConfig }, {
      ...doctorDependencies,
      resolveConfiguration: undefined,
    });
    const missingCheck = missingDoctor.checks.find((check) =>
      check.id === "agent.missing_agent"
    );
    if (
      missingCheck?.status !== "error" ||
      !missingCheck.summary.includes("command not found")
    ) throw new Error("Doctor did not report an unavailable custom command");
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
    await Deno.remove(root, { recursive: true });
  }
});
