import { loadAgents } from "../src/agents/config.ts";

Deno.test("independent config loads see file changes without mutating prior runs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "acp-mcp-config-lifecycle-" });
  const configPath = `${dir}${
    Deno.build.os === "windows" ? "\\" : "/"
  }config.json`;
  try {
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        agents: {
          custom: { command: "first-agent", args: [], env: { RUN: "A" } },
        },
      }),
    );
    const firstRun = await loadAgents(configPath);
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        agents: {
          custom: { command: "second-agent", args: [], env: { RUN: "B" } },
        },
      }),
    );
    const secondRun = await loadAgents(configPath);
    if (
      firstRun.custom.command !== "first-agent" ||
      firstRun.custom.env?.RUN !== "A" ||
      secondRun.custom.command !== "second-agent" ||
      secondRun.custom.env?.RUN !== "B"
    ) {
      throw new Error(
        "Config changes leaked between independently loaded runs",
      );
    }
    await Deno.writeTextFile(configPath, "{ invalid json");
    let invalidSecondRunFailed = false;
    try {
      await loadAgents(configPath);
    } catch {
      invalidSecondRunFailed = true;
    }
    if (!invalidSecondRunFailed || firstRun.custom.command !== "first-agent") {
      throw new Error("An invalid later config changed the existing run");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("explicit missing config fails instead of selecting built-in defaults", async () => {
  const dir = await Deno.makeTempDir({ prefix: "acp-mcp-explicit-config-" });
  const missing = `${dir}${
    Deno.build.os === "windows" ? "\\" : "/"
  }missing config.json`;
  try {
    let message = "";
    try {
      await loadAgents(missing);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (
      !message.includes("Explicit config file does not exist") ||
      !message.includes(missing)
    ) {
      throw new Error(`Explicit missing config was not clear: ${message}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("known config fields fail with safe actionable validation errors", async () => {
  const dir = await Deno.makeTempDir({ prefix: "acp-mcp-config-schema-" });
  const path = `${dir}${Deno.build.os === "windows" ? "\\" : "/"}config.json`;
  const cases: Array<[unknown, string]> = [
    [null, "must contain a JSON object"],
    [{ agents: null }, "must contain an 'agents' object"],
    [{ agents: { custom: null } }, "Agent 'custom' must be a JSON object"],
    [
      { agents: { custom: { command: "agent", args: "--stdio" } } },
      "args must be an array of strings",
    ],
    [{
      agents: { custom: { command: "agent", args: [], env: { TOKEN: null } } },
    }, "env value for 'TOKEN' must be a string"],
    [
      { agents: { custom: { command: "agent", args: [], acpProtocol: "v3" } } },
      "acpProtocol must be 'v1' or 'v2'",
    ],
  ];
  try {
    for (const [config, expected] of cases) {
      await Deno.writeTextFile(path, JSON.stringify(config));
      let message = "";
      try {
        await loadAgents(path);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      if (!message.includes(expected) || message.includes("null")) {
        throw new Error(`Expected safe '${expected}' error, got '${message}'`);
      }
    }
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        unknownFutureField: true,
        agents: {
          custom: { command: "agent", args: [], futureAgentField: "allowed" },
        },
      }),
    );
    const forwardCompatible = await loadAgents(path);
    if (forwardCompatible.custom.command !== "agent") {
      throw new Error("Unknown config fields were unexpectedly rejected");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("config validation never serializes an environment value", async () => {
  const dir = await Deno.makeTempDir({ prefix: "acp-mcp-config-canary-" });
  const path = `${dir}${Deno.build.os === "windows" ? "\\" : "/"}config.json`;
  const canary = `ACP_MCP_CONFIG_CANARY_${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        agents: {
          custom: {
            command: "agent",
            args: [],
            env: { API_TOKEN: canary },
            acpProtocol: "v3",
          },
        },
      }),
    );
    let message = "";
    try {
      await loadAgents(path);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (
      !message.includes("acpProtocol must be 'v1' or 'v2'") ||
      message.includes(canary)
    ) throw new Error("Config validation exposed an environment value");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
