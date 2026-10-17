import process from "node:process";
import * as nodeFs from "#fs";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffer = "";
let outputQueue = Promise.resolve();
let nextServerId = 10_000;
const pending = new Map<string | number, (value: unknown) => void>();
const cancelled = new Set<string>();
let currentOptions: Array<Record<string, unknown>> = [];
const launchMarker = process.env["ACPMCP_V2_FIXTURE_LAUNCH_MARKER"];
if (launchMarker) {
  await nodeFs.writeText(launchMarker, "launch\n", { append: true });
}
if (
  process.argv.slice(2).includes("--expect-claude-v2-env") &&
  process.env["CLAUDE_AGENT_ACP_EXPERIMENTAL_V2"] !== "1"
) {
  throw new Error("Claude v2 profile activation environment was not applied");
}
if (
  process.argv.slice(2).includes("--expect-composed-launch-env") &&
  (process.env["ACPMCP_FIXTURE_PARENT_VALUE"] !== "parent-runtime" ||
    process.env["ACPMCP_FIXTURE_USER_VALUE"] !== "user-config" ||
    process.env["OPENROUTER_API_KEY"] !== "FAKE_SECRET_VALUE" ||
    process.env["CLAUDE_AGENT_ACP_EXPERIMENTAL_V2"] !== "user-override")
) {
  throw new Error("Expected launch environment was not composed");
}

function write(value: unknown): Promise<void> {
  const bytes = encoder.encode(`${JSON.stringify(value)}\n`);
  outputQueue = outputQueue.then(async () => {
    await process.stdout.write(bytes);
  });
  return outputQueue;
}

function update(sessionId: string, value: Record<string, unknown>) {
  return write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value, _meta: { fixture: "fake-v2" } },
  });
}

function updateBatch(
  sessionId: string,
  updates: Array<Record<string, unknown>>,
) {
  return write(
    updates.map((value) => ({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: value, _meta: { fixture: "fake-v2" } },
    })),
  );
}

function requestClient(method: string, params: unknown): Promise<unknown> {
  const id = nextServerId++;
  const result = new Promise((resolve) => pending.set(id, resolve));
  void write({ jsonrpc: "2.0", id, method, params });
  return result;
}

async function promptWork(sessionId: string, text: string) {
  await update(sessionId, { sessionUpdate: "state_update", state: "running" });
  if (text === "delayed-completion") {
    await update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "delayed-answer",
      content: { type: "text", text: "still working" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "delayed-answer",
      content: { type: "text", text: " then done" },
    });
  } else if (text === "permission") {
    const response = (await requestClient("session/request_permission", {
      sessionId,
      title: "Run a command",
      subject: {
        type: "command",
        command: "dangerous command",
        cwd: process.cwd(),
      },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject once", kind: "reject_once" },
      ],
    })) as { outcome?: { outcome?: string; optionId?: string } };
    await update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer",
      content: {
        type: "text",
        text: response.outcome?.optionId ?? "cancelled",
      },
    });
  } else if (text === "wait") {
    while (!cancelled.has(sessionId)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } else if (text === "activity") {
    for (let index = 0; index < 5; index++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await update(sessionId, {
        sessionUpdate: "_future_v2_update",
        index,
      });
    }
    await update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer",
      content: { type: "text", text: "activity kept the task alive" },
    });
  } else if (text === "error") {
    await update(sessionId, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: {
        code: -32042,
        message: "fixture prompt error",
        data: { kind: "test" },
      },
    });
    return;
  } else if (text === "snapshot") {
    await updateBatch(sessionId, [
      { sessionUpdate: "_future_v2_update", marker: "retained" },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "answer",
        content: { type: "text", text: "partial " },
      },
    ]);
    await update(sessionId, {
      sessionUpdate: "agent_message",
      messageId: "answer",
      content: [{ type: "text", text: "replacement" }],
    });
  } else {
    await update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer",
      content: { type: "text", text: "v2 reply" },
    });
  }
  const reason = cancelled.has(sessionId) ? "cancelled" : "end_turn";
  await update(sessionId, {
    sessionUpdate: "state_update",
    state: "idle",
    stopReason: reason,
  });
}

async function handle(message: Record<string, unknown>) {
  const id = message.id as string | number | undefined;
  const method = message.method;
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (typeof method !== "string") {
    if (id !== undefined && pending.has(id)) {
      pending.get(id)?.(message.result);
      pending.delete(id);
    }
    return;
  }
  if (id === undefined) {
    if (method === "session/cancel") {
      cancelled.add(String(params.sessionId));
    }
    return;
  }
  try {
    let result: unknown = {};
    if (method === "initialize") {
      if (process.argv.slice(2).includes("--v1-only")) {
        result = { protocolVersion: 1, agentCapabilities: {} };
      } else {
        result = {
          protocolVersion: 2,
          info: { name: "fake-v2", version: "1" },
          capabilities: { session: {} },
          authMethods: [],
        };
      }
    } else if (method === "session/new") {
      currentOptions = [
        {
          configId: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "fake-v2-model",
          options: [{ value: "fake-v2-model", name: "Fake v2 Model" }],
        },
        {
          configId: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "plan",
          options: [
            { value: "plan", name: "Plan" },
            {
              value: "act",
              name: "Act",
            },
          ],
        },
        {
          configId: "boolean-option",
          name: "Boolean",
          type: "boolean",
          currentValue: false,
        },
      ];
      result = {
        sessionId: crypto.randomUUID(),
        configOptions: currentOptions,
      };
    } else if (method === "session/resume") {
      if (
        (params.replayFrom as { type?: unknown } | undefined)?.type !== "start"
      ) {
        throw new Error(
          "session/resume must replay the loaded session from start",
        );
      }
      result = { configOptions: currentOptions };
    } else if (method === "session/set_config_option") {
      const configId = String(params.configId);
      currentOptions = currentOptions.map((option) =>
        option.configId === configId
          ? { ...option, currentValue: params.value }
          : option,
      );
      result = { configOptions: currentOptions };
    } else if (method === "session/prompt") {
      const sessionId = String(params.sessionId);
      const blocks = params.prompt as Array<{ text?: string }>;
      const text = blocks.map((block) => block.text ?? "").join("");
      result = { messageId: crypto.randomUUID() };
      await write({ jsonrpc: "2.0", id, result });
      // ACP v2 acknowledges insertion before foreground work completes.
      void promptWork(sessionId, text);
      return;
    } else if (method === "session/close") {
      result = {};
    } else {
      throw new Error(`Unsupported fixture method: ${method}`);
    }
    await write({ jsonrpc: "2.0", id, result });
    if (
      method === "session/close" &&
      process.argv.slice(2).includes("--exit-nonzero-after-close")
    )
      process.exit(7);
  } catch (error) {
    await write({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: String(error) },
    });
  }
}

for await (const chunk of process.stdin) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      void handle(message);
    } catch {
      // Ignore malformed fixture input; tests will time out on a missing reply.
    }
    newline = buffer.indexOf("\n");
  }
}
