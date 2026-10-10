import process from "node:process";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolveConfiguration } from "./config/discovery.ts";
import { createMcpServer } from "./mcp/server.ts";
import { SessionManager } from "./sessions/manager.ts";

export async function startMcpServer(configPath?: string): Promise<void> {
  const startup = await resolveConfiguration({
    explicitConfigPath: configPath,
    cwd: Deno.cwd(),
    includeProject: false,
  });
  const agents = startup.agents;
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager, {
    resolveConfiguration: (cwd) =>
      resolveConfiguration({
        explicitConfigPath: configPath,
        cwd: cwd ?? Deno.cwd(),
      }),
  });
  let closing: Promise<void> | undefined;
  const closeSessions = () => closing ??= manager.closeAll();
  try {
    Deno.addSignalListener("SIGINT", () => {
      void closeSessions().finally(() => Deno.exit(0));
    });
  } catch { /* Signal support varies by platform. */ }
  process.stdin.once("end", closeSessions);
  process.stdin.once("close", closeSessions);
  await serveStdio(() => server);
}
