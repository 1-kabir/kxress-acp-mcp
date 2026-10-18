import { Readable, Writable } from "node:stream";
import process from "node:process";
import * as nodeFs from "#fs";
import {
  agent,
  ndJsonStream,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

const app = agent({ name: "fake-acp-agent" });
const cancelled = new Set<string>();
let exitNonzeroAfterClose = false;
let booleanOptionsSupported = false;
let activeConfigOptions: SessionConfigOption[] = [];
app.onRequest("initialize", ({ params }) => {
  const pidFile = process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--pid-file="));
  if (pidFile) {
    nodeFs.writeText(pidFile.slice("--pid-file=".length), String(process.pid));
  }
  if (process.argv.slice(2).includes("--stderr-env-canary")) {
    console.error(process.env["ACP_MCP_TEST_SECRET"] ?? "missing-canary");
  }
  if (process.argv.slice(2).includes("--initialize-exit")) process.exit(12);
  if (process.argv.slice(2).includes("--initialize-hang")) {
    return new Promise(() => {});
  }
  if (process.argv.slice(2).includes("--initialize-fail")) {
    throw new Error("fixture initialize failed");
  }
  const capabilities = (
    params as {
      clientCapabilities?: {
        session?: { configOptions?: { boolean?: unknown } };
      };
    }
  ).clientCapabilities;
  booleanOptionsSupported =
    capabilities?.session?.configOptions?.boolean !== undefined;
  return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
});
app.onRequest("session/new", ({ params, client }) => {
  if (process.argv.slice(2).includes("--session-exit")) process.exit(13);
  if (process.argv.slice(2).includes("--session-hang"))
    return new Promise(() => {});
  const delayArgument = process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--session-delay-ms="));
  if (delayArgument) {
    const delay = Number(delayArgument.split("=")[1]);
    return new Promise((resolve) => {
      setTimeout(
        () => resolve({ sessionId: crypto.randomUUID(), configOptions: [] }),
        delay,
      );
    });
  }
  if (process.argv.slice(2).includes("--session-fail")) {
    throw new Error("fixture session creation failed");
  }
  if (process.argv.slice(2).includes("--async-models")) {
    const sessionId = crypto.randomUUID();
    const initialOptions: SessionConfigOption[] = [
      {
        id: "mode",
        name: "Mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "default", name: "Default" }],
      },
    ];
    const discoveredOptions: SessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "claude-opus-5-5-low",
        options: [
          { value: "claude-opus-5-5-low", name: "Opus low" },
          { value: "claude-opus-5-5-medium", name: "Opus medium" },
          { value: "claude-opus-5-5-high", name: "Opus high" },
        ],
      },
      ...initialOptions,
    ];
    activeConfigOptions = initialOptions;
    setTimeout(() => {
      activeConfigOptions = discoveredOptions;
      void client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: discoveredOptions,
        },
      });
    }, 40);
    return { sessionId, configOptions: initialOptions };
  }
  if (process.argv.slice(2).includes("--async-effort")) {
    const sessionId = crypto.randomUUID();
    const initialOptions: SessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "claude-opus-5-5",
        options: [{ value: "claude-opus-5-5", name: "Opus" }],
      },
    ];
    const discoveredOptions: SessionConfigOption[] = [
      ...initialOptions,
      {
        id: "thought_level",
        name: "Thought level",
        type: "select",
        currentValue: "low",
        options: ["low", "medium", "high"].map((value) => ({
          value,
          name: value,
        })),
      },
    ];
    activeConfigOptions = initialOptions;
    setTimeout(() => {
      activeConfigOptions = discoveredOptions;
      void client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: discoveredOptions,
        },
      });
    }, 40);
    return { sessionId, configOptions: initialOptions };
  }
  const configOptions: SessionConfigOption[] = process.argv
    .slice(2)
    .includes("--advertise-models")
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
  if (process.argv.slice(2).includes("--report-cwd")) {
    configOptions.push({
      id: "cwd-report",
      name: "cwd report",
      type: "select",
      currentValue: JSON.stringify({
        processCwd: process.cwd(),
        sessionCwd: (params as { cwd: string }).cwd,
      }),
      options: [],
    });
  }
  if (process.argv.slice(2).includes("--advertise-bool")) {
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
app.onRequest("session/close", async () => {
  const closeMarker = process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--close-marker="));
  if (closeMarker) {
    await nodeFs.writeText(
      closeMarker.slice("--close-marker=".length),
      "closed",
    );
  }
  if (process.argv.slice(2).includes("--session-close-hang")) {
    await new Promise(() => {});
  }
  if (exitNonzeroAfterClose) {
    setTimeout(() => process.exit(23), 25);
  }
  if (process.argv.slice(2).includes("--exit-on-close")) {
    setTimeout(() => process.exit(0), 25);
  }
  return {};
});
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
        ? ({ ...option, currentValue: value } as SessionConfigOption)
        : option,
    );
  } else {
    activeConfigOptions = activeConfigOptions.map((option) =>
      option.id === configId
        ? ({ ...option, currentValue: value } as SessionConfigOption)
        : option,
    );
  }
  return { configOptions: activeConfigOptions };
});
app.onRequest("session/prompt", async ({ params, client }) => {
  const sessionId = params.sessionId;
  const promptText = params.prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
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
    process.exit(17);
  }
  if (promptText === "complete then exit nonzero on close") {
    exitNonzeroAfterClose = true;
  }
  if (promptText === "direct write without permission") {
    const separator = process.platform === "win32" ? "\\" : "/";
    const path = `${process.cwd()}${separator}DIRECT_WRITE.txt`;
    await nodeFs.writeText(path, "written without ACP permission");
    await client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Wrote DIRECT_WRITE.txt" },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (promptText === "empty response") return { stopReason: "end_turn" };
  if (promptText === "permission then complete") {
    void client.request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "fake-call", kind: "execute" },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject once", kind: "reject_once" },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "completed" },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (promptText === "permission" || promptText === "operator delegate") {
    const permissionMarker = process.argv
      .slice(2)
      .find((arg) => arg.startsWith("--permission-marker="));
    if (permissionMarker) {
      await nodeFs.writeText(
        permissionMarker.slice("--permission-marker=".length),
        "requested",
      );
    }
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
          text:
            answer.outcome.outcome === "selected"
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
  if (promptText === "cancel then fail") {
    while (!cancelled.has(sessionId)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("fixture failed after cancellation");
  }
  if (promptText === "cancel then late update") {
    while (!cancelled.has(sessionId)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "late after cancellation" },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (promptText === "active stream") {
    let index = 0;
    while (!cancelled.has(sessionId)) {
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `stream-${index++}` },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { stopReason: "cancelled" };
  }
  if (promptText === "stderr only") {
    while (!cancelled.has(sessionId)) {
      await process.stderr.write(
        new TextEncoder().encode("stderr heartbeat\n"),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { stopReason: "cancelled" };
  }
  if (promptText === "late response") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "too late" },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (promptText === "active heartbeat" || promptText === "unknown heartbeat") {
    const unknown = promptText === "unknown heartbeat";
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      await client.notify("session/update", {
        sessionId,
        update: unknown
          ? { sessionUpdate: "future_event_variant", marker: `unknown-${i}` }
          : {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: `thought-${i}` },
            },
      } as never);
    }
    await client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "heartbeat completed" },
      },
    });
    return { stopReason: "end_turn" };
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
  void process.stderr.write(new TextEncoder().encode("ACP_CANCEL_RECEIVED\n"));
});
app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
if (process.argv.slice(2).includes("--ignore-eof")) setInterval(() => {}, 1000);
