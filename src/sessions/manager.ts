import type { AgentMap } from "../agents/config.ts";
import { createProtocolDriver } from "../acp/driver_factory.ts";
import type {
  AcpPermissionRequest,
  AcpProtocol,
  NormalizedAcpUpdate,
  ProtocolDriver,
} from "../acp/protocol.ts";
import { startAgent, stopAgent } from "../runtime/process.ts";

export interface ManagedSession {
  id: string;
  agentId: string;
  cwd: string;
  acpSessionId: string;
  acpProtocol: AcpProtocol;
  driver: ProtocolDriver;
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
  messageText: Map<string, string>;
  messageOrder: string[];
  lastActivityAt: number;
  activityVersion: number;
  activityWaiters: Set<() => void>;
  stopReason?: string;
  error?: string;
  errorCode?: number;
  errorData?: unknown;
  done: Promise<void>;
}

export type PermissionPolicy =
  | "read_only"
  | "operator"
  | "allow_all"
  | "deny_all";

type ConfigOptionWaiter = {
  predicate: (options: Array<Record<string, unknown>>) => boolean;
  finish: (options: Array<Record<string, unknown>>) => void;
};

function configOptionsFromUpdate(
  event: NormalizedAcpUpdate,
): Array<Record<string, unknown>> | undefined {
  if (event.kind !== "config_option_update") return undefined;
  if (!event.update || typeof event.update !== "object") return undefined;
  const options = (event.update as { configOptions?: unknown }).configOptions;
  if (
    !Array.isArray(options) ||
    !options.every((option) => option !== null && typeof option === "object")
  ) return undefined;
  return options as Array<Record<string, unknown>>;
}

export const DEFAULT_SESSION_START_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_CLOSE_TIMEOUT_MS = 5_000;
export const DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS = 5_000;

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
  private readonly configOptionWaiters = new Map<
    string,
    Set<ConfigOptionWaiter>
  >();
  constructor(
    private agents: AgentMap,
    private readonly startupTimeoutMs = DEFAULT_SESSION_START_TIMEOUT_MS,
    private readonly closeRequestTimeoutMs = DEFAULT_SESSION_CLOSE_TIMEOUT_MS,
  ) {}

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
    const protocol = def.acpProtocol ?? "v1";
    if (def.supportedProtocols && !def.supportedProtocols.includes(protocol)) {
      throw new Error(
        `Agent profile '${agentId}' does not confirm ACP ${protocol} support`,
      );
    }
    const launchDefinition = {
      ...def,
      env: { ...def.protocolEnv?.[protocol], ...def.env },
    };
    const process = await startAgent(launchDefinition, cwd);
    const earlyUpdates: NormalizedAcpUpdate[] = [];
    let wakeStartupUpdate: (() => void) | undefined;
    const driver = createProtocolDriver(protocol, def, process, {
      update: (update) => {
        const managed = [...this.sessions.values()].find((item) =>
          item.acpSessionId === update.sessionId
        );
        if (!managed) {
          earlyUpdates.push(update);
          wakeStartupUpdate?.();
        } else this.receiveUpdate(managed, update);
      },
      permission: (request) =>
        this.requestPermission(request, permissionPolicy),
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const startup = async () => {
        const initialized = await driver.initialize();
        const sessionResponse = loadSessionId
          ? await driver.resumeSession(loadSessionId, cwd)
          : await driver.newSession(cwd);
        const acpId = sessionResponse.sessionId;
        let configOptions = [...sessionResponse.configOptions];
        let configOptionsEarlyUpdateCursor = 0;
        let appliedEarlyUpdates = 0;
        const applyEarlyConfigUpdates = () => {
          for (
            ;
            appliedEarlyUpdates < earlyUpdates.length;
            appliedEarlyUpdates++
          ) {
            const update = earlyUpdates[appliedEarlyUpdates];
            const options = configOptionsFromUpdate(update);
            if (options) configOptions = options;
          }
        };
        let modes = sessionResponse.modes;
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
          applyEarlyConfigUpdates();
          let option = configOptions.find((item) => item.id === configId);
          while (!option && configOptions.length) {
            const received = await new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => {
                if (wakeStartupUpdate === wake) wakeStartupUpdate = undefined;
                resolve(false);
              }, DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS);
              const wake = () => {
                clearTimeout(timer);
                if (wakeStartupUpdate === wake) wakeStartupUpdate = undefined;
                resolve(true);
              };
              wakeStartupUpdate = wake;
            });
            if (!received) break;
            applyEarlyConfigUpdates();
            option = configOptions.find((item) => item.id === configId);
          }
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
            if (
              values.length && !values.some((entry) => entry.value === value)
            ) {
              throw new Error(
                `Invalid value '${value}' for config option '${configId}'`,
              );
            }
          }
          configOptions = await driver.setConfigOption(
            acpId,
            configId,
            value,
            option,
          );
          configOptionsEarlyUpdateCursor = earlyUpdates.length;
        }
        if (modeId) {
          modes = await driver.setMode(acpId, modeId, configOptions, modes) ??
            modes;
        }
        return {
          initialized,
          sessionResponse,
          configOptions,
          modes,
          configOptionsEarlyUpdateCursor,
        };
      };
      const timedOut = new Promise<never>((_, reject) => {
        startupTimer = setTimeout(() => {
          const error = new Error(
            `ACP session startup timed out after ${this.startupTimeoutMs}ms`,
          );
          driver.closeConnection(error);
          reject(error);
        }, this.startupTimeoutMs);
      });
      const {
        initialized,
        sessionResponse,
        configOptions,
        modes,
        configOptionsEarlyUpdateCursor,
      } = await Promise.race([startup(), timedOut]);
      const acpId = sessionResponse.sessionId;
      const session: ManagedSession = {
        id: crypto.randomUUID(),
        agentId,
        cwd,
        acpSessionId: acpId,
        acpProtocol: driver.protocol,
        driver,
        process,
        promptActive: false,
        capabilities: initialized.capabilities,
        authMethods: initialized.authMethods,
        configOptions,
        modes,
        events: [],
        nextSequence: 1,
        droppedThrough: 0,
        permissionPolicy,
        pendingPermissions: new Map(),
      };
      this.sessions.set(session.id, session);
      for (const [index, update] of earlyUpdates.entries()) {
        if (update.sessionId === acpId) {
          this.receiveUpdate(
            session,
            update,
            index >= configOptionsEarlyUpdateCursor,
          );
        }
      }
      return session;
    } catch (error) {
      driver.closeConnection(error);
      await stopAgent(process.child, 1000);
      throw new Error(
        `Could not start ${agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
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
      messageText: new Map(),
      messageOrder: [],
      lastActivityAt: performance.now(),
      activityVersion: 0,
      activityWaiters: new Set(),
      done: Promise.resolve(),
    };
    session.prompt = record;
    record.done = this.consumePrompt(session, record, text);
    return record;
  }

  waitForPromptActivity(
    sessionId: string,
    promptId: string,
    activityVersion: number,
  ): { promise: Promise<void>; cancel: () => void } {
    const prompt = this.get(sessionId).prompt;
    if (!prompt || prompt.id !== promptId) {
      throw new Error(`Unknown prompt: ${promptId}`);
    }
    if (
      prompt.state !== "running" || prompt.activityVersion !== activityVersion
    ) {
      return { promise: Promise.resolve(), cancel: () => {} };
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => resolve = done);
    const waiter = () => {
      prompt.activityWaiters.delete(waiter);
      resolve();
    };
    prompt.activityWaiters.add(waiter);
    return {
      promise,
      cancel: () => prompt.activityWaiters.delete(waiter),
    };
  }

  private recordPromptActivity(session: ManagedSession): void {
    const prompt = session.prompt;
    if (!prompt || prompt.state !== "running") return;
    prompt.lastActivityAt = performance.now();
    prompt.activityVersion++;
    for (const waiter of [...prompt.activityWaiters]) waiter();
  }

  private async consumePrompt(
    session: ManagedSession,
    record: PromptRecord,
    text: string,
  ): Promise<void> {
    try {
      record.stopReason = await session.driver.prompt(
        session.acpSessionId,
        text,
      );
      if (record.state === "running") {
        record.state = record.stopReason === "cancelled"
          ? "cancelled"
          : "completed";
      }
    } catch (error) {
      if (record.state === "running") {
        record.state = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        if (
          error && typeof error === "object" &&
          "code" in error && typeof error.code === "number"
        ) record.errorCode = error.code;
        if (error && typeof error === "object" && "data" in error) {
          record.errorData = error.data;
        }
      }
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
      for (const waiter of [...prompt.activityWaiters]) waiter();
      for (const [id, pending] of session.pendingPermissions) {
        pending.resolve({ outcome: { outcome: "cancelled" } });
        session.pendingPermissions.delete(id);
      }
      await session.driver.cancel(session.acpSessionId);
      await Promise.race([
        prompt.done,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
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
    updateEvent: NormalizedAcpUpdate,
    applyConfigOptions = true,
  ) {
    this.recordPromptActivity(session);
    const configOptions = configOptionsFromUpdate(updateEvent);
    if (configOptions && applyConfigOptions) {
      session.configOptions = configOptions;
      this.notifyConfigOptionWaiters(session);
    }
    this.appendEvent(
      session,
      updateEvent.kind,
      updateEvent.update,
      updateEvent.raw,
    );
    if (session.prompt?.state === "running" && updateEvent.text) {
      const prompt = session.prompt;
      const messageId = updateEvent.text.messageId;
      if (!messageId) {
        prompt.text += updateEvent.text.text;
      } else {
        if (!prompt.messageText.has(messageId)) {
          prompt.messageOrder.push(messageId);
        }
        const previous = prompt.messageText.get(messageId) ?? "";
        prompt.messageText.set(
          messageId,
          updateEvent.text.replace
            ? updateEvent.text.text
            : previous + updateEvent.text.text,
        );
        prompt.text = prompt.messageOrder.map((id) =>
          prompt.messageText.get(id) ?? ""
        ).join("");
      }
    }
    if (updateEvent.stopReason && session.prompt?.state === "running") {
      session.prompt.stopReason = updateEvent.stopReason;
      if (updateEvent.stopReason === "cancelled") {
        session.prompt.state = "cancelled";
      } else if (updateEvent.error) {
        session.prompt.state = "failed";
        session.prompt.error = updateEvent.error?.message ??
          "ACP prompt failed";
        session.prompt.errorCode = updateEvent.error?.code;
        session.prompt.errorData = updateEvent.error?.data;
      } else {
        session.prompt.state = "completed";
      }
      session.promptActive = false;
    }
  }

  waitForConfigOptions(
    sessionId: string,
    predicate: (options: Array<Record<string, unknown>>) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const session = this.get(sessionId);
    if (predicate(session.configOptions) || timeoutMs <= 0) {
      return Promise.resolve(session.configOptions);
    }
    return new Promise((resolve) => {
      const waiters = this.configOptionWaiters.get(sessionId) ?? new Set();
      this.configOptionWaiters.set(sessionId, waiters);
      let abort: (() => void) | undefined;
      const waiter: ConfigOptionWaiter = {
        predicate,
        finish: (options) => {
          clearTimeout(timer);
          if (signal && abort) signal.removeEventListener("abort", abort);
          waiters.delete(waiter);
          if (waiters.size === 0) this.configOptionWaiters.delete(sessionId);
          resolve(options);
        },
      };
      const timer = setTimeout(
        () => waiter.finish(session.configOptions),
        timeoutMs,
      );
      if (signal) {
        abort = () => waiter.finish(session.configOptions);
        signal.addEventListener("abort", abort, { once: true });
      }
      if (signal?.aborted) {
        waiter.finish(session.configOptions);
      } else {
        waiters.add(waiter);
      }
    });
  }

  private notifyConfigOptionWaiters(session: ManagedSession): void {
    const waiters = this.configOptionWaiters.get(session.id);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (waiter.predicate(session.configOptions)) {
        waiter.finish(session.configOptions);
      }
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
    session.configOptions = await session.driver.setConfigOption(
      session.acpSessionId,
      configId,
      value,
      option,
    );
    return session.configOptions;
  }

  async setMode(sessionId: string, modeId: string) {
    const session = this.get(sessionId);
    session.modes = await session.driver.setMode(
      session.acpSessionId,
      modeId,
      session.configOptions,
      session.modes,
    );
    return session.modes;
  }

  private async requestPermission(
    params: AcpPermissionRequest,
    policy: PermissionPolicy,
  ) {
    const session = [...this.sessions.values()].find((item) =>
      item.acpSessionId === params.sessionId
    );
    const options = params.options ?? [];
    const choose = (kind: string) =>
      options.find((option) => option.kind === kind);
    if (!session) return { outcome: { outcome: "cancelled" as const } };
    this.recordPromptActivity(session);
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
    const kind = (params.toolCall as { kind?: string | null } | undefined)
      ?.kind;
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
    if (session.prompt?.state === "running") {
      try {
        await this.cancelPrompt(id, session.prompt.id);
      } catch { /* Closing the connection remains authoritative. */ }
    }
    if (session.permissionLease) clearTimeout(session.permissionLease);
    session.permissionLease = undefined;
    for (
      const waiter of [
        ...(this.configOptionWaiters.get(id) ?? []),
      ]
    ) waiter.finish(session.configOptions);
    for (const pending of session.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    session.pendingPermissions.clear();
    this.sessions.delete(id);
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const closeRequest = session.driver.closeSession(session.acpSessionId)
      .catch(
        () => undefined,
      );
    await Promise.race([
      closeRequest,
      new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, this.closeRequestTimeoutMs);
      }),
    ]);
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    session.driver.closeConnection();
    await stopAgent(session.process.child, 5000);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.close(id)),
    );
  }
}
