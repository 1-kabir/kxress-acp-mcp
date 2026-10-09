import { runCli } from "./cli.ts";

const exitCode = await runCli(Deno.args);
if (exitCode !== 0) Deno.exit(exitCode);
