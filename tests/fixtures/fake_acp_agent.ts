import { agent, ndJsonStream } from "@agentclientprotocol/sdk";

const app = agent({ name: "fake-acp-agent" });
const cancelled = new Set<string>();
app.onRequest(
  "initialize",
  () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
);
app.onRequest("session/new", () => ({ sessionId: crypto.randomUUID() }));
app.onRequest("session/load", () => ({}));
app.onRequest("session/prompt", async ({ params, client }) => {
  const sessionId = params.sessionId;
  cancelled.delete(sessionId);
  if (
    params.prompt.some((block) =>
      block.type === "text" && block.text === "permission"
    )
  ) {
    const answer = await client.request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "fake-call", kind: "execute" },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject once", kind: "reject_once" },
      ],
    });
    await client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: answer.outcome.outcome === "selected"
            ? answer.outcome.optionId
            : "cancelled",
        },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (
    params.prompt.some((block) =>
      block.type === "text" && block.text === "wait"
    )
  ) {
    while (!cancelled.has(sessionId)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { stopReason: "cancelled" };
  }
  await client.notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "fake reply" },
    },
  });
  return { stopReason: "end_turn" };
});
app.onNotification("session/cancel", ({ params }) => {
  cancelled.add(params.sessionId);
});
app.connect(ndJsonStream(Deno.stdout.writable, Deno.stdin.readable));
