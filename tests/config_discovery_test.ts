import { join } from "node:path";
import { resolveConfiguration } from "../src/config/discovery.ts";

async function writeConfig(directory: string, value: unknown): Promise<string> {
  await Deno.mkdir(directory, { recursive: true });
  const path = join(directory, ".acp-mcp.json");
  await Deno.writeTextFile(path, JSON.stringify(value));
  return path;
}

Deno.test("no files keeps built-ins, while home-only and project-only configs load", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp source-cases-" });
  const home = join(root, "home");
  const project = join(root, "repo");
  try {
    const absent = await resolveConfiguration({
      cwd: project,
      homeDirectory: home,
    });
    if (!absent.agents.antigravity || absent.sources.length) {
      throw new Error("missing optional config disabled built-ins");
    }

    await writeConfig(project, {
      agents: { antigravity: { implementation: "agy" } },
    });
    const projectOnly = await resolveConfiguration({
      cwd: project,
      homeDirectory: home,
    });
    if (
      projectOnly.agents.antigravity.implementation !== "agy" ||
      projectOnly.sources.length !== 1
    ) {
      throw new Error("project-only config was not discovered");
    }

    await writeConfig(home, {
      agents: { antigravity: { models: { deniedModels: ["gpt-*"] } } },
    });
    const homeOnly = await resolveConfiguration({
      cwd: join(root, "elsewhere"),
      homeDirectory: home,
    });
    if (homeOnly.agents.antigravity.models?.deniedModels?.[0] !== "gpt-*") {
      throw new Error("home-only config was not loaded");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("hierarchical config merges home and project from outer to nearest", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp config spaces-" });
  const home = join(root, "home");
  const repo = join(root, "repo");
  const nested = join(repo, "nested");
  try {
    const homeFile = await writeConfig(home, {
      agents: {
        antigravity: {
          models: {
            allowedModels: ["claude-*", "gemini-*"],
            modelSizes: { large: { model: "home-model" } },
          },
        },
      },
    });
    const repoFile = await writeConfig(repo, {
      agents: {
        antigravity: {
          implementation: "agy",
          models: {
            allowedModels: ["claude-*"],
            default: { modelSize: "large", thinkingEffort: "max" },
          },
        },
      },
    });
    const nestedFile = await writeConfig(nested, {
      agents: {
        antigravity: {
          models: {
            default: { modelSize: "medium", thinkingEffort: "high" },
          },
        },
      },
    });
    const resolved = await resolveConfiguration({
      cwd: nested,
      homeDirectory: home,
    });
    const agent = resolved.agents.antigravity;
    if (
      agent.implementation !== "agy" ||
      agent.models?.default?.modelSize !== "medium" ||
      agent.models?.default?.thinkingEffort !== "high" ||
      agent.models?.allowedModels?.join(",") !== "claude-*" ||
      agent.models?.modelSizes?.large?.model !== "home-model" ||
      resolved.sources.map((source) => source.path).join("|") !==
        [homeFile, repoFile, nestedFile].join("|")
    ) throw new Error(JSON.stringify({ agent, sources: resolved.sources }));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("project config is safe, arrays replace, and cannot inject launch data", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp project-safe-" });
  const home = join(root, "home");
  const project = join(root, "repo");
  try {
    await writeConfig(home, {
      agents: {
        antigravity: {
          command: "trusted-command",
          args: ["--trusted"],
          env: { AGY_BIN: "trusted-agy" },
          models: { allowedModels: ["a", "b"] },
        },
      },
    });
    await writeConfig(project, {
      agents: {
        antigravity: {
          implementation: "agy",
          models: { allowedModels: ["c"] },
        },
      },
    });
    const resolved = await resolveConfiguration({
      cwd: project,
      homeDirectory: home,
    });
    if (
      resolved.agents.antigravity.command !== "trusted-command" ||
      resolved.agents.antigravity.args.join() !== "--trusted" ||
      resolved.agents.antigravity.env?.AGY_BIN !== "trusted-agy" ||
      resolved.agents.antigravity.models?.allowedModels?.join() !== "c"
    ) {
      throw new Error(
        "project configuration replaced trusted launch data or concatenated arrays",
      );
    }

    for (
      const launch of [{ command: "evil" }, { args: ["evil"] }, {
        env: { EVIL: "yes" },
      }]
    ) {
      const bad = join(root, `bad-${Object.keys(launch)[0]}`);
      await writeConfig(bad, { agents: { antigravity: launch } });
      let rejected = false;
      try {
        await resolveConfiguration({
          cwd: bad,
          homeDirectory: join(root, "no-home"),
        });
      } catch (error) {
        rejected = error instanceof Error &&
          error.message.includes("project configuration");
      }
      if (!rejected) {
        throw new Error(
          `Project ${Object.keys(launch)[0]} injection was accepted`,
        );
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("explicit config is exact and disables home/project discovery", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp explicit-" });
  const home = join(root, "home");
  const project = join(root, "project");
  const explicit = join(root, "chosen config.json");
  try {
    await writeConfig(home, {
      agents: { antigravity: { implementation: "agy" } },
    });
    await writeConfig(project, {
      agents: { antigravity: { implementation: "refined" } },
    });
    await Deno.writeTextFile(explicit, JSON.stringify({ agents: {} }));
    const resolved = await resolveConfiguration({
      explicitConfigPath: explicit,
      cwd: project,
      homeDirectory: home,
    });
    if (
      !resolved.explicit || resolved.sources.length !== 1 ||
      resolved.agents.antigravity.implementation !== "official"
    ) {
      throw new Error("explicit configuration did not disable discovery");
    }
    let missingFailed = false;
    try {
      await resolveConfiguration({
        explicitConfigPath: join(root, "missing.json"),
        cwd: project,
        homeDirectory: home,
      });
    } catch {
      missingFailed = true;
    }
    if (!missingFailed) {
      throw new Error("missing explicit config silently fell back");
    }
    let directoryFailed = false;
    try {
      await resolveConfiguration({
        explicitConfigPath: project,
        cwd: project,
        homeDirectory: home,
      });
    } catch (error) {
      directoryFailed = error instanceof Error &&
        error.message.includes("not a file");
    }
    if (!directoryFailed) {
      throw new Error("directory was accepted as an explicit config file");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("home config is not applied twice when it is an ancestor of operation cwd", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp home-ancestor-" });
  const project = join(root, "project");
  try {
    const homeFile = await writeConfig(root, {
      agents: { antigravity: { models: { allowedModels: ["claude-*"] } } },
    });
    const resolved = await resolveConfiguration({
      cwd: project,
      homeDirectory: root,
    });
    if (
      resolved.sources.length !== 1 || resolved.sources[0].path !== homeFile
    ) {
      throw new Error(
        `home file was applied more than once: ${
          JSON.stringify(resolved.sources)
        }`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("invalid discovered config fails with its path", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp invalid-project-" });
  const file = await writeConfig(root, {
    agents: { antigravity: { models: { default: { modelSize: "xl" } } } },
  });
  try {
    let error = "";
    try {
      await resolveConfiguration({
        cwd: root,
        homeDirectory: join(root, "home"),
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (!error.includes(file) || !error.includes("modelSize")) {
      throw new Error(
        `invalid discovered config error lacked path/field: ${error}`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
