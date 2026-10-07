import process from "node:process";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadAgents } from "./agents/config.ts";
import { createMcpServer } from "./mcp/server.ts";
import { SessionManager } from "./sessions/manager.ts";

const args = [...Deno.args];
let configPath: string | undefined;
if (args[0] === "--config" && args[1]) configPath = args[1];
const agents = await loadAgents(configPath);
const manager = new SessionManager(agents);
const server = createMcpServer(agents, manager);
let closing: Promise<void> | undefined;
const closeSessions = () => closing ??= manager.closeAll();
try {
  Deno.addSignalListener("SIGINT", () => {
    void closeSessions().finally(() => Deno.exit(0));
  });
} catch { /* Signal support varies by platform. */ }
process.stdin.once("end", closeSessions);
process.stdin.once("close", closeSessions);
serveStdio(() => server);
