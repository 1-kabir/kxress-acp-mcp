import { SessionManager } from "../src/sessions/manager.ts";

function rawFixtureManager() {
  return new SessionManager({
    raw: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "tests/fixtures/raw_wire_acp_agent.ts",
      ],
    },
  });
}

Deno.test("journals unknown raw updates in order and keeps the connection usable", async () => {
  const manager = rawFixtureManager();
  try {
    const session = await manager.start("raw", Deno.cwd());
    const response = await manager.prompt(session.id, "raw wire");
    if (response.text !== "raw reply") {
      throw new Error(`Unexpected text: ${response.text}`);
    }
    const events = manager.getEvents(session.id).events;
    if (events.length !== 3) {
      throw new Error(`Expected three routed updates, got ${events.length}`);
    }
    if (
      events.map((event) => event.kind).join(",") !==
        "agent_message_chunk,future_update,agent_message_chunk"
    ) {
      throw new Error("Raw updates were not journaled in arrival order");
    }
    if (
      (events[1].update as { detail?: { retained?: boolean } }).detail
        ?.retained !== true
    ) {
      throw new Error("Unknown update details were not retained");
    }
    const raw = events[1].raw;
    if (
      JSON.stringify(raw) !== JSON.stringify({
        sessionId: session.acpSessionId,
        update: {
          sessionUpdate: "future_update",
          detail: { retained: true },
        },
        _meta: { fixture: "raw-wire", ordinal: 2 },
        ordinal: 2,
      })
    ) {
      throw new Error(
        "Original raw params, unknown detail, or metadata changed",
      );
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("routes raw updates to each managed session", async () => {
  const manager = rawFixtureManager();
  try {
    const [first, second] = await Promise.all([
      manager.start("raw", Deno.cwd()),
      manager.start("raw", Deno.cwd()),
    ]);
    await Promise.all([
      manager.prompt(first.id, "first"),
      manager.prompt(second.id, "second"),
    ]);
    for (const session of [first, second]) {
      const events = manager.getEvents(session.id).events;
      if (
        events.length !== 3 ||
        events.some((event) =>
          (event.raw as { sessionId: string }).sessionId !==
            session.acpSessionId
        )
      ) {
        throw new Error(
          `Updates were misrouted for session ${session.acpSessionId}`,
        );
      }
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("starts a fake ACP agent and returns streamed prompt text", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "tests/fixtures/fake_acp_agent.ts",
      ],
    },
  });
  try {
    const session = await manager.start("fake", Deno.cwd());
    const response = await manager.prompt(session.id, "hello");
    if (response.text !== "fake reply") {
      throw new Error(`Unexpected text: ${response.text}`);
    }
    if (response.stopReason !== "end_turn") {
      throw new Error(`Unexpected stop reason: ${response.stopReason}`);
    }
    const journal = manager.getEvents(session.id);
    if (
      journal.events.length !== 1 ||
      journal.events[0].kind !== "agent_message_chunk"
    ) throw new Error("Expected one normalized text event");
    if (!journal.events[0].raw) {
      throw new Error("Expected original ACP notification to be retained");
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("polls and cancels an asynchronous prompt", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "tests/fixtures/fake_acp_agent.ts",
      ],
    },
  });
  try {
    const session = await manager.start("fake", Deno.cwd());
    const prompt = manager.beginPrompt(session.id, "wait");
    const pending = await manager.waitPrompt(session.id, prompt.id, 0);
    if (pending.state !== "running") {
      throw new Error(`Expected running prompt, got ${pending.state}`);
    }
    const cancelled = await manager.cancelPrompt(session.id, prompt.id);
    if (cancelled.state !== "cancelled") {
      throw new Error(`Expected cancelled prompt, got ${cancelled.state}`);
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("holds operator permission until an advertised choice is resolved", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "tests/fixtures/fake_acp_agent.ts",
      ],
    },
  });
  try {
    const session = await manager.start(
      "fake",
      Deno.cwd(),
      {},
      undefined,
      "operator",
    );
    const prompt = manager.beginPrompt(session.id, "permission");
    for (let i = 0; i < 100 && session.pendingPermissions.size === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending = [...session.pendingPermissions.values()][0];
    if (!pending) throw new Error("Permission request was not exposed");
    manager.resolvePermission(session.id, pending.id, "reject");
    await prompt.done;
    if (prompt.text !== "reject") {
      throw new Error(`Unexpected permission response text: ${prompt.text}`);
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("loads a session when the fake agent advertises support", async () => {
  const manager = new SessionManager({
    fake: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "tests/fixtures/fake_acp_agent.ts",
      ],
    },
  });
  try {
    const session = await manager.load("fake", "existing-session", Deno.cwd());
    if (session.acpSessionId !== "existing-session") {
      throw new Error("Loaded session ID was not retained");
    }
    const result = await manager.prompt(session.id, "hello");
    if (result.text !== "fake reply") {
      throw new Error(`Unexpected loaded session response: ${result.text}`);
    }
  } finally {
    await manager.closeAll();
  }
});

Deno.test("advertises and uses ACP boolean configuration options", async () => {
  const manager = new SessionManager({
    bool: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "tests/fixtures/fake_acp_agent.ts",
        "--advertise-bool",
      ],
    },
  });
  try {
    const session = await manager.start("bool", Deno.cwd(), {
      "use-fast-mode": "true",
    });
    const fastMode = session.configOptions.find((option) =>
      option.id === "use-fast-mode"
    );
    if (fastMode?.currentValue !== true) {
      throw new Error("String config value was not sent as an ACP boolean");
    }
    const updated = await manager.setConfigOption(
      session.id,
      "use-fast-mode",
      "false",
    );
    if (
      updated.find((option) => option.id === "use-fast-mode")?.currentValue !==
        false
    ) {
      throw new Error("Interactive boolean config update did not reach ACP");
    }
  } finally {
    await manager.closeAll();
  }
});
