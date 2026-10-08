export interface AgentDefinition {
  command: string;
  args: string[];
  displayName?: string;
  installHint?: string;
  cwd?: string;
  env?: Record<string, string>;
  modelConfigId?: string;
  modelEnrichment?: "opencode_zen";
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
  const agents: AgentMap = {
    opencode: {
      command: "opencode",
      args: ["acp"],
      displayName: "OpenCode",
      installHint:
        "Install OpenCode and authenticate with opencode auth login.",
      modelConfigId: "model",
      modelEnrichment: "opencode_zen",
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
