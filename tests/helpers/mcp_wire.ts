import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";

export async function connectMcp(server: McpServer) {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  let nextId = 0;
  const pending = new Map<number, (message: unknown) => void>();
  client.onmessage = (message) => {
    if ("id" in message && typeof message.id === "number") {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  await client.start();
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    const response = new Promise<unknown>((resolve) => {
      pending.set(id, resolve);
    });
    void client.send({ jsonrpc: "2.0", id, method, params } as never);
    return { id, response };
  };
  const initialized = request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "delegate-test", version: "1" },
  });
  await initialized.response;
  await client.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  } as never);
  return {
    listTools() {
      return request("tools/list");
    },
    callTool(name: string, args: Record<string, unknown>) {
      return request("tools/call", { name, arguments: args });
    },
    async cancel(requestId: number) {
      await client.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId, reason: "test cancellation" },
      } as never);
    },
    close: () => client.close(),
  };
}

export function parseToolResult(message: unknown): Record<string, unknown> {
  const result = (
    message as { result?: { content?: Array<{ text?: string }> } }
  ).result;
  const text = result?.content?.find((item) => item.text)?.text;
  if (!text) throw new Error("MCP tools/call returned no text result");
  return JSON.parse(text);
}
