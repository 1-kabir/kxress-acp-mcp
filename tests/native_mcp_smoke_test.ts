const executable = Deno.env.get("ACPMCP_NATIVE_EXECUTABLE");

Deno.test({
  name: "native product works outside the checkout and serves MCP tools",
  ignore: !executable,
  fn: async () => {
    if (!executable) throw new Error("Native executable path is required");
    const cwd = await Deno.makeTempDir({ prefix: "acp-mcp-native-smoke-" });
    try {
      const version = await new Deno.Command(executable, {
        args: ["--version"],
        cwd,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (
        !version.success ||
        !new TextDecoder().decode(version.stdout).includes("acp-mcp 0.2.0")
      ) {
        throw new Error("Native version command failed");
      }
      const doctor = await new Deno.Command(executable, {
        args: ["doctor", "--json"],
        cwd,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!doctor.success) throw new Error("Native offline doctor failed");
      JSON.parse(new TextDecoder().decode(doctor.stdout));

      const child = new Deno.Command(executable, {
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
            )
          ),
        ]);
        if (!status.success) {
          throw new Error("Native server exited unsuccessfully");
        }
      } finally {
        try {
          writer.releaseLock();
        } catch { /* already closed */ }
        try {
          reader.releaseLock();
        } catch { /* child already exited */ }
        const exited = await Promise.race([
          child.status.then(() => true, () => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 50)
          ),
        ]);
        if (!exited) child.kill("SIGKILL");
        await child.status.catch(() => undefined);
      }
    } finally {
      await Deno.remove(cwd, { recursive: true });
    }
  },
});
