---
name: acp-mcp
description: Use configured ACP agents through acp-mcp for one-shot tasks, model discovery, or explicit multi-turn sessions.
---

# Use acp-mcp

Use this skill when a task benefits from a separate ACP-compatible agent or when
the user asks to inspect available agents or models.

## Choose the tool

- Use `list_agents` to see configured ACP agents.
- Built-in IDs are `opencode`, `codex`, and `antigravity`. They launch through
  OpenCode's native ACP mode, the maintained Codex ACP adapter, and Google's
  first-party Antigravity ACP server, respectively. The generic bridge uses the
  same ACP runtime after each command starts. `list_agents.commandFound` reports
  executable presence only; it does not verify credentials.
- For Antigravity, a `session_start_failed` result reporting authentication
  required can mean its separate ACP profile lacks an auth selector even when
  the normal `agy` CLI is authenticated. Check
  `~/.gemini/antigravity-acp/settings.json` for
  `{"auth":{"type":"oauth-personal"}}`; if needed, authenticate through the
  official ACP server. Fresh ACP server processes have reused persisted ACP auth
  state without another login. Never copy credential files or extract secrets.
  If the executable is missing, check the configured absolute
  `agents.antigravity.command` path or install the official Registry binary;
  `acp-mcp` does not expand environment variables inside command values.
- Use `list_models` when model choices are unknown or need live validation. It
  reports models advertised by the current ACP session; optional OpenCode
  metadata only enriches those choices.
- Use `run_task` for one-shot planning, research, review, second opinions,
  repository exploration, and bounded implementation work. Pass a known model
  through the generic `config` map without listing models first when its config
  ID and value are known.
- Use `start_session`, `prompt`, and related session tools for multi-turn work,
  event inspection, manual permission handling, debugging, or long-running
  asynchronous tasks.

## Run a one-shot task

Call `run_task` with the configured `agentId`, a clear `task`, and `cwd` when
the ACP agent should inspect a particular checkout. Ask the agent to inspect the
repository itself. Do not first paste repository files, summaries, or diffs into
the task unless you intend to send that content to the configured model
provider.

The one-shot operation returns a compact final answer and stop reason, then
closes its managed ACP session. Internal ACP updates are not returned by
default. Do not call `get_events` or poll session state for ordinary one-shot
work.

`run_task.idleTimeoutMs` limits how long the task's own ACP session can remain
silent (default: 10 minutes). Any inbound session update resets the timer,
including unknown future update variants. Do not increase it merely because a
planning task may take a long time; active tasks can run beyond the idle
timeout. Choose a generous idle timeout for potentially long model inference
waits. Caller cancellation remains immediate. There is no absolute run-time cap.
`permissionLeaseMs` separately controls how long an operator handoff remains
available (default: 2 minutes).

## Select models and other settings

ACP config IDs belong to the agent. Use the `config` map with the advertised
config ID and option value; do not assume every agent uses the key `model`.
`list_models` returns the config ID for each model choice. ACP category metadata
can also identify model, mode, model-configuration, and thought-level options.
Use explicit session inspection when you need to enumerate config options beyond
model choices.

## Permissions and disclosure

The default `read_only` policy controls how acp-mcp responds to ACP permission
requests. It does not sandbox the ACP process, guarantee that repository data
stays local, or prevent the configured model provider from receiving task and
repository context. The agent may read files under its working directory and use
its own network access. Host approval policies still apply; review and approve
external/open-world calls through the host's normal flow.

Use `operator` when a human should decide an ACP permission request. A
`permission_required` result contains the managed session and permission IDs,
advertised choices, and lease duration. Continue with `resolve_permission` and
the explicit session tools before the lease expires.

Use `get_events` only when the user asks to inspect ACP activity or when
debugging a session. Thought and raw event data may be sensitive and should be
retrieved only when needed.

## Handle task failures

`run_task` returns compact failure metadata. `error.kind` and `error.stage`
describe the generic bridge failure. An optional `error.acpCode` is a JSON-RPC
code, not an HTTP status or a rate-limit classification. An optional
`error.classification` is agent-specific interpretation; check its `source` and
`evidence`. For example, an OpenCode `message_heuristic` classification is based
on explicit provider wording, not structured HTTP evidence. If classification is
absent, do not guess. In particular, `-32603` alone never means rate limited.
The bridge does not retry or change models automatically.

Before repeating a failed task, consider whether it may have performed work. An
explicitly classified transient failure may support a caller-chosen fallback for
restartable work. An ambiguous failure must not be silently replayed.
`read_only` is not an OS sandbox. For a restartable planning or research task,
the caller owns the complete fallback decision; `run_task` always executes only
the requested model. Use this bounded workflow:

1. Keep an explicit ordered list of models allowed for this task. The first
   preference wins; economic tier never overrides that order.
2. If candidate metadata matters, call `list_models` with `enrich: true` and
   keep only models currently advertised by ACP. Advertisement means selectable,
   not healthy or currently accepting requests.
3. Check `free`, `pricingStatus`, `subscriptionRequired`, `underlyingCostTier`,
   and `privacy` separately. An OpenCode Go model requires a paid monthly
   subscription even when its published per-token price is zero. Current zero
   price does not mean a low underlying cost tier, and cost tier is not a
   capability score. Missing privacy metadata means unknown; if policy requires
   a known privacy property, reject unknown candidates. Do not silently cross
   from known source-model terms to weaker or unknown candidate terms unless the
   user or workflow explicitly permits that change. A no-training policy rejects
   candidates that may use prompts for improvement/training.
4. Run the preferred model once. Consider the next explicitly allowed model only
   for a classification the workflow permits. The current OpenCode
   `rate_limited` result uses `source: "opencode"` and
   `evidence: "message_heuristic"`; accept that heuristic only when the workflow
   explicitly allows it. Generic `-32603`, other unclassified errors, and idle
   timeouts do not authorize replay.
5. Limit the workflow to its declared attempt count (normally two for a simple
   fallback), skip models already tried during this workflow, and stop when no
   explicitly allowed candidate remains. Failure state is attempt-local; do not
   persist model health.

Replay is only for work the caller has explicitly judged restartable, such as
planning or research. `read_only` does not guarantee idempotence or prevent
external effects. Do not apply this workflow automatically to implementation
tasks. For example, Fledge Alpha Free remains the preferred planning model when
explicitly selected; its current free price is promotional and OpenCode
documents that its free-period data may be used to improve the model. A fallback
to it must respect that disclosure policy.
