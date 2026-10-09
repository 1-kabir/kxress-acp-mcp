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
