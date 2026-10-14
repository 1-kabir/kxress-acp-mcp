import { fileURLToPath } from "node:url";
import { createMcpServer } from "../src/mcp/server.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

function fixtureManager() {
  return new SessionManager({
    raw: {
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        fileURLToPath(
          new URL("./fixtures/raw_wire_acp_agent.ts", import.meta.url),
        ),
      ],
    },
  });
}

function assertEqual(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("event cursor follows each page and preserves unread and newly appended events", async () => {
  const manager = fixtureManager();
  try {
    const session = await manager.start("raw", Deno.cwd());
    assertEqual(manager.getEvents(session.id).nextSequence, 0);
    assertEqual(manager.getEvents(session.id).events, []);
    await manager.prompt(session.id, "first");
    const first = manager.getEvents(session.id, 0, 1);
    assertEqual(first.events.map((event) => event.sequence), [1]);
    assertEqual(first.nextSequence, 1);
    assertEqual(first.prompt?.text, "raw reply");
    await manager.prompt(session.id, "second");
    let cursor = first.nextSequence;
    const seen = [1];
    for (const expected of [[2, 3], [4, 5], [6]]) {
      const page = manager.getEvents(session.id, cursor, 2);
      assertEqual(page.events.map((event) => event.sequence), expected);
      assertEqual(page.nextSequence, expected.at(-1));
      assertEqual(page.gap, false);
      seen.push(...page.events.map((event) => event.sequence));
      cursor = page.nextSequence;
    }
    assertEqual(seen, [1, 2, 3, 4, 5, 6]);
    assertEqual(manager.getEvents(session.id, cursor).events, []);
    assertEqual(manager.getEvents(session.id, cursor).nextSequence, cursor);
    assertEqual(manager.getEvents(session.id, 99).nextSequence, 99);
  } finally {
    await manager.closeAll();
  }
});

Deno.test("event cursor drains retained pages after buffer truncation and reports the gap once", async () => {
  const manager = fixtureManager();
  try {
    const session = await manager.start("raw", Deno.cwd());
    await manager.prompt(session.id, "event burst");
    const first = manager.getEvents(session.id, 0, 1);
    assertEqual(first.events.map((event) => event.sequence), [6]);
    assertEqual(first.gap, true);
    assertEqual(first.nextSequence, 6);
    let cursor = first.nextSequence;
    const sequences = [6];
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      const page = manager.getEvents(session.id, cursor, 500);
      assertEqual(page.gap, false);
      sequences.push(...page.events.map((event) => event.sequence));
      if (!page.events.length) break;
      cursor = page.nextSequence;
    }
    assertEqual(
      sequences,
      Array.from({ length: 1000 }, (_, index) => index + 6),
    );
    assertEqual(cursor, 1005);
    assertEqual(manager.getEvents(session.id, cursor).events, []);
  } finally {
    await manager.closeAll();
  }
});

Deno.test("event cursor advances past dropped oversized events even when the buffer is empty", async () => {
  const manager = fixtureManager();
  try {
    const session = await manager.start("raw", Deno.cwd());
    await manager.prompt(session.id, "oversized event");
    const page = manager.getEvents(session.id);
    assertEqual(page.events, []);
    assertEqual(page.gap, true);
    assertEqual(page.nextSequence, 1);
    assertEqual(manager.getEvents(session.id, page.nextSequence).gap, false);
    await manager.prompt(session.id, "after oversized event");
    assertEqual(
      manager.getEvents(session.id, page.nextSequence, 1).events.map((event) =>
        event.sequence
      ),
      [2],
    );
  } finally {
    await manager.closeAll();
  }
});

Deno.test("MCP event pagination advances through hidden thoughts without losing later events", async () => {
  const manager = fixtureManager();
  const server = createMcpServer({}, manager);
  const mcp = await connectMcp(server);
  try {
    const session = await manager.start("raw", Deno.cwd());
    await manager.prompt(session.id, "delegate isolation");
    let cursor = 0;
    const sequences: number[] = [];
    for (let sequence = 1; sequence <= 8; sequence++) {
      const page = parseToolResult(
        await mcp.callTool("get_events", {
          sessionId: session.id,
          afterSequence: cursor,
          limit: 1,
          includeRaw: true,
        }).response,
      );
      const events = page.events as Array<
        { sequence: number; kind: string; raw: { ordinal: number } }
      >;
      assertEqual(page.nextSequence, sequence);
      assertEqual(
        events.map((event) => event.sequence),
        sequence === 2 ? [] : [sequence],
      );
      if (events.length) assertEqual(events[0].raw.ordinal, sequence);
      assertEqual(
        (page.prompt as { text: string }).text,
        "Delegation complete.",
      );
      sequences.push(...events.map((event) => event.sequence));
      cursor = Number(page.nextSequence);
    }
    assertEqual(sequences, [1, 3, 4, 5, 6, 7, 8]);
    const thoughts = parseToolResult(
      await mcp.callTool("get_events", {
        sessionId: session.id,
        afterSequence: 1,
        limit: 1,
        includeThoughts: true,
      }).response,
    );
    const thoughtEvents = thoughts.events as Array<
      { kind: string; raw?: unknown }
    >;
    assertEqual(thoughtEvents[0].kind, "agent_thought_chunk");
    assertEqual("raw" in thoughtEvents[0], false);
    assertEqual(thoughts.nextSequence, 2);
    const empty = parseToolResult(
      await mcp.callTool("get_events", {
        sessionId: session.id,
        afterSequence: cursor,
        limit: 1,
      }).response,
    );
    assertEqual(empty.events, []);
    assertEqual(empty.nextSequence, cursor);
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
  }
});
