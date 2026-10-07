const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffer = "";

async function write(value: unknown) {
  await Deno.stdout.write(encoder.encode(`${JSON.stringify(value)}\n`));
}

async function handle(line: string) {
  let message: {
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
  };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message.method || message.id === undefined) return;
  let result: unknown = {};
  if (message.method === "initialize") {
    result = { protocolVersion: 1, agentCapabilities: {} };
  } else if (message.method === "session/new") {
    result = { sessionId: crypto.randomUUID() };
  } else if (message.method === "session/prompt") {
    const sessionId = message.params?.sessionId;
    if (typeof sessionId === "string") {
      const raw = (
        sessionUpdate: unknown,
        extra: Record<string, unknown> = {},
      ) => ({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: sessionUpdate,
          _meta: { fixture: "raw-wire", ordinal: extra.ordinal },
          ...extra,
        },
      });
      await write(raw({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "raw " },
      }, { ordinal: 1 }));
      await write(
        raw({ sessionUpdate: "future_update", detail: { retained: true } }, {
          ordinal: 2,
        }),
      );
      await write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "reply" },
          },
          _meta: { fixture: "raw-wire", ordinal: 3 },
        },
      });
      await write({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "unrouteable" } },
      });
    }
    result = { stopReason: "end_turn" };
  } else if (message.method === "session/close") {
    result = {};
  }
  await write({ jsonrpc: "2.0", id: message.id, result });
}

const reader = Deno.stdin.readable.getReader();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    await handle(line);
  }
}
