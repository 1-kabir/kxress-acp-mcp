import {
  client,
  type ClientConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { AgentMap } from "../agents/config.ts";
import { interceptSessionUpdates } from "../acp/session_update_stream.ts";
import { startAgent, stopAgent } from "../runtime/process.ts";

export interface ManagedSession {
  id: string;
  agentId: string;
  cwd: string;
  acpSessionId: string;
  connection: ClientConnection;
  process: Awaited<ReturnType<typeof startAgent>>;
  promptActive: boolean;
  capabilities: unknown;
  authMethods: unknown;
  configOptions: Array<Record<string, unknown>>;
  modes: Record<string, unknown> | undefined;
  prompt?: PromptRecord;
  events: SessionEvent[];
  nextSequence: number;
  droppedThrough: number;
  permissionPolicy: PermissionPolicy;
  pendingPermissions: Map<string, PendingPermission>;
  permissionLease?: ReturnType<typeof setTimeout>;
}

export interface SessionEvent {
  sequence: number;
  timestamp: string;
  kind: string;
  update: unknown;
  raw: unknown;
}

export interface PromptRecord {
  id: string;
  state: "running" | "completed" | "cancelled" | "failed";
  text: string;
  stopReason?: string;
  error?: string;
  done: Promise<void>;
}

export type PermissionPolicy =
  | "read_only"
  | "operator"
  | "allow_all"
  | "deny_all";

function configValue(
  value: string,
  option: Record<string, unknown> | undefined,
): { value: string } | { type: "boolean"; value: boolean } {
  if (option?.type !== "boolean") return { value };
  if (value !== "true" && value !== "false") {
    throw new Error(
      `Boolean config option '${String(option.id)}' must be 'true' or 'false'`,
    );
  }
  return { type: "boolean", value: value === "true" };
}

export interface PendingPermission {
  id: string;
  toolCall: unknown;
  options: Array<{ optionId: string; kind: string; name: string }>;
  resolve: (
    value: {
      outcome: { outcome: "selected"; optionId: string } | {
        outcome: "cancelled";
      };
    },
  ) => void;
}

export class SessionManager {
  readonly sessions = new Map<string, ManagedSession>();
  constructor(private agents: AgentMap) {}

  start(
    agentId: string,
    cwd = Deno.cwd(),
    config: Record<string, string> = {},
    modeId?: string,
    permissionPolicy: PermissionPolicy = "read_only",
  ) {
    return this.launch(agentId, cwd, config, modeId, permissionPolicy);
  }

  load(
    agentId: string,
    acpSessionId: string,
    cwd: string,
    permissionPolicy: PermissionPolicy = "read_only",
  ) {
    return this.launch(
      agentId,
      cwd,
      {},
      undefined,
      permissionPolicy,
      acpSessionId,
    );
  }

  private async launch(
    agentId: string,
    cwd: string,
    config: Record<string, string>,
    modeId: string | undefined,
    permissionPolicy: PermissionPolicy,
    loadSessionId?: string,
  ): Promise<ManagedSession> {
    if (this.sessions.size >= 8) {
      throw new Error("Active session limit (8) reached");
    }
    const def = this.agents[agentId];
    if (!def) throw new Error(`Unknown agent: ${agentId}`);
    const process = await startAgent(def, cwd);
    const app = client({ name: "acp-mcp" });
    app.onRequest(
      "session/request_permission",
      ({ params }) => this.requestPermission(params, permissionPolicy),
    );
    const earlyUpdates: unknown[] = [];
    const stream = interceptSessionUpdates(
      ndJsonStream(process.child.stdin, process.child.stdout),
      (params) => {
        const sessionId = (params as { sessionId: string }).sessionId;
        const managed = [...this.sessions.values()].find((item) =>
          item.acpSessionId === sessionId
        );
        if (!managed) {
          earlyUpdates.push(params);
          return;
        }
        this.receiveUpdate(managed, params);
      },
    );
    const connection = app.connect(stream);
    try {
      const init = await connection.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          session: { configOptions: { boolean: {} } },
        },
      });
      if (init.protocolVersion !== 1) {
        throw new Error(`ACP version mismatch: ${init.protocolVersion}`);
      }
      if (
        loadSessionId &&
        !(init.agentCapabilities as Record<string, unknown> | undefined)
          ?.loadSession
      ) throw new Error("Agent does not advertise session/load support");
      const sessionResponse = loadSessionId
        ? await connection.agent.request("session/load", {
          sessionId: loadSessionId,
          cwd,
          mcpServers: [],
        })
        : await connection.agent.request("session/new", {
          cwd,
          mcpServers: [],
        });
      const acpId: string = loadSessionId ??
        (sessionResponse as { sessionId: string }).sessionId;
      let configOptions = [
        ...((sessionResponse as {
          configOptions?: Array<Record<string, unknown>>;
        }).configOptions ?? []),
      ];
      const modes =
        (sessionResponse as { modes?: Record<string, unknown> }).modes;
      const modelConfigIds = new Set(configOptions.flatMap((option) => {
        const id = typeof option.id === "string" ? option.id : undefined;
        if (
          id &&
          (option.category === "model" ||
            ((option.category === undefined || option.category === null) &&
              id === def.modelConfigId))
        ) return [id];
        return [];
      }));
      const desired = Object.entries(config).sort(([a], [b]) =>
        Number(modelConfigIds.has(b)) - Number(modelConfigIds.has(a))
      );
      for (const [configId, value] of desired) {
        const option = configOptions.find((item) => item.id === configId);
        if (!option && configOptions.length) {
          throw new Error(`Unknown config option: ${configId}`);
        }
        if (option?.type === "select" && Array.isArray(option.options)) {
          const values = (option.options as Array<Record<string, unknown>>)
            .flatMap((entry) =>
              Array.isArray(entry.options)
                ? entry.options as Array<Record<string, unknown>>
                : [entry]
            );
          if (values.length && !values.some((entry) => entry.value === value)) {
            throw new Error(
              `Invalid value '${value}' for config option '${configId}'`,
            );
          }
        }
        const response = await connection.agent.request(
          "session/set_config_option",
          {
            sessionId: acpId,
            configId,
            ...configValue(value, option),
          },
        );
        configOptions =
          (response as { configOptions: Array<Record<string, unknown>> })
            .configOptions;
      }
      if (modeId) {
        const available =
          (modes?.availableModes as Array<{ id: string }> | undefined) ?? [];
        if (!available.some((mode) => mode.id === modeId)) {
          throw new Error(`Unknown mode: ${modeId}`);
        }
        await connection.agent.request("session/set_mode", {
          sessionId: acpId,
          modeId,
        });
      }
      const session: ManagedSession = {
        id: crypto.randomUUID(),
        agentId,
        cwd,
        acpSessionId: acpId,
        connection,
        process,
        promptActive: false,
        capabilities: init.agentCapabilities ?? {},
        authMethods: init.authMethods ?? [],
        configOptions,
        modes,
        events: [],
        nextSequence: 1,
        droppedThrough: 0,
        permissionPolicy,
        pendingPermissions: new Map(),
      };
      this.sessions.set(session.id, session);
      for (const params of earlyUpdates) {
        if ((params as { sessionId: string }).sessionId === acpId) {
          this.receiveUpdate(session, params);
        }
      }
      return session;
    } catch (error) {
      connection.close(error);
      await stopAgent(process.child, 1000);
      throw new Error(
        `Could not start ${agentId}: ${
          error instanceof Error ? error.message : String(error)
        }; ${process.stderrTail()}`,
      );
    }
  }

  beginPrompt(sessionId: string, text: string): PromptRecord {
    const session = this.get(sessionId);
    if (session.promptActive) {
      throw new Error("A prompt is already active for this session");
    }
    session.promptActive = true;
    const record: PromptRecord = {
      id: crypto.randomUUID(),
      state: "running",
      text: "",
      done: Promise.resolve(),
    };
    session.prompt = record;
    record.done = this.consumePrompt(session, record, text);
    return record;
  }

  private async consumePrompt(
    session: ManagedSession,
    record: PromptRecord,
    text: string,
  ): Promise<void> {
    try {
      const response = await session.connection.agent.request(
        "session/prompt",
        { sessionId: session.acpSessionId, prompt: [{ type: "text", text }] },
      );
      record.stopReason = response.stopReason;
      if (record.state === "running") {
        record.state = response.stopReason === "cancelled"
          ? "cancelled"
          : "completed";
      }
    } catch (error) {
      record.state = "failed";
      record.error = error instanceof Error ? error.message : String(error);
    } finally {
      session.promptActive = false;
    }
  }

  async waitPrompt(
    sessionId: string,
    promptId: string,
    waitMs: number,
  ): Promise<PromptRecord> {
    const session = this.get(sessionId);
    const prompt = session.prompt;
    if (!prompt || prompt.id !== promptId) {
      throw new Error(`Unknown prompt: ${promptId}`);
    }
    if (prompt.state === "running") {
      await Promise.race([
        prompt.done,
        new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs))),
      ]);
    }
    return prompt;
  }

  async cancelPrompt(
    sessionId: string,
    promptId: string,
  ): Promise<PromptRecord> {
    const session = this.get(sessionId);
    const prompt = session.prompt;
    if (!prompt || prompt.id !== promptId) {
      throw new Error(`Unknown prompt: ${promptId}`);
    }
    if (prompt.state === "running") {
      prompt.state = "cancelled";
      for (const [id, pending] of session.pendingPermissions) {
        pending.resolve({ outcome: { outcome: "cancelled" } });
        session.pendingPermissions.delete(id);
      }
      await session.connection.agent.notify("session/cancel", {
        sessionId: session.acpSessionId,
      });
      await this.waitPrompt(sessionId, promptId, 5000);
    }
    return prompt;
  }

  getEvents(sessionId: string, afterSequence = 0, limit = 100) {
    const session = this.get(sessionId);
    return {
      events: session.events.filter((event) => event.sequence > afterSequence)
        .slice(0, Math.max(1, Math.min(limit, 500))),
      nextSequence: session.nextSequence - 1,
      gap: afterSequence < session.droppedThrough,
      prompt: session.prompt
        ? {
          id: session.prompt.id,
          state: session.prompt.state,
          text: session.prompt.text,
          stopReason: session.prompt.stopReason,
        }
        : undefined,
    };
  }

  private appendEvent(
    session: ManagedSession,
    kind: string,
    update: unknown,
    raw: unknown,
  ): void {
    const event: SessionEvent = {
      sequence: session.nextSequence++,
      timestamp: new Date().toISOString(),
      kind,
      update,
      raw,
    };
    session.events.push(event);
    while (
      session.events.length > 1000 ||
      JSON.stringify(session.events).length > 4 * 1024 * 1024
    ) {
      const removed = session.events.shift();
      if (removed) session.droppedThrough = removed.sequence;
    }
  }

  private receiveUpdate(
    session: ManagedSession,
    params: unknown,
  ) {
    const raw = params as { update?: unknown };
    const update = raw.update as {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
    };
    const kind = update?.sessionUpdate ?? "unknown";
    this.appendEvent(session, kind, update, params);
    if (
      session.prompt && session.prompt.state === "running" &&
      kind === "agent_message_chunk" && update.content?.type === "text"
    ) {
      session.prompt.text += update.content.text ?? "";
    }
  }

  async prompt(
    sessionId: string,
    text: string,
  ): Promise<{ stopReason?: string; text: string; promptId?: string }> {
    const prompt = this.beginPrompt(sessionId, text);
    await prompt.done;
    if (prompt.state === "failed") {
      throw new Error(prompt.error ?? "Prompt failed");
    }
    return { stopReason: prompt.stopReason, text: prompt.text };
  }

  get(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return session;
  }

  async setConfigOption(sessionId: string, configId: string, value: string) {
    const session = this.get(sessionId);
    const option = session.configOptions.find((item) => item.id === configId);
    if (!option && session.configOptions.length) {
      throw new Error(`Unknown config option: ${configId}`);
    }
    if (option?.type === "select" && Array.isArray(option.options)) {
      const values = (option.options as Array<Record<string, unknown>>).flatMap(
        (entry) =>
          Array.isArray(entry.options)
            ? entry.options as Array<Record<string, unknown>>
            : [entry],
      );
      if (values.length && !values.some((entry) => entry.value === value)) {
        throw new Error(
          `Invalid value '${value}' for config option '${configId}'`,
        );
      }
    }
    const result = await session.connection.agent.request(
      "session/set_config_option",
      {
        sessionId: session.acpSessionId,
        configId,
        ...configValue(value, option),
      },
    );
    session.configOptions = result.configOptions as Array<
      Record<string, unknown>
    >;
    return session.configOptions;
  }

  async setMode(sessionId: string, modeId: string) {
    const session = this.get(sessionId);
    const modes =
      (session.modes?.availableModes as Array<{ id: string }> | undefined) ??
        [];
    if (!modes.length) throw new Error("Agent did not advertise session modes");
    if (!modes.some((mode) => mode.id === modeId)) {
      throw new Error(`Unknown mode: ${modeId}`);
    }
    await session.connection.agent.request("session/set_mode", {
      sessionId: session.acpSessionId,
      modeId,
    });
    session.modes = { ...session.modes, currentModeId: modeId };
    return session.modes;
  }

  private async requestPermission(
    params: {
      sessionId: string;
      toolCall: { kind?: string | null };
      options: Array<{ optionId: string; kind: string; name: string }>;
    },
    policy: PermissionPolicy,
  ) {
    const session = [...this.sessions.values()].find((item) =>
      item.acpSessionId === params.sessionId
    );
    const options = params.options ?? [];
    const choose = (kind: string) =>
      options.find((option) => option.kind === kind);
    if (!session) return { outcome: { outcome: "cancelled" as const } };
    const requestId = crypto.randomUUID();
    const raw = {
      sessionId: params.sessionId,
      toolCall: params.toolCall,
      options,
    };
    this.appendEvent(session, "permission_request", { requestId, ...raw }, raw);
    if (policy === "operator") {
      return await new Promise<
        {
          outcome: { outcome: "selected"; optionId: string } | {
            outcome: "cancelled";
          };
        }
      >((resolve) => {
        session.pendingPermissions.set(requestId, {
          id: requestId,
          toolCall: params.toolCall,
          options,
          resolve,
        });
      });
    }
    const kind = params.toolCall.kind;
    const permit = policy === "allow_all" ||
      (policy === "read_only" &&
        ["read", "search", "fetch", "think"].includes(kind ?? ""));
    const option = permit
      ? choose("allow_once") ?? choose("allow_always")
      : choose("reject_once") ?? choose("reject_always");
    return {
      outcome: option
        ? { outcome: "selected" as const, optionId: option.optionId }
        : { outcome: "cancelled" as const },
    };
  }

  resolvePermission(sessionId: string, permissionId: string, optionId: string) {
    const session = this.get(sessionId);
    const pending = session.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new Error(`Unknown permission request: ${permissionId}`);
    }
    if (!pending.options.some((option) => option.optionId === optionId)) {
      throw new Error(`Invalid permission option: ${optionId}`);
    }
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    session.pendingPermissions.delete(permissionId);
    if (session.permissionLease) clearTimeout(session.permissionLease);
    session.permissionLease = undefined;
    return { permissionId, optionId, resolved: true };
  }

  async close(id: string): Promise<void> {
    const session = this.get(id);
    if (session.permissionLease) clearTimeout(session.permissionLease);
    session.permissionLease = undefined;
    for (const pending of session.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    session.pendingPermissions.clear();
    this.sessions.delete(id);
    try {
      await session.connection.agent.request("session/close", {
        sessionId: session.acpSessionId,
      });
    } catch { /* Process shutdown remains authoritative. */ }
    session.connection.close();
    await stopAgent(session.process.child, 5000);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.close(id)),
    );
  }
}
