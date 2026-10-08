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
the caller may explicitly choose another currently advertised model through the
generic `config` map, but should first check that the alternate model's data-use
terms are acceptable. Current `list_models` enrichment reports OpenCode
pricing/free metadata, not privacy guarantees. Do not rotate through models
automatically or infer that all free models have the same privacy or
availability characteristics.
