import { test } from "node:test";
import process from "node:process";
import { ProcessCommand } from "#proc";
import * as nodeFs from "#fs";
function absolutePath(url: URL): string {
  const path = url.pathname;
  return process.platform === "win32"
    ? decodeURIComponent(path.replace(/^\//, ""))
    : path;
}

async function writeMessage(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  message: Record<string, unknown>,
) {
  await writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
}

async function readMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  while (true) {
    const newline = state.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (line.trim()) return JSON.parse(line);
      continue;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("MCP server closed stdout before responding");
    state.buffer += decoder.decode(value, { stream: true });
  }
}

async function waitForFile(path: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await nodeFs.stat(path)).isFile()) return;
    } catch {
      /* wait for the controlled fixture marker */
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fixture marker: ${path}`);
}

async function processExists(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    const result = await new ProcessCommand("powershell.exe", {
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 }; exit 1`,
      ],
      stdout: "null",
      stderr: "null",
    }).output();
    return result.success;
  }
  try {
    process.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

async function killFixture(pid: number) {
  if (process.platform === "win32") {
    await new ProcessCommand("taskkill.exe", {
      args: ["/PID", String(pid), "/T", "/F"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
}

test("stdio EOF gracefully closes active sessions and pending permissions", async () => {
  const dir = await nodeFs.makeTempDir({ prefix: "acp-mcp-stdio-close-" });
  const configPath = `${dir}${
    process.platform === "win32" ? "\\" : "/"
  }config.json`;
  const closeMarker = `${dir}${
    process.platform === "win32" ? "\\" : "/"
  }closed.txt`;
  const permissionMarker = `${dir}${
    process.platform === "win32" ? "\\" : "/"
  }permission.txt`;
  const pidFile = `${dir}${process.platform === "win32" ? "\\" : "/"}agent.pid`;
  const fixture = absolutePath(
    new URL("./fixtures/fake_acp_agent.ts", import.meta.url),
  );
  const main = absolutePath(new URL("../src/main.ts", import.meta.url));
  await nodeFs.writeText(
    configPath,
    JSON.stringify({
      agents: {
        fake: {
          command: process.execPath,
          args: [
            fixture,
            "--exit-on-close",
            `--pid-file=${pidFile}`,
            `--close-marker=${closeMarker}`,
            `--permission-marker=${permissionMarker}`,
          ],
        },
      },
    }),
  );
  const child = new ProcessCommand(process.execPath, {
    args: [main, "--config", configPath],
    cwd: process.cwd(),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const reader = child.stdout.getReader();
  const writer = child.stdin.getWriter();
  const state = { buffer: "" };
  let nextId = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId;
    await writeMessage(writer, { jsonrpc: "2.0", id, method, params });
    while (true) {
      const response = await readMessage(reader, state);
      if (response.id === id) return response;
    }
  };
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "server-lifecycle-test", version: "1" },
    });
    if (!init.result) throw new Error("MCP initialize failed");
    await writeMessage(writer, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const started = await request("tools/call", {
      name: "start_session",
      arguments: {
        agentId: "fake",
        cwd: dir,
        permissionPolicy: "operator",
      },
    });
    const sessionText = (
      started.result as {
        content: Array<{ text: string }>;
      }
    ).content[0].text;
    const session = JSON.parse(sessionText) as { sessionId: string };
    const prompting = await request("tools/call", {
      name: "prompt",
      arguments: {
        sessionId: session.sessionId,
        text: "operator delegate",
        wait: false,
      },
    });
    if (!prompting.result) throw new Error("Prompt did not start");
    await waitForFile(permissionMarker);
    await writer.close();
    await waitForFile(closeMarker);
    const agentPid = Number(await nodeFs.readText(pidFile));
    let agentExitedBeforeDeadline = false;
    for (let i = 0; i < 55; i++) {
      if (!(await processExists(agentPid))) {
        agentExitedBeforeDeadline = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const status = await Promise.race([
      child.status,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("stdio server did not exit")), 8_000),
      ),
    ]);
    if (!status.success) {
      throw new Error(`stdio server exited with ${status.code}`);
    }
    console.log(
      `ACP child exited before the graceful-stop deadline: ${agentExitedBeforeDeadline}`,
    );
  } finally {
    try {
      writer.releaseLock();
    } catch {
      /* already closed */
    }
    try {
      reader.releaseLock();
    } catch {
      /* process already exited */
    }
    const exited = await Promise.race([
      child.status.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    if (!exited) child.kill("SIGKILL");
    await child.status.catch(() => undefined);
    try {
      const pid = Number(await nodeFs.readText(pidFile));
      if (Number.isInteger(pid) && pid > 0) {
        await killFixture(pid);
      }
    } catch {
      /* Fixture did not reach initialize or already exited. */
    }
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("hard server termination does not promise to kill ACP child processes", async () => {
  const dir = await nodeFs.makeTempDir({ prefix: "acp-mcp-hard-kill-" });
  const join = (name: string) =>
    `${dir}${process.platform === "win32" ? "\\" : "/"}${name}`;
  const configPath = join("config.json");
  const pidFile = join("agent.pid");
  const fixture = absolutePath(
    new URL("./fixtures/fake_acp_agent.ts", import.meta.url),
  );
  const main = absolutePath(new URL("../src/main.ts", import.meta.url));
  await nodeFs.writeText(
    configPath,
    JSON.stringify({
      agents: {
        fake: {
          command: process.execPath,
          args: [fixture, "--ignore-eof", `--pid-file=${pidFile}`],
        },
      },
    }),
  );
  const child = new ProcessCommand(process.execPath, {
    args: [main, "--config", configPath],
    cwd: process.cwd(),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const reader = child.stdout.getReader();
  const writer = child.stdin.getWriter();
  const state = { buffer: "" };
  let agentPid: number | undefined;
  try {
    await writeMessage(writer, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "hard-kill-test", version: "1" },
      },
    });
    if (!(await readMessage(reader, state)).result) {
      throw new Error("MCP initialize failed");
    }
    await writeMessage(writer, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    await writeMessage(writer, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "start_session",
        arguments: { agentId: "fake", cwd: dir },
      },
    });
    if (!(await readMessage(reader, state)).result) {
      throw new Error("ACP test session did not start");
    }
    await waitForFile(pidFile);
    agentPid = Number(await nodeFs.readText(pidFile));
    child.kill("SIGKILL");
    await child.status;
    const survived = await processExists(agentPid);
    console.log(`ACP child survived hard server kill: ${survived}`);
    if (survived) await killFixture(agentPid);
  } finally {
    try {
      writer.releaseLock();
    } catch {
      /* child was terminated */
    }
    try {
      reader.releaseLock();
    } catch {
      /* child was terminated */
    }
    const exited = await Promise.race([
      child.status.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    if (!exited) child.kill("SIGKILL");
    await child.status.catch(() => undefined);
    if (agentPid && (await processExists(agentPid)))
      await killFixture(agentPid);
    await nodeFs.removePath(dir, { recursive: true });
  }
});
