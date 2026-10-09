import { startMcpServer } from "./server.ts";
import { VERSION } from "./version.ts";

export const HELP_TEXT = `Usage:
  acp-mcp [--config <path>]
  acp-mcp --help
  acp-mcp --version

Options:
  --config <path>  Use an explicit acp-mcp config file
  --help           Show this help
  --version        Show the product version`;

export type CliCommand =
  | { kind: "serve"; configPath?: string }
  | { kind: "help" }
  | { kind: "version" };

export function parseCliArgs(args: string[]): CliCommand {
  if (args.length === 0) return { kind: "serve" };
  if (args.length === 1 && args[0] === "--help") return { kind: "help" };
  if (args.length === 1 && args[0] === "--version") {
    return { kind: "version" };
  }
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
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

const runtimeDefaults: CliRuntime = {
  startServer: startMcpServer,
  writeStdout: (text) => console.log(text),
  writeStderr: (text) => console.error(text),
};

export async function runCli(
  args: string[],
  runtime: Partial<CliRuntime> = {},
): Promise<number> {
  const { startServer, writeStdout, writeStderr } = {
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
    writeStdout(HELP_TEXT);
    return 0;
  }
  if (command.kind === "version") {
    writeStdout(`acp-mcp ${VERSION}`);
    return 0;
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
