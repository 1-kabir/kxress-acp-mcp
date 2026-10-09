---
name: acp-mcp
description: Use configured ACP agents through acp-mcp for one-shot tasks, model discovery, or explicit multi-turn sessions.
---

# Use acp-mcp

Use this skill when a task benefits from a separate ACP-compatible agent or when
the user asks to inspect available agents or models.

## Choose the tool

- Use `list_agents` to see configured ACP agents.
- Built-in IDs are `opencode`, `codex`, `claude`, and `antigravity`. They launch
  through OpenCode's native ACP mode, the maintained Codex ACP adapter, the
  maintained Claude Agent ACP adapter, and Google's first-party Antigravity ACP
  server. The generic bridge uses the same ACP runtime after each command
  starts. `list_agents.commandFound` reports executable presence only; it does
  not verify credentials or provider access.
- Live compatibility tests are opt-in and may use provider quota or API billing.
  Run one explicitly with `mise exec -- deno task compat <agentId>`; no target
  prints help and does not start an agent. Normal `deno task test` remains
  deterministic and offline.
- Claude Agent ACP is a launch profile, not a provider or subscription choice.
  Provider authentication, endpoint, and model come from user configuration and
  the adapter's advertised ACP options. Use `list_models` for the current
  session, then select an exact advertised model and any advertised reasoning
  value. Do not assume a particular Claude model or provider.
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

## Plan or research from a disposable workspace

For repository planning/research where relative writes should not touch the real
checkout, choose an agent and model for this invocation. The session/user owns
that choice; there is no workflow-default agent or model. First inspect
configured agents with `list_agents`, then discover compact live choices for the
selected agent:

```powershell
mise exec -- deno run --allow-env --allow-read --allow-write --allow-run --allow-net=opencode.ai scripts/planning_workflow.ts models --agent <agentId> --privacy-policy allow_any --limit 30
```

Use `--search`, `--offset`, and restrictive policies to explore large catalogs
without dumping them into context. The summary preserves ACP order and shows
exact IDs, names, ACP current selection, free/paid/unknown status, pricing
status, subscription requirement, privacy facts, and economic tier where
available. It does not rank or recommend. ACP advertisement means selectable,
not healthy or currently accepting requests. `underlyingCostTier` is economic
positioning, never a capability score.

Choose candidates against the task's difficulty and reasoning needs, current
quota/cost constraints, privacy/data-use requirements, live advertised configs,
and the user's explicit preference. When several candidates have material
privacy, paid-quota, latency, or reasoning-cost tradeoffs and no preference is
clear, ask the user rather than ranking them automatically.

After the session/user chooses an exact advertised model, inspect its advertised
reasoning, mode, and other config values:

```powershell
mise exec -- deno run --allow-env --allow-read --allow-write --allow-run --allow-net=opencode.ai scripts/planning_workflow.ts configs --agent <agentId> --model <exact-model-id> --repo (Get-Location).Path
```

Then run with the exact choice and explicit privacy and cost policies:

```powershell
mise exec -- deno run --allow-env --allow-read --allow-write --allow-run --allow-net=opencode.ai scripts/planning_workflow.ts run --agent <agentId> --model <exact-model-id> --repo (Get-Location).Path --task "Inspect this repository and propose a plan" --privacy-policy allow_any
```

Pass selected config values as repeated `--config-option id=value` and a chosen
advertised mode as `--mode`. The runner checks them before execution; omitted
config leaves the agent's current/default values in effect. Explicit user
preferences win; if a requested model is not advertised, stop rather than
substitute. Invocation-specific choices do not become future defaults.

Fallbacks are explicit ordered `--fallback agentId:modelId` values supplied by
the caller/session. Add `--allow-rate-limited-fallback` to authorize retry after
an allowed `rate_limited` classification, including the OpenCode message
heuristic. No candidate is inferred from the catalog. Timeouts, unclassified
failures, generic `-32603`, and other failures stop. Fallbacks must satisfy the
same live advertisement, privacy, and cost policies. Attempts are bounded.

`--free-only` and `--no-subscription` are independent optional cost filters; use
both when both constraints apply. With neither, no cost constraint is imposed.
`allow_any` permits unknown privacy metadata; `require_no_training` requires
known no-training metadata; `require_no_training_and_zero_retention` requires
both known properties. Choose policies from user constraints rather than
assuming every task needs a free or paid model.

The workflow captures one canonical snapshot of current tracked filesystem
contents plus untracked non-ignored files, then makes a fresh independent clone
for each model attempt. Relative edits in one attempt do not appear in another
attempt's clone, and every candidate sees the same captured source state even if
the parent checkout changes meanwhile. This is not protection against an agent
deliberately accessing another path with its normal OS permissions. The
canonical snapshot and every attempt clone are cleaned after use. A hard process
or machine crash may leave temp workspaces behind; there is no background
cleanup service.

The snapshot helper copies current tracked file contents (whether their edits
are staged or unstaged) and untracked non-ignored files. It does not copy the
Git index, untracked ignored files, `.git`, symlinks/reparse-point entries, or
submodule contents. Creation failure prevents execution; cleanup failure is
included in the JSON result with the remaining path. The compact result shows
the selected model, attempted/skipped candidates, classifications, response, and
cleanup warnings. Direct `run_task` remains useful when isolation is not needed;
it always executes in exactly the supplied `cwd`.

This workflow protects the original checkout from ordinary reads, writes,
deletions, and file creation performed relative to the planner's snapshot cwd.
It is not an OS sandbox: an agent process still has the user's normal access to
absolute paths, other directories, credentials, processes, and the network.
`permissionPolicy: read_only` remains only an ACP permission-request response
policy. A snapshot is also not a secret-scanning boundary; only use it when the
files selected by the inclusion rules are appropriate to send to the configured
model provider. `run_task` itself always uses exactly the `cwd` supplied by its
caller.

## Select models and other settings

ACP config IDs belong to the agent. Use the `config` map with the advertised
config ID and option value; do not assume every agent uses the key `model`.
`list_models` returns the config ID for each model choice. The planning
workflow's `configs` command uses a disposable session with the selected model
and summarizes non-model options. Apply a reasoning/thought level only when that
exact value is advertised. If no level was requested, leave the agent's
current/default value unless the tradeoff materially changes cost or quality;
then ask the user when their preference is unclear.

## Permissions and disclosure

The default `read_only` policy controls how acp-mcp responds to ACP permission
`session/request_permission` requests: it allows agent-reported `read`,
`search`, `fetch`, and `think` kinds and rejects other requested kinds. ACP
agents may act without requesting permission, so this is not filesystem
isolation and does not sandbox the ACP process. It also cannot guarantee that
repository data stays local or prevent the configured model provider from
receiving task and repository context. The agent runs with its own process/OS
access and may use its own network access. Host approval policies still apply;
review and approve external/open-world calls through the host's normal flow.

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

1. Use the user/session-selected agent and exact model. If there is no clear
   preference and the remaining choices have material tradeoffs, ask the user.
   Economic tier never overrides that selection.
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
4. Run the selected model once. Consider the next explicitly allowed model only
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
tasks. Keep task-specific agent, model, and reasoning choices in the invocation.
A choice for one run is not a recommendation or default for later runs.
