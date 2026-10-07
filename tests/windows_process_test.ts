import {
  quoteCmdStaticArgument,
  startAgent,
  stopAgent,
} from "../src/runtime/process.ts";

Deno.test({
  name: "configured batch wrapper preserves quoted static arguments",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const script = `${dir}\\fixture.cmd`;
    try {
      await Deno.writeTextFile(
        script,
        '@echo off\r\nif "%~1"=="space value" if "%~2"=="amp&ersand|paren()" exit /b 0\r\nexit /b 91\r\n',
      );
      const process = await startAgent({
        command: script,
        args: ["space value", "amp&ersand|paren()"],
      }, dir);
      const status = await process.child.status;
      await process.stderrDone;
      if (!status.success) {
        throw new Error(
          `Batch wrapper exited with ${status.code}: ${process.stderrTail()}`,
        );
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("quotes cmd arguments and keeps shell metacharacters inside the quotes", () => {
  if (quoteCmdStaticArgument("a&b|c") !== '"a&b|c"') {
    throw new Error("Unexpected cmd argument quoting");
  }
});
