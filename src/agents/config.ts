export interface AgentDefinition {
  command: string;
  args: string[];
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
}

/** Trusted local runtime requirements for maintained built-in adapters. */
export const BUILTIN_RUNTIME_PREREQUISITES: Record<
  string,
  Array<{ command: string; minimumVersion?: string }>
> = {
  claude: [{ command: "node", minimumVersion: "22.0.0" }],
};

export type AgentMap = Record<string, AgentDefinition>;

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
      supportedProtocols: ["v1"],
      displayName: "Antigravity",
      installHint:
        "Install Google Antigravity ACP from the official Agent Client Protocol Registry. Configure the executable's absolute path in the acp-mcp agent config (Windows: agy_acp_server.exe); changing PATH is not required.",
    },
  };
  const path = configPath ?? defaultConfigPath();
  try {
    const text = await Deno.readTextFile(path);
    const parsed = JSON.parse(text) as { agents?: AgentMap };
    if (!parsed.agents || typeof parsed.agents !== "object") {
      throw new Error("Config must contain an agents object");
    }
    for (const [id, def] of Object.entries(parsed.agents)) {
      if (
        !id || !def || typeof def.command !== "string" ||
        !Array.isArray(def.args) || !def.args.every((x) =>
          typeof x === "string"
        )
      ) {
        throw new Error(`Invalid agent definition: ${id}`);
      }
      if (
        def.acpProtocol !== undefined && def.acpProtocol !== "v1" &&
        def.acpProtocol !== "v2"
      ) {
        throw new Error(`Invalid ACP protocol for agent: ${id}`);
      }
      const builtIn = agents[id];
      agents[id] = {
        ...builtIn,
        ...def,
        env: { ...builtIn?.env, ...def.env },
        supportedProtocols: builtIn?.supportedProtocols ??
          def.supportedProtocols,
        protocolEnv: builtIn?.protocolEnv ?? def.protocolEnv,
        acpProtocol: def.acpProtocol ?? builtIn?.acpProtocol ?? "v1",
      };
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return agents;
}
