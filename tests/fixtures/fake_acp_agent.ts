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
  const promptText = params.prompt.map((block) =>
    block.type === "text" ? block.text : ""
  ).join("");
  cancelled.delete(sessionId);
  if (promptText === "prompt failure") {
    throw new Error("PRIVATE_FAILURE_SENTINEL");
  }
  if (promptText === "process crash") {
    Deno.exit(17);
  }
  if (promptText === "empty response") return { stopReason: "end_turn" };
  if (promptText === "permission" || promptText === "operator delegate") {
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
  if (promptText === "wait") {
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
  void Deno.stderr.write(new TextEncoder().encode("ACP_CANCEL_RECEIVED\n"));
});
app.connect(ndJsonStream(Deno.stdout.writable, Deno.stdin.readable));
