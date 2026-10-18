import { test } from "node:test";
import process from "node:process";
import * as nodeFs from "#fs";
import {
  findExecutablePath,
  quoteCmdStaticArgument,
  startAgent,
  stopAgent,
} from "../src/runtime/process.ts";

test("stopAgent forcefully bounds cleanup when a child ignores stdin EOF", async () => {
  const fixture = new URL("./fixtures/ignore_shutdown.ts", import.meta.url)
    .pathname;
  const path =
    process.platform === "win32"
      ? decodeURIComponent(fixture.replace(/^\//, ""))
      : fixture;
  const child = await startAgent(
    {
      command: process.execPath,
      args: [path],
    },
    process.cwd(),
  );
  const started = performance.now();
  try {
    await stopAgent(child.child, 50);
    const status = await child.child.status;
    if (status.success || performance.now() - started > 3_000) {
      throw new Error("An uncooperative child was not forcefully stopped");
    }
  } finally {
    await child.stderrDone;
  }
});

test(
  "configured batch wrapper preserves quoted static arguments",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const root = await nodeFs.makeTempDir();
    const dir = `${root}\\ACP Test With Spaces`;
    await nodeFs.mkdir(dir);
    const script = `${dir}\\fixture.BAT`;
    try {
      await nodeFs.writeText(
        script,
        '@echo off\r\nif "%~1"=="space value" if "%~2"=="amp&ersand|paren()" exit /b 0\r\nexit /b 91\r\n',
      );
      const process = await startAgent(
        {
          command: script,
          args: ["space value", "amp&ersand|paren()"],
        },
        dir,
      );
      const status = await process.child.status;
      await process.stderrDone;
      if (!status.success) {
        throw new Error(
          `Batch wrapper exited with ${status.code}: ${process.stderrTail()}`,
        );
      }
    } finally {
      await nodeFs.removePath(root, { recursive: true });
    }
  },
);

test(
  "Windows executable resolver handles absolute paths with spaces",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const root = await nodeFs.makeTempDir();
    const dir = `${root}\\ACP Test With Spaces`;
    await nodeFs.mkdir(dir);
    const executable = `${dir}\\fixture.ExE`;
    try {
      await nodeFs.writeText(executable, "fixture");
      const resolved = await findExecutablePath(executable);
      if (resolved?.toLowerCase() !== executable.toLowerCase()) {
        throw new Error(
          `Absolute mixed-case executable was not resolved: ${resolved}`,
        );
      }
    } finally {
      await nodeFs.removePath(root, { recursive: true });
    }
  },
);

test("quotes cmd arguments and keeps shell metacharacters inside the quotes", () => {
  if (quoteCmdStaticArgument("a&b|c") !== '"a&b|c"') {
    throw new Error("Unexpected cmd argument quoting");
  }
});
