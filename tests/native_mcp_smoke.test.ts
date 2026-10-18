import { test } from "node:test";
import process from "node:process";
import { ProcessCommand } from "#proc";
import * as nodeFs from "#fs";
import { VERSION } from "../src/version.ts";

const executable = process.env["ACPMCP_NATIVE_EXECUTABLE"];

test(
  "native product works outside the checkout and serves MCP tools",
  {
    skip: !executable,
  },
  async () => {
    if (!executable) throw new Error("Native executable path is required");
    const cwd = await nodeFs.makeTempDir({ prefix: "acp-mcp-native-smoke-" });
    try {
      const configPath = `${cwd}${
        process.platform === "win32" ? "\\" : "/"
      }release smoke config.json`;
      await nodeFs.writeText(configPath, JSON.stringify({ agents: {} }));
      const version = await new ProcessCommand(executable, {
        args: ["--version"],
        cwd,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (
        !version.success ||
        new TextDecoder().decode(version.stdout).trim() !== `acp-mcp ${VERSION}`
      ) {
        throw new Error("Native version command failed");
      }
      const help = await new ProcessCommand(executable, {
        args: ["--help"],
        cwd,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (
        !help.success ||
        !new TextDecoder()
          .decode(help.stdout)
          .includes("acp-mcp doctor [--config <path>] [--json]") ||
        help.stderr.length
      )
        throw new Error("Native help output did not match the CLI");

      const unknown = await new ProcessCommand(executable, {
        args: ["unknown-command"],
        cwd,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (
        unknown.code !== 2 ||
        unknown.stdout.length ||
        !new TextDecoder().decode(unknown.stderr).includes("Unknown command")
      )
        throw new Error("Native unknown-command behavior was incorrect");

      const doctor = await new ProcessCommand(executable, {
        args: ["doctor", "--json"],
        cwd,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const doctorReport = JSON.parse(
        new TextDecoder().decode(doctor.stdout),
      ) as { version?: string; status?: string; checks?: unknown[] };
      if (
        (doctor.code !== 0 && doctor.code !== 1) ||
        doctorReport.version !== VERSION ||
        !["healthy", "warnings", "errors"].includes(
          doctorReport.status ?? "",
        ) ||
        !Array.isArray(doctorReport.checks)
      )
        throw new Error("Native offline doctor output was invalid");

      const missingConfig = `${cwd}${
        process.platform === "win32" ? "\\" : "/"
      }missing config.json`;
      const startupFailure = await new ProcessCommand(executable, {
        args: ["--config", missingConfig],
        cwd,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const startupStdout = new TextDecoder().decode(startupFailure.stdout);
      const startupStderr = new TextDecoder().decode(startupFailure.stderr);
      if (
        startupFailure.success ||
        startupStdout !== "" ||
        !startupStderr.includes("Explicit config file does not exist")
      ) {
        throw new Error(
          "Explicit missing config did not fail clearly on stderr only",
        );
      }

      const child = new ProcessCommand(executable, {
        args: ["--config", configPath],
        cwd,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const reader = child.stdout.getReader();
      const writer = child.stdin.getWriter();
      const decoder = new TextDecoder();
      const state = { buffer: "" };
      const write = (value: Record<string, unknown>) =>
        writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
      const read = async () => {
        while (true) {
          const newline = state.buffer.indexOf("\n");
          if (newline >= 0) {
            const line = state.buffer.slice(0, newline);
            state.buffer = state.buffer.slice(newline + 1);
            if (line.trim()) return JSON.parse(line) as Record<string, unknown>;
            continue;
          }
          const { value, done } = await reader.read();
          if (done) throw new Error("Native MCP stdout closed before response");
          state.buffer += decoder.decode(value, { stream: true });
        }
      };
      try {
        await write({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "native-smoke", version: "1" },
          },
        });
        const initialize = await read();
        if (initialize.id !== 1 || !initialize.result) {
          throw new Error("Native MCP initialize failed");
        }
        await write({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
        await write({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        });
        const listing = await read();
        const tools = (listing.result as { tools?: unknown[] } | undefined)
          ?.tools;
        if (listing.id !== 2 || tools?.length !== 16) {
          throw new Error("Native MCP tools/list did not return 16 tools");
        }
        await writer.close();
        const status = await Promise.race([
          child.status,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Native server did not exit")),
              10_000,
            ),
          ),
        ]);
        if (!status.success) {
          throw new Error("Native server exited unsuccessfully");
        }
      } finally {
        try {
          writer.releaseLock();
        } catch {
          /* already closed */
        }
        try {
          reader.releaseLock();
        } catch {
          /* child already exited */
        }
        const exited = await Promise.race([
          child.status.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 50),
          ),
        ]);
        if (!exited) child.kill("SIGKILL");
        await child.status.catch(() => undefined);
      }
    } finally {
      await nodeFs.removePath(cwd, { recursive: true });
    }
  },
);
