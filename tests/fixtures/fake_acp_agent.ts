import {
  agent,
  ndJsonStream,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

const app = agent({ name: "fake-acp-agent" });
const cancelled = new Set<string>();
let booleanOptionsSupported = false;
let activeConfigOptions: SessionConfigOption[] = [];
app.onRequest(
  "initialize",
  ({ params }) => {
    const capabilities = (params as {
      clientCapabilities?: {
        session?: { configOptions?: { boolean?: unknown } };
      };
    }).clientCapabilities;
    booleanOptionsSupported =
      capabilities?.session?.configOptions?.boolean !== undefined;
    return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  },
);
app.onRequest("session/new", () => {
  const delayArgument = Deno.args.find((arg) =>
    arg.startsWith("--session-delay-ms=")
  );
  if (delayArgument) {
    const delay = Number(delayArgument.split("=")[1]);
    return new Promise((resolve) => {
      setTimeout(
        () => resolve({ sessionId: crypto.randomUUID(), configOptions: [] }),
        delay,
      );
    });
  }
  if (Deno.args.includes("--session-fail")) {
    throw new Error("fixture session creation failed");
  }
  const configOptions: SessionConfigOption[] =
    Deno.args.includes("--advertise-models")
      ? [
        {
          id: "engine-selector",
          name: "Engine",
          category: "model",
          type: "select" as const,
          currentValue: "opencode/fledge-alpha-free",
          options: [
            {
              value: "opencode/fledge-alpha-free",
              name: "opencode/Fledge Alpha Free",
            },
            { value: "opencode/paid-model", name: "Paid Model" },
            {
              value: "opencode/available-without-metadata",
              name: "Unmatched ACP Model",
            },
          ],
        },
        {
          id: "backend-choice",
          name: "Backend model",
          type: "select" as const,
          currentValue: "local/model-z",
          options: [{ value: "local/model-z", name: "Local Model Z" }],
        },
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select" as const,
          currentValue: "hidden/model",
          options: [{ value: "hidden/model", name: "Not a model" }],
        },
      ]
      : [];
  if (Deno.args.includes("--advertise-bool")) {
    if (!booleanOptionsSupported) {
      throw new Error("Client did not advertise boolean config options");
    }
    configOptions.push({
      id: "use-fast-mode",
      name: "Fast mode",
      category: "model_config",
      type: "boolean",
      currentValue: false,
    });
  }
  activeConfigOptions = configOptions;
  return { sessionId: crypto.randomUUID(), configOptions };
});
app.onRequest("session/load", () => ({}));
app.onRequest("session/set_config_option", ({ params }) => {
  const { configId, type, value } = params as {
    configId: string;
    type?: string;
    value: string | boolean;
  };
  if (configId === "use-fast-mode") {
    if (type !== "boolean" || typeof value !== "boolean") {
      throw new Error("Boolean option was not sent with ACP boolean semantics");
    }
    activeConfigOptions = activeConfigOptions.map((option) =>
      option.id === configId
        ? { ...option, currentValue: value } as SessionConfigOption
        : option
    );
  }
  return { configOptions: activeConfigOptions };
});
app.onRequest("session/prompt", async ({ params, client }) => {
  const sessionId = params.sessionId;
  const promptText = params.prompt.map((block) =>
    block.type === "text" ? block.text : ""
  ).join("");
  cancelled.delete(sessionId);
  if (promptText === "prompt failure") {
    throw new Error("PRIVATE_FAILURE_SENTINEL");
  }
  if (promptText === "rate limit failure") {
    throw new Error(
      "Rate limit exceeded. Please try again later. PRIVATE_PROVIDER_DIAGNOSTIC_SENTINEL",
    );
  }
  if (promptText === "unrelated provider failure") {
    throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC_SENTINEL: connection reset");
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
