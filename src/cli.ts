import { startMcpServer } from "./server.ts";
import { VERSION } from "./version.ts";
import {
  diagnose,
  type DoctorReport,
  formatDoctorReport,
} from "./diagnostics/doctor.ts";

export const HELP_TEXT = `Usage:
  acp-mcp [--config <path>]
  acp-mcp doctor [--config <path>] [--json]
  acp-mcp --help
  acp-mcp --version

Commands:
  doctor           Check local configuration and agent executables (offline)

Options:
  --config <path>  Use an explicit acp-mcp config file (server or doctor)
  --json           Write doctor output as JSON
  --help           Show this help
  --version        Show the product version`;

export type CliCommand =
  | { kind: "serve"; configPath?: string }
  | { kind: "doctor"; configPath?: string; json: boolean }
  | { kind: "help"; doctor?: boolean }
  | { kind: "version" };

export const DOCTOR_HELP_TEXT = `Usage:
  acp-mcp doctor [--config <path>] [--json]
  acp-mcp doctor --help

Checks local acp-mcp configuration, agent commands, and disposable workspace state.
Does not start ACP agents, contact providers, or verify provider authentication.`;

function parseDoctorArgs(args: string[]): CliCommand {
  if (args.length === 1 && args[0] === "--help") {
    return { kind: "help", doctor: true };
  }
  let configPath: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" && !json) {
      json = true;
    } else if (arg === "--config" && configPath === undefined) {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("doctor --config requires a non-empty path");
      }
      configPath = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown doctor option: ${arg}`);
    } else {
      throw new Error(`Unexpected doctor argument: ${arg}`);
    }
  }
  return { kind: "doctor", configPath, json };
}

export function parseCliArgs(args: string[]): CliCommand {
  if (args.length === 0) return { kind: "serve" };
  if (args.length === 1 && args[0] === "--help") return { kind: "help" };
  if (args.length === 1 && args[0] === "--version") {
    return { kind: "version" };
  }
  if (args[0] === "doctor") return parseDoctorArgs(args.slice(1));
  if (args[0] === "--config") {
    if (args.length !== 2 || !args[1]) {
      throw new Error("--config requires exactly one non-empty path");
    }
    return { kind: "serve", configPath: args[1] };
  }
  if (args[0].startsWith("-")) {
    throw new Error(`Unknown option: ${args[0]}`);
  }
  throw new Error(`Unknown command: ${args[0]}`);
}

export interface CliRuntime {
  startServer: (configPath?: string) => Promise<void>;
  runDoctor: (options: { configPath?: string }) => Promise<DoctorReport>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

const runtimeDefaults: CliRuntime = {
  startServer: startMcpServer,
  runDoctor: diagnose,
  writeStdout: (text) => console.log(text),
  writeStderr: (text) => console.error(text),
};

export async function runCli(
  args: string[],
  runtime: Partial<CliRuntime> = {},
): Promise<number> {
  const { startServer, runDoctor, writeStdout, writeStderr } = {
    ...runtimeDefaults,
    ...runtime,
  };
  let command: CliCommand;
  try {
    command = parseCliArgs(args);
  } catch (error) {
    writeStderr(
      `acp-mcp: ${
        error instanceof Error ? error.message : String(error)
      }\n${HELP_TEXT}`,
    );
    return 2;
  }

  if (command.kind === "help") {
    writeStdout(command.doctor ? DOCTOR_HELP_TEXT : HELP_TEXT);
    return 0;
  }
  if (command.kind === "version") {
    writeStdout(`acp-mcp ${VERSION}`);
    return 0;
  }

  if (command.kind === "doctor") {
    try {
      const report = await runDoctor({ configPath: command.configPath });
      writeStdout(
        command.json
          ? JSON.stringify(report, null, 2)
          : formatDoctorReport(report),
      );
      return report.status === "errors" ? 1 : 0;
    } catch (error) {
      writeStderr(
        `acp-mcp doctor: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 1;
    }
  }

  try {
    await startServer(command.configPath);
    return 0;
  } catch (error) {
    writeStderr(
      `acp-mcp: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
