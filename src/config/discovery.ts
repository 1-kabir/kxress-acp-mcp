import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type AgentMap,
  builtInAgents,
  parseAgentConfig,
} from "../agents/config.ts";
import { validateModelPolicy } from "../models/policy.ts";

export interface ConfigSource {
  kind: "explicit" | "home" | "project" | "unknown";
  path: string;
}

export interface ResolvedConfiguration {
  agents: AgentMap;
  sources: ConfigSource[];
  cwd: string;
  explicit: boolean;
}

export interface ConfigDiscoveryOptions {
  explicitConfigPath?: string;
  cwd?: string;
  homeDirectory?: string;
  includeProject?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identity(path: string): string {
  const normalized = resolve(path);
  return Deno.build.os === "windows" ? normalized.toLowerCase() : normalized;
}

function mergeObjects(base: unknown, overlay: unknown): unknown {
  if (!isRecord(base) || !isRecord(overlay)) {
    return Array.isArray(overlay) ? [...overlay] : overlay;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = key in result && isRecord(result[key]) && isRecord(value)
      ? mergeObjects(result[key], value)
      : Array.isArray(value)
      ? [...value]
      : value;
  }
  return result;
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const info = await Deno.stat(path);
    if (!info.isFile) throw new Error(`Config file '${path}' is not a file`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Config file '${path}' does not exist`);
    }
    throw error;
  }
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Config file '${path}' does not exist`);
    }
    throw new Error(`Could not read config file '${path}': ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Config file '${path}' is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Config file '${path}' must contain a JSON object`);
  }
  if (parsed.agents !== undefined && !isRecord(parsed.agents)) {
    throw new Error(`Config file '${path}' must contain an 'agents' object`);
  }
  return parsed;
}

const FORBIDDEN_PROJECT_FIELDS = new Set([
  "command",
  "args",
  "env",
  "protocolEnv",
  "acpProtocol",
  "supportedProtocols",
  "runtimePrerequisites",
  "requiredExecutableEnv",
  "modelConfigId",
  "modelEnrichment",
  "failureClassifier",
]);

function validateProjectConfig(
  config: Record<string, unknown>,
  path: string,
): void {
  if (config.agents === undefined) return;
  if (!isRecord(config.agents)) {
    throw new Error(`Config file '${path}' must contain an 'agents' object`);
  }
  for (const [agentId, raw] of Object.entries(config.agents)) {
    if (!isRecord(raw)) {
      throw new Error(
        `Config file '${path}': agent '${agentId}' must be an object`,
      );
    }
    for (const key of Object.keys(raw)) {
      if (FORBIDDEN_PROJECT_FIELDS.has(key)) {
        throw new Error(
          `Config file '${path}': agents.${agentId}.${key} is not allowed in project configuration`,
        );
      }
    }
    if (raw.implementation !== undefined) {
      if (agentId !== "antigravity") {
        throw new Error(
          `Config file '${path}': agents.${agentId}.implementation is only valid for 'antigravity'`,
        );
      }
      if (
        !(["official", "refined", "agy"] as unknown[]).includes(
          raw.implementation,
        )
      ) {
        throw new Error(
          `Config file '${path}': agents.antigravity.implementation must be 'official', 'refined', or 'agy'`,
        );
      }
    }
    if (raw.models !== undefined) {
      validateModelPolicy(raw.models, agentId, path);
    }
  }
}

function homeDirectory(options: ConfigDiscoveryOptions): string | undefined {
  if (options.homeDirectory !== undefined) return options.homeDirectory;
  return Deno.build.os === "windows"
    ? Deno.env.get("USERPROFILE")
    : Deno.env.get("HOME");
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await Deno.stat(path);
    if (!info.isFile) throw new Error(`Config path '${path}' is not a file`);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function projectConfigPaths(cwd: string): Promise<string[]> {
  const paths: string[] = [];
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".acp-mcp.json");
    if (await exists(candidate)) paths.push(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths.reverse();
}

export async function resolveConfiguration(
  options: ConfigDiscoveryOptions = {},
): Promise<ResolvedConfiguration> {
  const cwd = resolve(options.cwd ?? Deno.cwd());
  if (options.explicitConfigPath !== undefined) {
    const path = isAbsolute(options.explicitConfigPath)
      ? options.explicitConfigPath
      : resolve(options.explicitConfigPath);
    let raw: Record<string, unknown>;
    try {
      raw = await readConfig(path);
    } catch (error) {
      if (error instanceof Error && /does not exist/i.test(error.message)) {
        throw new Error(`Explicit config file does not exist: ${path}`);
      }
      throw error;
    }
    const agents = parseAgentConfig(raw, path);
    return {
      agents,
      sources: [{ kind: "explicit", path }],
      cwd,
      explicit: true,
    };
  }

  const sources: ConfigSource[] = [];
  const configObjects: Array<
    { path: string; kind: "home" | "project"; value: Record<string, unknown> }
  > = [];
  const home = homeDirectory(options);
  let homePath: string | undefined;
  if (home) {
    homePath = join(home, ".acp-mcp.json");
    if (await exists(homePath)) {
      const value = await readConfig(homePath);
      // Home configuration is trusted and may define launch/runtime details.
      parseAgentConfig(value, homePath);
      configObjects.push({ path: homePath, kind: "home", value });
      sources.push({ kind: "home", path: homePath });
    }
  }

  for (
    const path of options.includeProject === false
      ? []
      : await projectConfigPaths(cwd)
  ) {
    if (homePath && identity(path) === identity(homePath)) continue;
    const value = await readConfig(path);
    validateProjectConfig(value, path);
    configObjects.push({ path, kind: "project", value });
    sources.push({ kind: "project", path });
  }

  let merged: unknown = { agents: {} };
  for (const layer of configObjects) {
    merged = mergeObjects(merged, layer.value);
  }
  const lastPath = configObjects.at(-1)?.path ?? "<built-in profiles>";
  const agents = configObjects.length
    ? parseAgentConfig(merged, lastPath)
    : builtInAgents();
  return { agents, sources, cwd, explicit: false };
}
