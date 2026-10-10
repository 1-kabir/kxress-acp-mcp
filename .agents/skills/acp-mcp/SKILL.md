---
name: acp-mcp
description: Use the connected acp-mcp MCP service for live ACP agent/model discovery, one-shot tasks, and explicit multi-turn sessions.
---

# Use acp-mcp

Use this skill when an ACP-compatible agent can help with a task or the user
asks about configured agents and models.

## Connected service is authoritative

- For normal workflows, use the host-connected `acp_mcp` tools. Start with
  `list_agents`, then use `list_models` and advertised config/capability data
  for the selected agent.
- If the connected service is unavailable, report that and continue with allowed
  direct work. Do not launch a repository bridge,
  `scripts/planning_workflow.ts`, a separate `acp-mcp` process, or an in-memory
  MCP server as a substitute.
- Repository planning or compatibility tools are source-checkout utilities. Use
  them only when the task explicitly calls for repository-level diagnosis or
  testing; their results do not describe the host-connected service.
- Choose agent, model, and settings for this invocation from the task
  constraints and user preference. Use exact currently advertised values. Do not
  use a historical catalog, infer choices from another CLI, or invent defaults.

## One-shot work and sessions

- Use `run_task` for one requested agent/model execution and a compact final
  result. It does not retry, switch models, or fall back to another protocol.
  After a failure, do not replay work that may have had effects unless the
  caller explicitly authorizes a safe next attempt.
- A model fallback requires explicit caller/user authorization and a currently
  advertised exact choice. Never silently substitute a model or persist a
  failure as a future model preference.
- Use `start_session` and `prompt` for continuing work. Use `get_events`,
  `get_session`, and `list_sessions` when state or activity is needed; use
  config, mode, permission, cancellation, load, and close tools only as
  supported and advertised by that agent.
- Use `resolve_permission` for an operator decision when the session is waiting
  for one. Close sessions when finished. For abandoned product-owned disposable
  workspaces, inspect with `list_stale_workspaces` and remove eligible entries
  with `cleanup_stale_workspaces`.
- The bridge holds at most eight active sessions in memory per server process.
  Restarting the server loses its session map; a downstream agent may still
  support loading its persisted session.

## Protocol and capability policy

- Use the agent's configured ACP protocol. ACP v1 is the default. ACP v2 is an
  explicit per-agent experimental choice. Do not guess support or retry another
  protocol after initialization fails.
- Downstream agents differ in models, config options, modes, permissions, and
  load/resume behavior. Follow live advertisement rather than assuming parity.
  The Codex host running this MCP service is distinct from the downstream Codex
  ACP agent.
- Antigravity's CLI catalog is not its ACP catalog. Use only values advertised
  by the selected connected ACP implementation; do not synthesize CLI models or
  reasoning controls.
- The `antigravity` profile defaults to Google's official ACP server.
  `implementation: "refined"` selects the refined wrapper, and
  `implementation: "agy"` selects the pinned community adapter backed by the
  `agy` CLI. `list_agents` and doctor identify the effective choice. These are
  explicit selections with no automatic fallback or catalog merging. Follow each
  selected server's live models/config/capabilities. The agy adapter bypasses
  ACP permission requests with `--dangerously-skip-permissions`, so
  `permissionPolicy` cannot mediate its actions; personal Antigravity OAuth use
  also carries the upstream-documented terms/account risk. Keep it opt-in.

## Configuration and model selection

- Implicit config loads `~/.acp-mcp.json`, then ancestor `.acp-mcp.json` files
  from outermost to nearest relative to the operation cwd. Objects merge
  recursively; arrays replace. Exact `--config <path>` disables discovery.
- Project config may set model policy and the closed Antigravity implementation
  selector, but cannot provide executable commands, args, or environment. Home
  and exact explicit config are trusted launch configuration.
- Use advertised exact model IDs. `modelSize` values are `small`, `medium`,
  `large`, `xlarge`; normalized `thinkingEffort` values are `low`, `medium`,
  `high`, `xhigh`, `max`, `ultra`. Size is a configured family position, not a
  capability ranking. `max`/`ultra` cap at the highest supported effort;
  concrete unsupported efforts fail.
- Apply `allowedModels` and `deniedModels` to explicit requests too; deny wins.
  Never invent a mapping, select a substitute model, or retry another choice.
  Live ACP advertisement remains authoritative. Sessions retain policy resolved
  at creation/load; project edits apply to later operations/sessions.

## Trust and privacy

- The stdio service trusts its launching host and user; acp-mcp adds no separate
  MCP caller authentication. The host owns registration, process launch,
  inherited environment, and tool exposure. Do not assume acp-mcp can repair or
  inspect host configuration or environment propagation.
- `permissionPolicy: read_only` controls responses to ACP permission requests.
  It is not filesystem protection or an OS sandbox; an agent may act without an
  ACP permission request. ACP children run with the user's OS privileges.
- ACP content can be sensitive. `get_events` intentionally exposes session
  content and may include user/assistant text, tool details, paths, permission
  context, or upstream metadata. Raw events contain the original ACP envelope.
  Retrieve journals only when needed and treat them as content, not sanitized
  logs.
- Agent tasks and files read by an agent may be sent to its configured provider.
  A disposable planning snapshot is a controlled copy, not a sandbox or secret
  filter; review its included files before sending repository context.

## Local product and repository tooling

- Installed use is through the native `acp-mcp` executable. No arguments starts
  the MCP stdio server; `acp-mcp doctor` is local and offline and does not
  verify host registration, provider authentication, or live agent health.
- `mise` and Deno tasks are for repository maintenance and local development.
  They are not required by the installed product. `deno task test` is
  deterministic/offline; `mise exec -- deno task compat <agentId>` is an
  explicit live test and may use provider quota. Do not run live compatibility
  tests unless the task asks for them.
- The local release workflow is operator-run; it is not hosted CI or automatic
  publication. SHA-256 compares artifact bytes with a known checksum and does
  not authenticate the publisher.
