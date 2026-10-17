import { Readable, Writable } from "node:stream";
import process from "node:process";
import * as nodeFs from "#fs";
import {
  agent,
  ndJsonStream,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

const app = agent({ name: "custom-acp-fixture" });
const sessionId = crypto.randomUUID();
const configOptions: SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "live-small",
    options: [
      { value: "live-small", name: "Small" },
      { value: "live-large", name: "Large" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];

async function writeReport(): Promise<void> {
  const report = process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--report="));
  if (!report) return;
  await nodeFs.writeText(
    report.slice("--report=".length),
    JSON.stringify({
      args: process.argv.slice(2).filter((arg) => !arg.startsWith("--report=")),
      env: process.env["ACPMCP_CUSTOM_TEST_SECRET"],
      currentConfig: configOptions.map((option) => ({
        id: option.id,
        currentValue: option.currentValue,
      })),
    }),
  );
}

app.onRequest("initialize", async () => {
  await writeReport();
  return {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  };
});

app.onRequest("session/new", () => ({ sessionId, configOptions }));
app.onRequest("session/load", () => ({ sessionId, configOptions }));
app.onRequest("session/set_config_option", ({ params }) => {
  const { configId, value } = params as { configId: string; value: string };
  const option = configOptions.find((candidate) => candidate.id === configId);
  if (!option) throw new Error(`Unknown config option: ${configId}`);
  option.currentValue = value;
  return { configOptions };
});
app.onRequest("session/prompt", async ({ params, client }) => {
  const text = (
    params as { prompt: Array<{ type: string; text?: string }> }
  ).prompt
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
  const answer = text.match(/Reply exactly:\s*(.+)$/)?.[1] ?? "CUSTOM_OK";
  await writeReport();
  await client.notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: answer },
    },
  });
  return { stopReason: "end_turn" };
});
app.onRequest("session/close", () => ({}));

app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
