# acp-mcp

A stdio MCP server that starts one ACP agent process per managed session. The
first slice supports OpenCode by default and arbitrary local ACP executables
through JSON configuration.

## Run

Install mise and run the repository-managed Deno 2.9.6 directly:

```powershell
mise exec -- deno task start
```

The server is a stdio MCP process launched by its host, not a permanent OS
daemon. MCP protocol traffic goes to stdout; diagnostics go to stderr. The
server closes managed ACP sessions when its host closes stdin or sends SIGINT.

### Codex registration

Register the server with the Codex CLI, replacing the checkout path if needed:

```powershell
codex mcp add acp_mcp -- mise exec -C D:\repos\acp-mcp -- deno task start
```

This adds a global stdio entry to Codex's `config.toml` and leaves other MCP
servers intact. The tested entry is equivalent to:

```toml
[mcp_servers.acp_mcp]
command = "mise"
args = ["exec", "-C", "D:\\repos\\acp-mcp", "--", "deno", "task", "start"]
```

Codex starts the server on demand. If `mise` is not on Codex's PATH, use its
absolute executable path for `command`.

The default profile launches `opencode acp`; authenticate separately with
`opencode auth login`.

Built-in agent IDs use their canonical ACP launch paths:

- `opencode` starts OpenCode's native `opencode acp` mode.
- `codex` starts the maintained `codex-acp` adapter. Install it globally with
  `npm install -g @agentclientprotocol/codex-acp`. To use the documented
  one-shot route, configure `command: "npx"` and
  `args: ["-y", "@agentclientprotocol/codex-acp"]`; this may download the
  package when first run. The adapter bundles a compatible Codex CLI by default
  and supports `CODEX_PATH` when you want to select another executable.
- `antigravity` starts Google's separate first-party ACP server. Install it from
  the
  [ACP Registry](https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp);
  on Windows the binary is `agy_acp_server.exe`. Put it on `PATH` or configure
  its absolute path.

These are launch differences only. Once started, every profile uses the same ACP
session, configuration, activity-based idle timeout, permission, event, and
cleanup flow. Custom ACP stdio commands continue to work without a built-in
profile. `list_agents` includes `commandFound` to report whether the configured
executable is present; it does not check authentication or provider access.

### Antigravity authentication

The normal `agy` CLI profile and the ACP server's profile are separate. The
normal CLI login alone does not establish ACP authentication. On Windows, the
ACP profile selector is `%USERPROFILE%\.gemini\antigravity-acp\settings.json`:

```json
{ "auth": { "type": "oauth-personal" } }
```

Authenticate through the official ACP server if its existing state requires it.
After that authentication has been completed once, fresh server processes can
reuse the ACP server's persisted authentication state. It manages its own
runtime files in this profile; do not copy token files or credentials from the
CLI profile.

### Stable Antigravity ACP installation on Windows

Download the Windows archive listed by the official
[ACP Registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)
and extract the entire archive in a user-local directory such as
`%LOCALAPPDATA%\acp-mcp\agents\antigravity\<version>\`. Keep
`localharness_external.exe` alongside `agy_acp_server.exe`; the server needs
both. Then configure `agents.antigravity.command` in
`%APPDATA%\acp-mcp\config.json` to the absolute path of `agy_acp_server.exe` and
set `args` to `[]`. For example:

```json
{
  "agents": {
    "antigravity": {
      "command": "C:\\Users\\<user>\\AppData\\Local\\acp-mcp\\agents\\antigravity\\<version>\\agy_acp_server.exe",
      "args": []
    }
  }
}
```

`acp-mcp` supports absolute executable paths but does not expand environment
variables inside `command`; substitute the actual user-local path. This explicit
configuration is checked by `list_agents` and avoids a PATH change. The current
ACP Registry entry provides the current official archive URL and version but no
archive checksum; the 1.3.0 Windows executables were Authenticode-verified as
signed by Google LLC.

## Agent configuration

Pass `--config <path>` to load an explicit JSON config. On Windows the default
is `%APPDATA%\acp-mcp\config.json`; elsewhere it is
`$XDG_CONFIG_HOME/acp-mcp/config.json` or `~/.config/acp-mcp/config.json`.

```json
{
  "agents": {
    "custom": {
      "command": "C:\\tools\\custom-agent.exe",
      "args": ["serve"],
      "displayName": "Custom agent",
      "env": { "AGENT_LOG_LEVEL": "warn" }
    }
  }
}
```

Configured agents run with the current user's OS permissions. The bridge does
not sandbox subprocesses. ACP permission policy controls responses to
`session/request_permission`; it does not intercept ordinary tool calls or
provide OS-level isolation. By default, `read_only` allows requested
agent-reported `read`, `search`, `fetch`, and `think` kinds and rejects other
requested kinds. ACP agents may perform actions without requesting permission,
so `read_only` does not guarantee that a task cannot modify files.

The `run_task` tool may send its task and repository content read by the ACP
agent to that agent's configured model provider. `read_only` does not keep
repository data local, restrict network access, or sandbox the child process.
Codex and other MCP hosts continue to apply their own approval and security
policies. See the
[ACP permission request protocol](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission)
for the agent's permission-request behavior.

For repository planning or research where relative writes should not touch the
real checkout, use the session-driven script from PowerShell. First discover the
selected agent's live candidates with a required privacy and cost policy:

```powershell
mise exec -- deno run --allow-env --allow-read --allow-write --allow-run --allow-net=opencode.ai scripts/planning_workflow.ts models --agent <agentId> --privacy-policy allow_any --search <optional-text> --limit 30
```

The result preserves ACP order, shows at most 30 compact candidates by default,
and supports `--offset` for another page. It includes exact model IDs, ACP's
currently selected value, current free/paid/unknown and privacy facts, known
subscription requirement, and economic tier where available. Tier is an economic
signal, not a capability score. Search and hard filters reduce large catalogs;
no quality ranking or model recommendation is applied. Advertisement means
selectable, not that the provider is healthy or accepting requests.

After choosing an exact advertised ID, inspect its config separately:

```powershell
mise exec -- deno run --allow-env --allow-read --allow-write --allow-run --allow-net=opencode.ai scripts/planning_workflow.ts configs --agent <agentId> --model <exact-model-id> --repo (Get-Location).Path
```

Then execute the exact choice:

```powershell
mise exec -- deno run --allow-env --allow-read --allow-write --allow-run --allow-net=opencode.ai scripts/planning_workflow.ts run --agent <agentId> --model <exact-model-id> --repo (Get-Location).Path --task "Inspect this repository and propose a plan" --privacy-policy allow_any
```

No agent, model, or fallback is selected implicitly. `--free-only` requires
known free status, while `--no-subscription` requires explicit metadata that no
subscription is needed; use both to apply both constraints. With neither flag,
the workflow imposes no cost constraint. `--fallback agentId:modelId` adds
caller-approved candidates in order; `--allow-rate-limited-fallback` is also
required to retry after an allowed `rate_limited` classification. Strict privacy
policies require known metadata. Use `--config-option id=value` or `--mode` only
with values shown by the selected model's live `configs` output; the run command
checks them before execution. The calling session's explicit selection wins over
price, tier, or ACP's current selection.

The workflow captures one canonical snapshot and creates a fresh clone for each
model attempt, so failed-attempt mutations cannot contaminate fallback input and
all candidates see the same source state. Snapshots include current tracked
filesystem contents and untracked non-ignored files; they omit the Git index,
untracked ignored files, `.git`, symlink/reparse entries, and submodule
contents. Cleanup runs after attempts and reports leftovers. A hard process or
machine crash may leave temp directories behind.

The snapshot keeps ordinary relative planner writes and deletions out of the
original checkout. It is not an OS sandbox and does not prevent access through
absolute paths, other directories, credentials, subprocesses, or the network.
Review the copied files before sending repository context to a model provider.
For low-level workflows, `scripts/planning_workspace.ts` exposes explicit
snapshot `create` and `cleanup` actions. `run_task` itself remains a one-model
primitive and always uses exactly its supplied `cwd`.

`run_task.idleTimeoutMs` defaults to 10 minutes and limits consecutive silence
from the task's ACP session. Any inbound `session/update` for that session
resets it, including update variants this bridge does not recognize. Active
tasks can run longer than 10 minutes; there is no absolute runtime limit. MCP
request cancellation still cancels the task immediately. For
`permission_required` handoffs, `permissionLeaseMs` (default 2 minutes) controls
how long the session remains available for operator resolution; after the
handoff, that lease owns the session lifecycle.

ACP updates for the active session and ACP permission requests count as task
activity. The bridge does not use arbitrary subprocess stderr as a heartbeat.

Tools include `run_task`, `list_models`, `list_agents`, `start_session`,
`load_session`, `get_session`, `prompt`, `get_events`, `cancel_prompt`,
`resolve_permission`, `set_config_option`, `set_mode`, `list_sessions`, and
`close_session`. Use `run_task` for one-shot work. Use explicit session tools
for multi-turn conversations, manual permission handling, or event inspection. A
prompt call accepts `wait` and `waitMs`; if it is still running at the wait
limit, the response includes its prompt ID. Use `get_events` with the session ID
and `afterSequence` cursor to read updates, or `cancel_prompt` to send ACP
cancellation. Raw ACP payloads and thought events are omitted from polling
results unless requested.

Inbound `session/update` notifications are intercepted at the public SDK stream
boundary before SDK notification validation. The bridge journals their original
params, including metadata and unknown update tags, while all other ACP traffic
continues through the SDK client.

`start_session` accepts arbitrary advertised config IDs through its `config`
object and an optional `modeId`. Config values are strings; boolean ACP options
use `"true"` or `"false"`. The ACP client advertises boolean config-option
support and converts those strings to protocol booleans. `permissionPolicy`
defaults to `read_only`; `operator` exposes requests through `get_session` and
waits for `resolve_permission`, while `allow_all` and `deny_all` apply
advertised ACP options. `read_only` allows requests whose advertised tool kind
is `read`, `search`, `fetch`, or `think`, and rejects other requested kinds.
These policies apply only when an agent requests permission; they do not prevent
an agent from acting without a request or sandbox the child process.

`load_session` starts a fresh agent process and calls `session/load` only when
the agent advertises that capability. Supply the original absolute working
directory along with the ACP session ID.

Use `run_task` for one-shot planning, research, review, second opinions,
repository exploration, and other tasks. It runs one task in an internal ACP
session, waits up to 120 seconds (configurable to 10 minutes), returns only the
final assistant text and stop reason, then closes the session. Internal ACP
activity remains inside `acp-mcp`; the MCP caller receives only the result
returned by `run_task`. The task and files the ACP agent reads may be sent to
its configured model provider. The permission policy defaults to `read_only`;
this controls ACP permission responses, not data locality or OS isolation. This
supports subagent-style workflows while remaining a generic one-shot ACP task
operation. Request `allow_all` explicitly when needed. With `operator`, a
permission request returns a `permission_required` result containing the managed
session and permission IDs, advertised choices, and lease duration. Resolve it
with `resolve_permission` and use low-level tools to continue or close that
session. Unused permission continuations close when the lease expires.

`run_task` failures return a compact `error` with a generic `kind` and `stage`.
For example, `prompt_failed` means the ACP prompt request failed; an optional
`acpCode` is a JSON-RPC code and does not identify an HTTP status or prove a
provider rate limit. Provider messages, stderr, and event history stay private.
The tool does not retry or switch models automatically. A failed prompt may have
already performed work, and `read_only` is not an OS sandbox, so callers must
decide whether restarting a particular task is safe. `timed_out` means the
bridge deadline expired while waiting for the prompt; it is separate from a
provider rate-limit failure.

### Implementation planning

For repository planning, let the ACP agent inspect the checkout itself:

1. Use a known advertised model ID directly, or call `list_models` when you need
   to validate available choices.
2. Call `run_task` with the checkout as `cwd` and concise task instructions. Ask
   the agent to inspect the repository; do not first read files in Codex and
   paste their contents into the task unless you intend to share them.
3. Review the host's approval prompt for the external ACP call and approve that
   invocation if appropriate.
4. Use the compact plan returned by `run_task` to guide implementation.

In Codex, a per-invocation prompt for this tool can be enabled with:

```powershell
codex --ask-for-approval on-request -c 'mcp_servers.acp_mcp.tools.run_task.approval_mode="prompt"'
```

This is a temporary command-line override. It does not persist an approval
setting; Codex still asks before running the tool. The host's confirmation
screen is the approval boundary. `acp-mcp` does not bypass or replace it.

Use the low-level session tools for multi-turn sessions, event inspection,
manual permission handling, long-running asynchronous work, debugging, and
advanced orchestration. `start_session` and `prompt` preserve session state;
`get_events` exposes buffered updates on request; `cancel_prompt` sends ACP
cancellation.

ACP activity and event journals remain server-side unless a tool explicitly
returns them (for example, `get_events`).

Use `list_models` to inspect model choices exposed by a live ACP session. It
starts and closes a temporary `read_only` session, and returns only the
advertised choices with their ACP config ID so `run_task` or `start_session` can
select one through the existing `config` map. ACP `category: "model"` metadata
identifies model selectors; the configured profile mapping is used only when the
live option has no category. Other config options remain available through the
generic `config` map and explicit session tools. Agents without model choices
return an empty list. Set `enrich: true` to request optional OpenCode Zen and Go
metadata for the OpenCode profile; metadata is attached only to exact
provider-qualified IDs already advertised by ACP. The official
[Zen model endpoint](https://opencode.ai/zen/v1/models),
[Zen documentation](https://opencode.ai/docs/zen/),
[Go model endpoint](https://opencode.ai/zen/go/v1/models), and
[Go documentation](https://opencode.ai/docs/go/) provide catalog, pricing, and
data-use information. OpenCode Go token prices apply within a paid monthly
subscription, which enriched Go entries mark with `subscriptionRequired: true`.
Metadata lookup failures preserve the available ACP model list. No catalog or
availability cache is used.

For OpenCode models, enrichment keeps current `pricing`/`free` separate from
optional `pricingStatus: "limited_time"` and `underlyingCostTier`. The cost tier
is a coarse project band derived from the maximum published input/output price
per million tokens: below $1 is `low`, below $5 is `medium`, below $20 is
`high`, and $20 or more is `premium`. A zero-priced model gets no underlying
tier unless OpenCode documents an exact paid counterpart. The documented
`jev-1.13-free` to `jev-1.13` relationship is represented explicitly; similar
model names alone never establish a counterpart. OpenCode Go's directly
published token prices can provide a cost tier for that Go catalog entry, but do
not automatically establish a counterpart relationship to a Zen model. Tier and
privacy facts include source provenance. Privacy metadata is only attached where
the relevant official catalog documents it; absent metadata means unknown, not a
guarantee. `underlyingCostTier` describes pricing position, not model
capability. OpenCode Go entries report `free` from per-token prices and
separately mark the required subscription so zero token price is not mistaken
for free access.

`run_task` never retries or switches models. For restartable planning/research,
the caller may compose `list_models` and separate `run_task` calls using an
explicit, bounded model preference order. Only a failure classification allowed
by that workflow (currently OpenCode's explicit-wording `rate_limited`
heuristic) can authorize fallback; generic `-32603`, unclassified failures, and
idle timeouts do not. A model being ACP-advertised means it is selectable, not
healthy. Keep privacy/data-use constraints across fallback; unknown metadata
must fail closed when the workflow requires a known property. Do not silently
move from known source-model data terms to weaker or unknown candidate terms. A
free price does not imply equal privacy or underlying economic tier. Never
replay arbitrary implementation tasks automatically, and do not persist a
model's failure state.

Sessions and event journals are held in memory by the `acp-mcp` process. A
server restart loses this bridge state. Loading an existing ACP session depends
on support from the underlying agent.

## OpenCode smoke test

After installing and authenticating OpenCode, opt in to the integration check
with `$env:ACPMCP_OPENCODE_TEST='1'; mise exec -- deno task test`. It launches
`opencode acp`, selects `opencode/longcat-2.5-preview-free` through the generic
ACP config option, and asks for a short response. The test is ignored by default
and uses the existing OpenCode login.
