import { HELP_TEXT, runCli } from "../src/cli.ts";
import { VERSION } from "../src/version.ts";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const serverConfigs: Array<string | undefined> = [];
  return {
    stdout,
    stderr,
    serverConfigs,
    runtime: {
      startServer: (configPath?: string) => {
        serverConfigs.push(configPath);
        return Promise.resolve();
      },
      writeStdout: (text: string) => stdout.push(text),
      writeStderr: (text: string) => stderr.push(text),
    },
  };
}

Deno.test("default CLI invocation starts the MCP stdio server", async () => {
  const output = capture();
  const code = await runCli([], output.runtime);
  if (
    code !== 0 || output.serverConfigs.length !== 1 ||
    output.serverConfigs[0] !== undefined || output.stdout.length ||
    output.stderr.length
  ) {
    throw new Error("Default invocation did not start the server quietly");
  }
});

Deno.test("--config passes the exact path to server startup", async () => {
  const output = capture();
  const configPath = "C:\\Users\\Test User\\acp-mcp\\config.json";
  const code = await runCli(["--config", configPath], output.runtime);
  if (
    code !== 0 || output.serverConfigs.length !== 1 ||
    output.serverConfigs[0] !== configPath || output.stdout.length ||
    output.stderr.length
  ) {
    throw new Error("--config did not pass its exact path to the server");
  }
});

Deno.test("help and version do not start the MCP server", async () => {
  const helpOutput = capture();
  const helpCode = await runCli(["--help"], helpOutput.runtime);
  if (
    helpCode !== 0 || helpOutput.serverConfigs.length ||
    helpOutput.stdout[0] !== HELP_TEXT || helpOutput.stderr.length
  ) throw new Error("--help did not return help without starting MCP");

  const versionOutput = capture();
  const versionCode = await runCli(["--version"], versionOutput.runtime);
  if (
    versionCode !== 0 || versionOutput.serverConfigs.length ||
    versionOutput.stdout[0] !== `acp-mcp ${VERSION}` ||
    versionOutput.stderr.length
  ) throw new Error("--version did not return the canonical version only");
});

Deno.test("unknown commands/options and malformed config fail without serving", async () => {
  const cases = [
    { args: ["doctor"], expected: "Unknown command: doctor" },
    { args: ["--unknown"], expected: "Unknown option: --unknown" },
    { args: ["--config"], expected: "--config requires exactly one" },
    { args: ["--config", ""], expected: "--config requires exactly one" },
    {
      args: ["--config", "config.json", "extra"],
      expected: "--config requires exactly one",
    },
  ];
  for (const { args, expected } of cases) {
    const output = capture();
    const code = await runCli(args, output.runtime);
    if (
      code !== 2 || output.serverConfigs.length || output.stdout.length ||
      !output.stderr[0]?.includes(expected)
    ) {
      throw new Error(
        `${args.join(" ")} did not fail clearly without serving`,
      );
    }
  }
});

Deno.test("server startup failure is reported on stderr and returns nonzero", async () => {
  const output = capture();
  const code = await runCli([], {
    ...output.runtime,
    startServer: () => {
      return Promise.reject(new Error("invalid config"));
    },
  });
  if (
    code !== 1 || output.stdout.length ||
    output.stderr[0] !== "acp-mcp: invalid config"
  ) throw new Error("Startup errors were swallowed or written to stdout");
});
