export interface AgentDefinition {
  command: string;
  args: string[];
  /** Built-in Antigravity implementation selector; omitted means official. */
  implementation?: "official" | "refined" | "agy";
  acpProtocol?: "v1" | "v2";
  /** Protocols confirmed for this maintained profile; custom agents may omit it. */
  supportedProtocols?: Array<"v1" | "v2">;
  /** Protocol-specific launch environment supplied by a maintained profile. */
  protocolEnv?: Partial<Record<"v1" | "v2", Record<string, string>>>;
  displayName?: string;
  installHint?: string;
  env?: Record<string, string>;
  modelConfigId?: string;
  modelEnrichment?: "opencode_catalog";
  failureClassifier?: string;
  /** Trusted local requirements owned by the selected built-in profile. */
  runtimePrerequisites?: Array<{
    command: string;
    minimumVersion?: string;
  }>;
  /** Environment values which must resolve to executable files before launch. */
  requiredExecutableEnv?: string[];
}

export type AgentMap = Record<string, AgentDefinition>;

export const ANTIGRAVITY_AGY_ACP_RELEASE = {
  version: "1.2.0",
  revision: "d10aa13c932236ef241863f2c8b3afdda2a2be12",
  target: "windows-x86_64",
  asset: "agy-acp-windows-x64.exe",
  url:
    "https://github.com/shubzkothekar/antigravity-acp/releases/download/v1.2.0/agy-acp-windows-x64.exe",
  sha256: "fe7515f0e7de51e09f9c8b2c70c6c4ec2a9bd9f08850c21ba86a1fcbe8ff7074",
} as const;

export function antigravityAgyAcpInstallPath(
  localAppData = Deno.env.get("LOCALAPPDATA"),
): string {
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set; pass an explicit agent command");
  }
  return `${localAppData}\\acp-mcp\\agents\\antigravity-agy\\${ANTIGRAVITY_AGY_ACP_RELEASE.version}\\${ANTIGRAVITY_AGY_ACP_RELEASE.asset}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function defaultConfigPath(): string {
  if (Deno.build.os === "windows") {
    const appData = Deno.env.get("APPDATA");
    if (!appData) throw new Error("APPDATA is not set; pass --config <path>");
    return `${appData}\\acp-mcp\\config.json`;
  }
  const configHome = Deno.env.get("XDG_CONFIG_HOME") ??
    `${Deno.env.get("HOME")}/.config`;
  return `${configHome}/acp-mcp/config.json`;
}

export async function loadAgents(configPath?: string): Promise<AgentMap> {
  const antigravityCommand = Deno.build.os === "windows"
    ? "agy_acp_server"
    : "agy_acp_server.par";
  const agents: AgentMap = {
    opencode: {
      command: "opencode",
      args: ["acp"],
      supportedProtocols: ["v1"],
      displayName: "OpenCode",
      installHint:
        "Install OpenCode and authenticate with opencode auth login.",
      modelConfigId: "model",
      modelEnrichment: "opencode_catalog",
      failureClassifier: "opencode",
    },
    codex: {
      command: "codex-acp",
      args: [],
      supportedProtocols: ["v1"],
      displayName: "Codex",
      installHint:
        "Install globally with npm install -g @agentclientprotocol/codex-acp, or explicitly configure npx -y @agentclientprotocol/codex-acp. CODEX_PATH can select another Codex executable.",
    },
    claude: {
      command: "claude-agent-acp",
      args: [],
      supportedProtocols: ["v1", "v2"],
      runtimePrerequisites: [{ command: "node", minimumVersion: "22.0.0" }],
      protocolEnv: {
        v2: { CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: "1" },
      },
      displayName: "Claude Agent ACP",
      installHint:
        "Install Node.js 22 or later, then install the official adapter with npm install -g @agentclientprotocol/claude-agent-acp. Configure command, args, or env in the acp-mcp agent config for a user-local installation or provider setup.",
    },
    antigravity: {
      command: antigravityCommand,
      args: Deno.build.os === "linux" ? ["--uid="] : [],
      implementation: "official",
      supportedProtocols: ["v1"],
      displayName: "Antigravity",
      installHint:
        "Install Google Antigravity ACP from the official Agent Client Protocol Registry. Configure the executable's absolute path in the acp-mcp agent config (Windows: agy_acp_server.exe); changing PATH is not required.",
    },
  };
  const localAppData = Deno.build.os === "windows"
    ? Deno.env.get("LOCALAPPDATA")
    : undefined;
  const agyAcpCommand = Deno.build.os === "windows" &&
      Deno.build.arch === "x86_64" && localAppData
    ? antigravityAgyAcpInstallPath(localAppData)
    : "agy-acp-windows-x64.exe";
  const antigravityImplementations: Record<
    "official" | "refined" | "agy",
    AgentDefinition
  > = {
    official: agents.antigravity,
    refined: {
      command: "refined-antigravity-acp",
      args: [],
      implementation: "refined",
      supportedProtocols: ["v1"],
      displayName: "Antigravity (Refined)",
      installHint:
        "Install @simonepri/refined-antigravity-acp and Node.js 22 or later. Set env.REFINED_AGY_ACP_BIN to the absolute path of an already-installed official agy_acp_server executable; this prevents the wrapper from downloading its backend during startup.",
      runtimePrerequisites: [{ command: "node", minimumVersion: "22.0.0" }],
      requiredExecutableEnv: ["REFINED_AGY_ACP_BIN"],
    },
    agy: {
      command: agyAcpCommand,
      args: [],
      implementation: "agy",
      supportedProtocols: ["v1"],
      displayName: "Antigravity (agy ACP)",
      installHint:
        "Provision the pinned Windows x64 adapter with 'mise exec -- deno task provision:antigravity-agy'. Set env.AGY_BIN to an existing agy executable; the adapter skips downloads when AGY_BIN is supplied.",
      modelConfigId: "model",
      requiredExecutableEnv: ["AGY_BIN"],
    },
  };
  const explicitConfigPath = configPath !== undefined;
  const path = configPath ?? defaultConfigPath();
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound && !explicitConfigPath) {
      return agents;
    }
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Explicit config file does not exist: ${path}`);
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
  if (!isRecord(parsed.agents)) {
    throw new Error(`Config file '${path}' must contain an 'agents' object`);
  }

  for (const [id, rawDefinition] of Object.entries(parsed.agents)) {
    if (!isRecord(rawDefinition)) {
      throw new Error(`Agent '${id}' must be a JSON object`);
    }
    const def = rawDefinition as Partial<AgentDefinition>;
    if (!id) {
      throw new Error("Agent ID must not be empty");
    }
    if (def.implementation !== undefined) {
      if (id !== "antigravity") {
        throw new Error(
          `Agent '${id}' implementation is only valid for 'antigravity'`,
        );
      }
      if (
        def.implementation !== "official" && def.implementation !== "refined" &&
        def.implementation !== "agy"
      ) {
        throw new Error(
          "Agent 'antigravity' implementation must be 'official', 'refined', or 'agy'",
        );
      }
    }
    const builtIn = id === "antigravity"
      ? antigravityImplementations[def.implementation ?? "official"]
      : agents[id];
    if (
      def.command !== undefined &&
      (typeof def.command !== "string" || !def.command.trim())
    ) {
      throw new Error(`Agent '${id}' command must be a non-empty string`);
    }
    if (def.command === undefined && !builtIn) {
      throw new Error(`Agent '${id}' command must be a non-empty string`);
    }
    if (
      def.args !== undefined && (!Array.isArray(def.args) ||
        !def.args.every((x) => typeof x === "string"))
    ) {
      throw new Error(`Agent '${id}' args must be an array of strings`);
    }
    if (def.args === undefined && !builtIn) {
      throw new Error(`Agent '${id}' args must be an array of strings`);
    }
    if (def.env !== undefined) {
      if (!isRecord(def.env)) {
        throw new Error(`Agent '${id}' env must be an object of string values`);
      }
      for (const [name, value] of Object.entries(def.env)) {
        if (typeof value !== "string") {
          throw new Error(
            `Agent '${id}' env value for '${name}' must be a string`,
          );
        }
      }
    }
    if (
      def.acpProtocol !== undefined && def.acpProtocol !== "v1" &&
      def.acpProtocol !== "v2"
    ) {
      throw new Error(`Agent '${id}' acpProtocol must be 'v1' or 'v2'`);
    }
    agents[id] = {
      ...builtIn,
      ...rawDefinition,
      env: { ...builtIn?.env, ...def.env },
      supportedProtocols: builtIn?.supportedProtocols ??
        def.supportedProtocols,
      protocolEnv: builtIn?.protocolEnv ?? def.protocolEnv,
      acpProtocol: def.acpProtocol ?? builtIn?.acpProtocol ?? "v1",
      implementation: builtIn?.implementation,
      runtimePrerequisites: builtIn?.runtimePrerequisites,
      requiredExecutableEnv: builtIn?.requiredExecutableEnv,
    };
  }
  return agents;
}
