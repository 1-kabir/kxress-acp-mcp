---
name: acp-mcp
description: Use configured ACP agents through acp-mcp for one-shot tasks, model discovery, or explicit multi-turn sessions.
---

# Use acp-mcp

Use this skill when a task benefits from a separate ACP-compatible agent or when
the user asks to inspect available agents or models.

## Choose the tool

- Use `list_agents` to see configured ACP agents.
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
