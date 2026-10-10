import { loadAgents } from "../src/agents/config.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { findExecutablePath, startAgent } from "../src/runtime/process.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

Deno.test("built-in profiles describe ACP launch routes without vendor behavior", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  try {
    await Deno.writeTextFile(configPath, JSON.stringify({ agents: {} }));
    const agents = await loadAgents(configPath);
    if (
      agents.opencode.command !== "opencode" ||
      JSON.stringify(agents.opencode.args) !== JSON.stringify(["acp"])
    ) throw new Error("OpenCode native ACP launch changed");
    if (
      agents.codex.command !== "codex-acp" || agents.codex.args.length !== 0 ||
      agents.codex.env || agents.codex.modelConfigId ||
      agents.codex.modelEnrichment || agents.codex.failureClassifier
    ) throw new Error("Codex profile is not a plain ACP adapter profile");
    if (
      agents.claude.command !== "claude-agent-acp" ||
      agents.claude.args.length !== 0 ||
      agents.claude.displayName !== "Claude Agent ACP" || agents.claude.env ||
      JSON.stringify(agents.claude.protocolEnv?.v2) !==
        JSON.stringify({ CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: "1" }) ||
      agents.claude.modelConfigId || agents.claude.modelEnrichment ||
      agents.claude.failureClassifier
    ) throw new Error("Claude profile is not a plain ACP adapter profile");
    const expectedAntigravityCommand = Deno.build.os === "windows"
      ? "agy_acp_server"
      : "agy_acp_server.par";
    const expectedAntigravityArgs = Deno.build.os === "linux" ? ["--uid="] : [];
    if (
      agents.antigravity.command !== expectedAntigravityCommand ||
      JSON.stringify(agents.antigravity.args) !==
        JSON.stringify(expectedAntigravityArgs) ||
      agents.antigravity.implementation !== "official" ||
      agents.antigravity.env || agents.antigravity.modelConfigId ||
      agents.antigravity.modelEnrichment ||
      agents.antigravity.failureClassifier
    ) throw new Error("Antigravity profile has unexpected special behavior");
    if (
      !agents.codex.installHint?.includes("@agentclientprotocol/codex-acp") ||
      !agents.claude.installHint?.includes(
        "@agentclientprotocol/claude-agent-acp",
      ) || !agents.claude.installHint?.includes("Node.js 22") ||
      !agents.antigravity.installHint?.includes(
        "Agent Client Protocol Registry",
      ) || !agents.antigravity.installHint?.includes("absolute path")
    ) throw new Error("Built-in profiles lack canonical install hints");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Antigravity implementation selection is explicit and profile-driven", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  try {
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        agents: { antigravity: { implementation: "refined" } },
      }),
    );
    const agents = await loadAgents(configPath);
    const refined = agents.antigravity;
    if (
      refined.implementation !== "refined" ||
      refined.command !== "refined-antigravity-acp" ||
      refined.args.length !== 0 || refined.acpProtocol !== "v1" ||
      JSON.stringify(refined.supportedProtocols) !== JSON.stringify(["v1"]) ||
      refined.modelEnrichment !== undefined ||
      JSON.stringify(refined.requiredExecutableEnv) !==
        JSON.stringify(["REFINED_AGY_ACP_BIN"]) ||
      refined.runtimePrerequisites?.[0]?.command !== "node" ||
      refined.runtimePrerequisites[0]?.minimumVersion !== "22.0.0"
    ) throw new Error("Refined selection did not load its distinct v1 profile");

    await Deno.writeTextFile(
      configPath,
      JSON.stringify({ agents: { antigravity: { implementation: "other" } } }),
    );
    let rejected = false;
    try {
      await loadAgents(configPath);
    } catch (error) {
      rejected = String(error).includes(
        "implementation must be 'official', 'refined', or 'agy'",
      );
    }
    if (!rejected) {
      throw new Error("Invalid Antigravity implementation accepted");
    }

    await Deno.writeTextFile(
      configPath,
      JSON.stringify({ agents: { antigravity: { implementation: "agy" } } }),
    );
    const agy = (await loadAgents(configPath)).antigravity;
    const localAppData = Deno.env.get("LOCALAPPDATA");
    const expectedAgyCommand = Deno.build.os === "windows" &&
        Deno.build.arch === "x86_64" && localAppData
      ? `${localAppData}\\acp-mcp\\agents\\antigravity-agy\\1.2.0\\agy-acp-windows-x64.exe`
      : "agy-acp-windows-x64.exe";
    if (
      agy.implementation !== "agy" || agy.command !== expectedAgyCommand ||
      agy.args.length !== 0 || agy.acpProtocol !== "v1" ||
      JSON.stringify(agy.supportedProtocols) !== JSON.stringify(["v1"]) ||
      agy.modelConfigId !== "model" ||
      JSON.stringify(agy.requiredExecutableEnv) !==
        JSON.stringify(["AGY_BIN"]) ||
      agy.runtimePrerequisites?.length
    ) throw new Error("agy selection did not load its pinned v1 profile");

    await Deno.writeTextFile(
      configPath,
      JSON.stringify({ agents: { opencode: { implementation: "agy" } } }),
    );
    rejected = false;
    try {
      await loadAgents(configPath);
    } catch (error) {
      rejected = String(error).includes(
        "implementation is only valid for 'antigravity'",
      );
    }
    if (!rejected) {
      throw new Error("Antigravity implementation selector leaked to OpenCode");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("agy Antigravity profile preserves overrides and validates AGY_BIN paths with spaces", async () => {
  const dir = await Deno.makeTempDir({ prefix: "acp agy profile " });
  const configPath = `${dir}/config.json`;
  const executable = `${dir}/fake agy.exe`;
  const adapter = `${dir}/fake agy adapter.exe`;
  try {
    await Deno.writeTextFile(executable, "fake executable");
    await Deno.copyFile(Deno.execPath(), adapter);
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        agents: {
          antigravity: {
            implementation: "agy",
            command: adapter,
            args: ["argument with spaces"],
            env: { AGY_BIN: executable, ACP_MCP_PROFILE_TEST: "preserved" },
          },
        },
      }),
    );
    const definition = (await loadAgents(configPath)).antigravity;
    if (
      definition.implementation !== "agy" ||
      definition.command !== adapter ||
      JSON.stringify(definition.args) !==
        JSON.stringify(["argument with spaces"]) ||
      definition.env?.AGY_BIN !== executable ||
      definition.env.ACP_MCP_PROFILE_TEST !== "preserved" ||
      definition.requiredExecutableEnv?.[0] !== "AGY_BIN"
    ) {
      throw new Error(
        "agy user overrides did not compose with profile metadata",
      );
    }

    const process = await startAgent({
      ...definition,
      args: [
        "eval",
        `Deno.exit(Deno.env.get("AGY_BIN") === ${
          JSON.stringify(executable)
        } && Deno.env.get("ACP_MCP_PROFILE_TEST") === "preserved" ? 0 : 1)`,
      ],
    }, dir);
    const status = await process.child.status;
    await process.stderrDone;
    if (status.code !== 0) {
      throw new Error(
        "agy adapter/AGY_BIN paths containing spaces were not preserved at process launch",
      );
    }
    let rejected = false;
    try {
      await startAgent({ ...definition, env: { AGY_BIN: "" } }, dir);
    } catch (error) {
      rejected = String(error).includes("AGY_BIN");
    }
    if (!rejected) throw new Error("Missing AGY_BIN was not rejected");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("refined Antigravity inherits generic profile overrides and requires an installed backend", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  const backend = Deno.execPath();
  try {
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        agents: {
          antigravity: {
            implementation: "refined",
            command: backend,
            args: ["eval", "Deno.exit(0)"],
            env: { REFINED_AGY_ACP_BIN: backend, ACP_MCP_PROFILE_TEST: "yes" },
          },
        },
      }),
    );
    const definition = (await loadAgents(configPath)).antigravity;
    if (
      definition.implementation !== "refined" ||
      definition.command !== backend ||
      JSON.stringify(definition.args) !==
        JSON.stringify(["eval", "Deno.exit(0)"]) ||
      definition.env?.ACP_MCP_PROFILE_TEST !== "yes" ||
      definition.requiredExecutableEnv?.[0] !== "REFINED_AGY_ACP_BIN" ||
      definition.acpProtocol !== "v1"
    ) throw new Error("User overrides lost refined profile metadata");

    const withoutBackend = {
      ...definition,
      env: { REFINED_AGY_ACP_BIN: "" },
    };
    let rejected = false;
    try {
      await startAgent(withoutBackend, dir);
    } catch (error) {
      rejected = String(error).includes("REFINED_AGY_ACP_BIN");
    }
    if (!rejected) throw new Error("Missing refined backend was not rejected");

    const process = await startAgent(definition, dir);
    const status = await process.child.status;
    await process.stderrDone;
    if (status.code !== 0) {
      throw new Error("Configured executable did not launch");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("list_agents identifies the explicitly selected agy implementation", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  try {
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({ agents: { antigravity: { implementation: "agy" } } }),
    );
    const agents = await loadAgents(configPath);
    agents.antigravity.command = Deno.execPath();
    agents.antigravity.env = { AGY_BIN: Deno.execPath() };
    const manager = new SessionManager(agents);
    const server = createMcpServer(agents, manager);
    const mcp = await connectMcp(server);
    try {
      const listedResponse = await mcp.callTool("list_agents", {}).response as {
        result?: { content?: Array<{ text?: string }> };
      };
      const listedText = listedResponse.result?.content?.find((item) =>
        item.text
      )?.text;
      if (!listedText) throw new Error("list_agents returned no result");
      const listed = JSON.parse(listedText) as Array<Record<string, unknown>>;
      const antigravity = listed.find((entry) => entry.id === "antigravity");
      if (
        antigravity?.implementation !== "agy" ||
        antigravity.displayName !== "Antigravity (agy ACP)"
      ) throw new Error("list_agents hid the selected agy implementation");
    } finally {
      await mcp.close();
      await manager.closeAll();
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Claude profile accepts generic command, args, and env overrides", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  const override = {
    command: `${dir}/claude-agent.cmd`,
    args: ["--stdio"],
    env: { ACPMCP_TEST_PROVIDER_ENDPOINT: "https://provider.invalid/v1" },
  };
  try {
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        agents: { claude: override },
      }),
    );
    const agents = await loadAgents(configPath);
    if (
      agents.claude.command !== override.command ||
      JSON.stringify(agents.claude.args) !== JSON.stringify(override.args) ||
      agents.claude.env?.ACPMCP_TEST_PROVIDER_ENDPOINT !==
        override.env.ACPMCP_TEST_PROVIDER_ENDPOINT ||
      agents.claude.protocolEnv?.v2?.CLAUDE_AGENT_ACP_EXPERIMENTAL_V2 !== "1"
    ) {
      throw new Error("Generic Claude override lost profile protocol metadata");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ACP protocol config defaults to v1 and rejects invalid values", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  try {
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        agents: { custom: { command: "custom-agent", args: [] } },
      }),
    );
    const defaulted = await loadAgents(configPath);
    if (defaulted.custom.acpProtocol !== "v1") {
      throw new Error("Omitted custom agent protocol did not default to v1");
    }
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        agents: {
          custom: { command: "custom-agent", args: [], acpProtocol: "v3" },
        },
      }),
    );
    let rejected = false;
    try {
      await loadAgents(configPath);
    } catch (error) {
      rejected = String(error).includes("acpProtocol must be 'v1' or 'v2'");
    }
    if (!rejected) throw new Error("Invalid ACP protocol was accepted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("executable discovery distinguishes present and missing commands", async () => {
  if (!await findExecutablePath(Deno.execPath())) {
    throw new Error(
      "The running Deno executable was not found by absolute path",
    );
  }
  const missing = await findExecutablePath(
    `acp-mcp-missing-${crypto.randomUUID()}`,
  );
  if (missing) {
    throw new Error(`Missing command resolved unexpectedly: ${missing}`);
  }

  if (Deno.build.os === "windows") {
    const dir = await Deno.makeTempDir();
    const batch = `${dir}\\profile-agent.cmd`;
    try {
      await Deno.writeTextFile(batch, "@echo off\r\nexit /b 0\r\n");
      const resolved = await findExecutablePath("profile-agent", dir);
      if (resolved?.toLowerCase() !== batch.toLowerCase()) {
        throw new Error(`Windows .cmd discovery failed: ${resolved}`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("list_agents reports command presence without implying authentication", async () => {
  const dir = await Deno.makeTempDir();
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  const found = `${dir}${separator}present${
    Deno.build.os === "windows" ? ".cmd" : ".sh"
  }`;
  const missing = `${dir}${separator}missing${
    Deno.build.os === "windows" ? ".exe" : ""
  }`;
  try {
    if (Deno.build.os === "windows") {
      await Deno.writeTextFile(found, "@echo off\r\nexit /b 0\r\n");
    } else {
      await Deno.writeTextFile(found, "#!/bin/sh\nexit 0\n");
      await Deno.chmod(found, 0o755);
    }
    const agents = {
      present: { command: found, args: [], displayName: "Present" },
      missing: {
        command: missing,
        args: [],
        displayName: "Missing",
        installHint: "Install the missing ACP agent.",
      },
    };
    const manager = new SessionManager(agents);
    const server = createMcpServer(agents, manager);
    const mcp = await connectMcp(server);
    try {
      const reply = await mcp.callTool("list_agents", {}).response;
      let rows: unknown;
      try {
        rows = parseToolResult(reply);
      } catch (error) {
        throw new Error(
          `${String(error)}; MCP reply: ${JSON.stringify(reply)}`,
        );
      }
      if (!Array.isArray(rows)) {
        throw new Error("list_agents did not return a list");
      }
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (byId.get("present")?.commandFound !== true) {
        throw new Error("Present executable was not reported");
      }
      if (byId.get("present")?.acpProtocol !== "v1") {
        throw new Error("list_agents omitted the effective ACP protocol");
      }
      if (
        byId.get("missing")?.commandFound !== false ||
        byId.get("missing")?.installHint !== "Install the missing ACP agent."
      ) throw new Error("Missing executable was not clearly reported");
    } finally {
      await mcp.close();
      await manager.closeAll();
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Codex, Claude, and Antigravity use generic ACP discovery and failures", async () => {
  const dir = await Deno.makeTempDir();
  const configPath = `${dir}/config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({ agents: { antigravity: { implementation: "refined" } } }),
  );
  const agents = await loadAgents(configPath);
  const fixtureArgs = [
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-write",
    "tests/fixtures/fake_acp_agent.ts",
    "--advertise-models",
  ];
  for (const id of ["codex", "claude", "antigravity"]) {
    agents[id] = {
      ...agents[id],
      command: Deno.execPath(),
      args: fixtureArgs,
      ...(id === "antigravity"
        ? { env: { REFINED_AGY_ACP_BIN: Deno.execPath() } }
        : {}),
    };
  }
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  try {
    const listed: unknown = parseToolResult(
      await mcp.callTool("list_agents", {}).response,
    );
    if (!Array.isArray(listed)) {
      throw new Error("list_agents did not return a list");
    }
    const antigravity = listed.find((row) => row.id === "antigravity");
    if (
      antigravity?.implementation !== "refined" ||
      antigravity.displayName !== "Antigravity (Refined)"
    ) throw new Error("list_agents did not expose the selected implementation");
    for (const agentId of ["codex", "claude", "antigravity"]) {
      const discovery = parseToolResult(
        await mcp.callTool("list_models", {
          agentId,
          enrich: true,
        }).response,
      );
      const models = discovery.models as Array<Record<string, unknown>>;
      if (
        discovery.status !== "completed" ||
        !models.some((model) => model.id === "opencode/fledge-alpha-free") ||
        (discovery.enrichment as Record<string, unknown>)?.status !==
          "not_supported"
      ) {
        throw new Error(
          `${agentId} did not use generic ACP model semantics: ${
            JSON.stringify(discovery)
          }`,
        );
      }
      if (
        agentId === "antigravity" &&
        JSON.stringify(models.map((model) => model.id).sort()) !==
          JSON.stringify([
            "opencode/available-without-metadata",
            "opencode/fledge-alpha-free",
            "opencode/paid-model",
          ])
      ) {
        throw new Error(
          "Refined profile discovery added models not advertised by the ACP fixture",
        );
      }
      if (
        agentId === "antigravity" &&
        agents.antigravity.implementation !== "refined"
      ) throw new Error("Refined profile selection was not retained");
      const failure = parseToolResult(
        await mcp.callTool("run_task", {
          agentId,
          task: "rate limit failure",
        }).response,
      );
      const error = failure.error as Record<string, unknown>;
      if (
        failure.status !== "failed" || error.kind !== "prompt_failed" ||
        error.acpCode !== -32603 || "classification" in error
      ) throw new Error(`${agentId} did not keep generic failure semantics`);
    }
    if (manager.sessionCount) {
      throw new Error("Compatibility fixture leaked a session");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});
