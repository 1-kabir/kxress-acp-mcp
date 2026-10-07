import { SessionManager } from "../src/sessions/manager.ts";

Deno.test({
  name: "OpenCode ACP smoke test (opt in)",
  ignore: Deno.env.get("ACPMCP_OPENCODE_TEST") !== "1",
  fn: async () => {
    const manager = new SessionManager({
      opencode: { command: "opencode", args: ["acp"] },
    });
    try {
      const session = await manager.start("opencode", Deno.cwd());
      const result = await manager.prompt(
        session.id,
        "Reply with the single word: ready",
      );
      if (!result.text.toLowerCase().includes("ready")) {
        throw new Error(`Unexpected OpenCode response: ${result.text}`);
      }
    } finally {
      await manager.closeAll();
    }
  },
});
