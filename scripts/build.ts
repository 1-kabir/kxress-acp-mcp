import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = join(projectRoot, "dist");
const executableName = `acp-mcp${Deno.build.os === "windows" ? ".exe" : ""}`;
const outputPath = join(outputDirectory, executableName);

await Deno.mkdir(outputDirectory, { recursive: true });
const command = new Deno.Command(Deno.execPath(), {
  args: [
    "compile",
    "--app-name",
    "acp-mcp",
    "--allow-env",
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--allow-net=opencode.ai",
    "--output",
    outputPath,
    new URL("../src/main.ts", import.meta.url).href,
  ],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const status = await command.spawn().status;
if (!status.success) Deno.exit(status.code || 1);
