import {
  diagnose,
  type DoctorDependencies,
} from "../src/diagnostics/doctor.ts";
import type { AgentDefinition } from "../src/agents/config.ts";

function staleResult(eligible = 0) {
  return {
    root: "",
    dryRun: true,
    olderThanMs: 24 * 60 * 60 * 1000,
    eligible,
    removed: 0,
    skipped: 0,
    failed: 0,
    entries: [],
  };
}

function dependencies(
  root: string,
  agents: Record<string, AgentDefinition>,
  overrides: Partial<DoctorDependencies> = {},
): DoctorDependencies {
  return {
    resolveExecutable: (command) =>
      Promise.resolve(`C:\\fixtures\\${command}.exe`),
    loadAgents: () => Promise.resolve(agents),
    inspectStaleWorkspaces: (options) => {
      if (options.delete !== false || options.checkCreatorProcess !== false) {
        return Promise.reject(
          new Error("Doctor must inspect workspaces without deleting"),
        );
      }
      return Promise.resolve(staleResult());
    },
    workspaceRoot: () => Promise.resolve(root),
    runVersionCommand: () => Promise.resolve("v22.1.0"),
    ...overrides,
  };
}

Deno.test("doctor reports local configuration and agent checks without secrets", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp-doctor-root-" });
  const config = `${root}\\config.json`;
  try {
    await Deno.writeTextFile(config, JSON.stringify({ agents: {} }));
    const report = await diagnose(
      { configPath: config },
      dependencies(root, {
        claude: {
          command: "agent",
          args: ["--api-key", "DOCTOR_SECRET_VALUE"],
          env: { OPENROUTER_API_KEY: "DOCTOR_SECRET_VALUE" },
          installHint: "DOCTOR_SECRET_HINT",
        },
      }),
    );
    const serialized = JSON.stringify(report);
    if (
      report.status !== "healthy" || report.configPath !== config ||
      !report.checks.some((check) =>
        check.summary.includes("configured argument(s)")
      ) ||
      serialized.includes("DOCTOR_SECRET_VALUE") ||
      serialized.includes("DOCTOR_SECRET_HINT")
    ) throw new Error(`Unexpected doctor report: ${serialized}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("doctor reports missing agent commands without dumping config hints", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp-doctor-missing-" });
  const config = `${root}\\config.json`;
  try {
    await Deno.writeTextFile(config, JSON.stringify({ agents: {} }));
    const report = await diagnose(
      { configPath: config },
      dependencies(root, {
        custom: {
          command: "missing-agent",
          args: [],
          installHint: "DOCTOR_SECRET_HINT",
        },
      }, {
        resolveExecutable: () => Promise.resolve(undefined),
      }),
    );
    const agent = report.checks.find((check) => check.id === "agent.custom");
    if (
      report.status !== "errors" || agent?.status !== "error" ||
      !agent.detail?.includes("README") ||
      agent.detail.includes("DOCTOR_SECRET_HINT")
    ) throw new Error("Missing agent command was not diagnosed usefully");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("doctor handles invalid and missing explicit configs as structured errors", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp-doctor-config-" });
  const invalidConfig = `${root}\\invalid.json`;
  const missingConfig = `${root}\\missing.json`;
  try {
    await Deno.writeTextFile(invalidConfig, "not json");
    const invalid = await diagnose(
      { configPath: invalidConfig },
      dependencies(root, {}, {
        loadAgents: () => Promise.reject(new Error("opaque parse failure")),
      }),
    );
    const missing = await diagnose(
      { configPath: missingConfig },
      dependencies(root, {}),
    );
    if (
      invalid.status !== "errors" ||
      invalid.checks.find((check) => check.id === "config")?.summary !==
        "invalid JSON or agent configuration" ||
      JSON.stringify(invalid).includes("opaque parse failure") ||
      missing.status !== "errors" ||
      !missing.checks.find((check) => check.id === "config")?.summary.includes(
        "does not exist",
      )
    ) {
      throw new Error(
        "Config failures were not returned safely as diagnostics",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("doctor reports stale workspaces without requesting deletion", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp-doctor-stale-" });
  const config = `${root}\\config.json`;
  let deleteRequested: boolean | undefined;
  try {
    await Deno.writeTextFile(config, JSON.stringify({ agents: {} }));
    const report = await diagnose(
      { configPath: config },
      dependencies(root, {}, {
        inspectStaleWorkspaces: (options) => {
          deleteRequested = options.delete;
          return Promise.resolve(staleResult(2));
        },
      }),
    );
    if (
      deleteRequested !== false || report.status !== "warnings" ||
      !report.checks.some((check) =>
        check.id === "workspace.stale" && check.summary.includes("2 stale")
      )
    ) throw new Error("Doctor did not safely report stale workspaces");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("doctor reports a too-old local runtime prerequisite", async () => {
  const root = await Deno.makeTempDir({ prefix: "acp-mcp-doctor-runtime-" });
  const config = `${root}\\config.json`;
  try {
    await Deno.writeTextFile(config, JSON.stringify({ agents: {} }));
    const report = await diagnose(
      { configPath: config },
      dependencies(root, {
        claude: {
          command: "agent",
          args: [],
        },
      }, { runVersionCommand: () => Promise.resolve("v20.15.0") }),
    );
    if (
      report.status !== "errors" ||
      !report.checks.some((check) =>
        check.id === "runtime.claude.1" &&
        check.summary.includes("found v20.15.0")
      )
    ) throw new Error("Runtime version prerequisite was not checked");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
