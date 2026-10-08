export interface AgentDefinition {
  command: string;
  args: string[];
  displayName?: string;
  installHint?: string;
  cwd?: string;
  env?: Record<string, string>;
  modelConfigId?: string;
  modelEnrichment?: "opencode_catalog";
  failureClassifier?: string;
}

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
      displayName: "Codex",
      installHint:
        "Install globally with npm install -g @agentclientprotocol/codex-acp, or explicitly configure npx -y @agentclientprotocol/codex-acp. CODEX_PATH can select another Codex executable.",
    },
    antigravity: {
      command: antigravityCommand,
      args: Deno.build.os === "linux" ? ["--uid="] : [],
      displayName: "Antigravity",
      installHint:
        "Install Google Antigravity ACP from the official Agent Client Protocol Registry. On Windows, configure agy_acp_server.exe or add it to PATH.",
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
      agents[id] = def;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return agents;
}
