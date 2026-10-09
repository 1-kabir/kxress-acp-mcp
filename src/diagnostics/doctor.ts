import {
  type AgentDefinition,
  BUILTIN_RUNTIME_PREREQUISITES,
  defaultConfigPath,
  loadAgents,
} from "../agents/config.ts";
import { findExecutablePath } from "../runtime/process.ts";
import { cleanupStaleWorkspaceSnapshots } from "../workspaces/stale_cleanup.ts";
import { getWorkspaceRoot } from "../workspaces/snapshot.ts";
import { VERSION } from "../version.ts";

export type DiagnosticStatus = "ok" | "warning" | "error";

export interface DiagnosticCheck {
  id: string;
  status: DiagnosticStatus;
  summary: string;
  detail?: string;
}

export interface DoctorReport {
  version: string;
  platform: string;
  architecture: string;
  configPath: string | null;
  status: "healthy" | "warnings" | "errors";
  checks: DiagnosticCheck[];
}

export interface DoctorOptions {
  configPath?: string;
}

export interface DoctorDependencies {
  resolveExecutable: (command: string) => Promise<string | undefined>;
  loadAgents: (path?: string) => Promise<Record<string, AgentDefinition>>;
  inspectStaleWorkspaces: (
    options: { delete: false; checkCreatorProcess: false },
  ) => ReturnType<typeof cleanupStaleWorkspaceSnapshots>;
  workspaceRoot: () => Promise<string>;
  runVersionCommand: (path: string) => Promise<string | undefined>;
}

const defaultDependencies: DoctorDependencies = {
  resolveExecutable: findExecutablePath,
  loadAgents,
  inspectStaleWorkspaces: (options) => cleanupStaleWorkspaceSnapshots(options),
  workspaceRoot: getWorkspaceRoot,
  async runVersionCommand(path) {
    try {
      const result = await new Deno.Command(path, {
        args: ["--version"],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).output();
      if (!result.success) return undefined;
      return new TextDecoder().decode(result.stdout).trim().split(/\s+/, 1)[0];
    } catch {
      return undefined;
    }
  },
};

function aggregate(checks: DiagnosticCheck[]): DoctorReport["status"] {
  if (checks.some((check) => check.status === "error")) return "errors";
  if (checks.some((check) => check.status === "warning")) return "warnings";
  return "healthy";
}

function versionAtLeast(actual: string, required: string): boolean | undefined {
  const actualParts = actual.match(/^(?:v)?(\d+)\.(\d+)\.(\d+)/);
  const requiredParts = required.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!actualParts || !requiredParts) return undefined;
  const a = actualParts.slice(1).map(Number);
  const r = requiredParts.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== r[i]) return a[i] > r[i];
  }
  return true;
}

async function inspectConfig(
  path: string,
  explicit: boolean,
  loadAgentsFn: DoctorDependencies["loadAgents"],
): Promise<{ status: DiagnosticStatus; summary: string; detail?: string }> {
  try {
    const info = await Deno.stat(path);
    if (!info.isFile) {
      return { status: "error", summary: "config path is not a file" };
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return explicit
        ? {
          status: "error",
          summary:
            "explicit config file does not exist; built-in profiles are used by the server when a config is absent",
        }
        : {
          status: "ok",
          summary: "not present; built-in profiles are active",
        };
    }
    return { status: "error", summary: "config file cannot be accessed" };
  }

  try {
    await loadAgentsFn(path);
    return { status: "ok", summary: "valid" };
  } catch {
    return {
      status: "error",
      summary: "invalid JSON or agent configuration",
      detail:
        "The config could not be loaded. Values are omitted to avoid exposing secrets.",
    };
  }
}

async function agentChecks(
  agents: Record<string, AgentDefinition>,
  dependencies: DoctorDependencies,
): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  for (
    const [id, agent] of Object.entries(agents).sort(([a], [b]) =>
      a.localeCompare(b)
    )
  ) {
    const commandPath = await dependencies.resolveExecutable(agent.command);
    if (!commandPath) {
      checks.push({
        id: `agent.${id}`,
        status: "error",
        summary:
          `${id}: command not found (${agent.command}); ${agent.args.length} configured argument(s)`,
        ...(agent.installHint
          ? { detail: "See the agent installation instructions in README." }
          : {}),
      });
      continue;
    }
    checks.push({
      id: `agent.${id}`,
      status: "ok",
      summary:
        `${id}: ${commandPath}; ${agent.args.length} configured argument(s)`,
    });

    for (
      const [index, prerequisite] of (BUILTIN_RUNTIME_PREREQUISITES[id] ?? [])
        .entries()
    ) {
      const prerequisiteId = `runtime.${id}.${index + 1}`;
      const prerequisitePath = await dependencies.resolveExecutable(
        prerequisite.command,
      );
      if (!prerequisitePath) {
        checks.push({
          id: prerequisiteId,
          status: "error",
          summary: `${id} requires ${prerequisite.command}${
            prerequisite.minimumVersion
              ? ` ${prerequisite.minimumVersion} or later`
              : ""
          }; command was not found`,
        });
        continue;
      }
      if (!prerequisite.minimumVersion) {
        checks.push({
          id: prerequisiteId,
          status: "ok",
          summary: `${id} prerequisite found: ${prerequisite.command}`,
        });
        continue;
      }
      const actualVersion = await dependencies.runVersionCommand(
        prerequisitePath,
      );
      const satisfies = actualVersion
        ? versionAtLeast(actualVersion, prerequisite.minimumVersion)
        : undefined;
      checks.push(
        satisfies === true
          ? {
            id: prerequisiteId,
            status: "ok",
            summary: `${prerequisite.command} ${actualVersion}`,
          }
          : {
            id: prerequisiteId,
            status: "error",
            summary: actualVersion
              ? `${id} requires ${prerequisite.command} ${prerequisite.minimumVersion} or later; found ${actualVersion}`
              : `Could not read ${prerequisite.command} version required by ${id}`,
          },
      );
    }
  }
  return checks;
}

export async function diagnose(
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = defaultDependencies,
): Promise<DoctorReport> {
  const checks: DiagnosticCheck[] = [];
  let configPath: string | null = null;
  try {
    configPath = options.configPath ?? defaultConfigPath();
    const configCheck = await inspectConfig(
      configPath,
      options.configPath !== undefined,
      dependencies.loadAgents,
    );
    checks.push({ id: "config", ...configCheck });
  } catch {
    checks.push({
      id: "config",
      status: "error",
      summary:
        "config path could not be determined; set the normal user config location or pass --config",
    });
  }

  if (
    configPath &&
    !checks.some((check) => check.id === "config" && check.status === "error")
  ) {
    try {
      const agents = await dependencies.loadAgents(configPath);
      checks.push(...await agentChecks(agents, dependencies));
    } catch {
      // The config check already reports the load failure without exposing values.
    }
  }

  try {
    const root = await dependencies.workspaceRoot();
    let rootStatus: Deno.FileInfo | undefined;
    try {
      rootStatus = await Deno.lstat(root);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (rootStatus && (!rootStatus.isDirectory || rootStatus.isSymlink)) {
      checks.push({
        id: "workspace.root",
        status: "error",
        summary: "disposable workspace root is not a plain directory",
      });
    } else {
      checks.push({
        id: "workspace.root",
        status: "ok",
        summary: rootStatus ? `available: ${root}` : `not created yet: ${root}`,
      });
    }
    const stale = await dependencies.inspectStaleWorkspaces({
      delete: false,
      checkCreatorProcess: false,
    });
    const creatorUnchecked = stale.entries.filter((entry) =>
      entry.reason === "creator_process_status_not_checked"
    ).length;
    if (stale.failed > 0 || stale.eligible > 0 || creatorUnchecked > 0) {
      checks.push({
        id: "workspace.stale",
        status: "warning",
        summary:
          `${stale.eligible} stale workspace(s) eligible; ${creatorUnchecked} age-qualified workspace(s) not checked for an active creator; ${stale.failed} inspection failure(s)`,
        detail:
          "Doctor never deletes workspaces. Use list_stale_workspaces and cleanup_stale_workspaces through MCP to inspect and explicitly remove eligible leftovers.",
      });
    } else {
      checks.push({
        id: "workspace.stale",
        status: "ok",
        summary: "no age-qualified stale workspaces",
      });
    }
  } catch {
    checks.push({
      id: "workspace.root",
      status: "warning",
      summary: "disposable workspace root could not be inspected",
    });
  }

  return {
    version: VERSION,
    platform: Deno.build.os,
    architecture: Deno.build.arch,
    configPath,
    status: aggregate(checks),
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `acp-mcp doctor ${report.version} (${report.platform}/${report.architecture})`,
    `Config: ${report.configPath ?? "unavailable"}`,
  ];
  for (const check of report.checks) {
    const label = check.status.toUpperCase().padEnd(7);
    lines.push(`${label} ${check.summary}`);
    if (check.detail) lines.push(`        ${check.detail}`);
  }
  const count = (status: DiagnosticStatus) =>
    report.checks.filter((check) => check.status === status).length;
  lines.push(
    `Result: ${report.status} (${count("error")} errors, ${
      count("warning")
    } warnings)`,
  );
  return lines.join("\n");
}
