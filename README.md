# acp-mcp

**Programmatic remote control and orchestration of ACP coding agents through
MCP.**

`acp-mcp` lets an MCP-capable host run and control ACP agents as structured
tools. A parent agent can discover models, start sessions, send prompts, inspect
events, change configuration, resolve permissions, cancel work, resume supported
sessions, and keep several downstream agents active at once.

```text
MCP host
   |
   v
acp-mcp
   |
   +----> ACP agent session ----> model/provider
   |
   +----> ACP agent session ----> model/provider
   |
   +----> ACP agent session ----> model/provider
```

`acp-mcp` is the bridge between MCP and ACP. It does not provide models,
credentials, or a sandbox.

## What it is for

The main use case is agent-to-agent delegation. A primary agent in Codex,
Claude, OpenCode, or another MCP-capable host can hand work to a different agent
without leaving its own workflow.

Typical uses include:

- investigating a bug with a second agent
- sending an implementation task to a better-suited model
- keeping a reviewer active while another agent implements
- running independent tasks in parallel
- using a provider or model the parent agent does not expose directly
- keeping a specialist session alive for follow-up work
- applying different model policies by repository or subdirectory

A shell command or headless CLI is enough for simple one-shot work, but it is a
weak control plane for longer interactions. Depending on the agent, headless
mode may expose fewer models, omit interactive configuration, make continuation
awkward, or reduce the interface to stdout.

`acp-mcp` uses the agent's ACP interface instead, so the host can work with
downstream agents as sessions rather than subprocess output:

```text
discover
-> create session
-> configure
-> prompt
-> inspect events
-> continue
-> cancel / close
```

The available models and capabilities still come from the downstream ACP
implementation. `acp-mcp` does not add features that the agent itself does not
expose.

## Quick start

The currently packaged release target is **Windows x86_64**. Releases are built
and installed locally from a source checkout; there are no hosted downloads or
package-manager releases yet.

From a source checkout:

```powershell
mise install
mise exec -- deno task release
mise exec -- deno task install --release-dir dist/releases/acp-mcp-0.2.0-windows-x86_64
```

The default install location is:

```text
%LOCALAPPDATA%\Programs\acp-mcp\acp-mcp.exe
```

Check the installation:

```powershell
acp-mcp --version
acp-mcp doctor
```

The installed executable is native and does not require Deno, mise, or the
source checkout at runtime.

Linux/WSL runtime has also been smoke-tested, including Codex hosting `acp-mcp`,
but there is currently no packaged Linux release.

### Register it with an MCP host

Running `acp-mcp` without arguments starts the MCP stdio server.

For Codex:

```toml
[mcp_servers.acp_mcp]
command = 'C:\Tools\acp-mcp\acp-mcp.exe'
args = []
```

The process hierarchy is:

```text
host
-> launches acp-mcp
-> acp-mcp launches ACP agents
```

The MCP host controls which environment variables are passed to `acp-mcp`.
Install and authenticate each downstream agent separately.

## Core workflows

### One-shot delegation

Use `run_task` for bounded work that should return one compact result.

Typical flow:

```text
parent agent
-> list_agents
-> list_models
-> run_task
-> use result
```

Good candidates include:

- "Investigate why this test flakes."
- "Review this diff and find correctness problems."
- "Implement this isolated module."
- "Compare these two approaches and report tradeoffs."

Conceptually:

```json
{
  "agentId": "antigravity",
  "task": "Review the failing test and propose the smallest correct fix.",
  "modelSize": "large",
  "thinkingEffort": "max",
  "cwd": "C:\\work\\my-project"
}
```

`run_task` uses the requested agent and model selection. It does not silently
retry another model, switch implementation, or change ACP protocol.

### Persistent sessions

Use managed sessions when the delegated work needs multiple turns, intermediate
events, configuration changes, explicit cancellation, permission handling, or
later follow-up.

```text
start_session
-> prompt
-> get_events
-> prompt
-> get_events
-> close_session
```

Other controls include `get_session`, `set_config_option`, `set_mode`,
`cancel_prompt`, `resolve_permission`, and `load_session`.

`acp-mcp` keeps up to eight managed sessions per server process. Bridge session
state and event journals are process-local. A downstream session may still be
resumable after restart when its ACP implementation supports resume.

Capabilities differ between ACP agents, so use live discovery instead of
assuming every agent supports every mode or configuration option.

### Parallel agents

Because each session is explicit, the parent can keep several agents active
independently and combine their results.

```text
Codex
  |
  +--> OpenCode session: implement backend change
  |
  +--> Claude session: review API design
  |
  +--> Antigravity session: investigate failing integration test
```

This works well when tasks are independent enough to run concurrently.

## Agents and model discovery

An **agent** is an ACP implementation that `acp-mcp` can launch. The model
selected inside that agent is a separate choice.

| Agent ID      | ACP implementation                      | Notes                                                         |
| ------------- | --------------------------------------- | ------------------------------------------------------------- |
| `opencode`    | OpenCode `opencode acp`                 | ACP v1                                                        |
| `codex`       | `@agentclientprotocol/codex-acp`        | ACP v1                                                        |
| `claude`      | Claude Agent ACP                        | ACP v1 by default; experimental v2 can be selected explicitly |
| `antigravity` | Selected Antigravity ACP implementation | Official Google implementation by default                     |

Use `list_agents` to inspect the effective agent definitions. Use `list_models`
to query the exact model and configuration surface currently advertised by a
live ACP agent:

```text
list_models
-> exact models/config currently advertised by that ACP
```

This matters because interactive, headless, and ACP interfaces can expose
different model catalogs or configuration surfaces.

> `acp-mcp` exposes what the ACP implementation exposes. It does not bypass
> restrictions inside that ACP implementation.

### Bring your own ACP agent

Built-in profiles are convenience presets. You can also register any stdio ACP
server in trusted home configuration or an exact `--config` file; no source
changes or provider-specific integration are needed.

```json
{
  "agents": {
    "my-agent": {
      "command": "my-acp-server",
      "args": ["--stdio"],
      "acpProtocol": "v1"
    }
  }
}
```

The custom agent appears in `list_agents`. `list_models` reads its live ACP
catalog, and `run_task` or the session tools use the same generic ACP path as
built-in profiles. `args` defaults to an empty array and the protocol defaults
to v1.

Project `.acp-mcp.json` files cannot introduce executable commands, arguments,
or environment values. They may apply model policy to a custom agent already
defined in trusted configuration.

## Antigravity implementations

The `antigravity` profile supports three explicit implementations.

| Selector   | Implementation                      | Use it when                                              |
| ---------- | ----------------------------------- | -------------------------------------------------------- |
| `official` | Google's `agy_acp_server`           | You want the official/default ACP path                   |
| `refined`  | `simonepri/refined-antigravity-acp` | You want the refined wrapper around the official backend |
| `agy`      | `shubzkothekar/antigravity-acp`     | You want the richer dynamic `agy` CLI model catalog      |

The default is `official`.

```json
{
  "agents": {
    "antigravity": {
      "implementation": "official"
    }
  }
}
```

Select refined:

```json
{
  "agents": {
    "antigravity": {
      "implementation": "refined"
    }
  }
}
```

Select the community `agy` adapter:

```json
{
  "agents": {
    "antigravity": {
      "implementation": "agy"
    }
  }
}
```

The tested `agy` path exposed a richer live catalog, including Opus on the
tested account. Availability depends on the current CLI, adapter, account, and
entitlements.

The pinned `agy` adapter invokes the CLI with `--dangerously-skip-permissions`.
ACP permission mediation therefore does not protect those operations, so this
implementation is intentionally opt-in.

## Configuration

The configuration filename is:

```text
.acp-mcp.json
```

Without `--config`, `acp-mcp` discovers configuration from the operation's
working directory:

```text
~/.acp-mcp.json
        |
        v
outer/.acp-mcp.json
        |
        v
repo/.acp-mcp.json
        |
        v
repo/subproject/.acp-mcp.json
```

More specific files override less specific ones.

Merge rules:

- objects merge recursively
- scalars replace earlier values
- arrays replace earlier arrays
- the nearest project config wins where it provides a value

On Windows, the home config is `%USERPROFILE%\.acp-mcp.json`. On POSIX it is
`$HOME/.acp-mcp.json`.

A session captures its effective configuration when it starts or loads. Editing
`.acp-mcp.json` affects new operations and sessions, not an already-running
session.

### Exact config mode

```text
acp-mcp --config <path>
```

With `--config`, only that file is loaded. The home file and project discovery
are skipped.

The old `%APPDATA%\acp-mcp\config.json` location is no longer implicit, but a
current-schema file there can still be selected explicitly with `--config`.

### Project config trust boundary

Repository `.acp-mcp.json` files can define project-safe policy such as:

- model defaults
- model allow/deny rules
- model-size mappings
- built-in Antigravity implementation selection

They cannot inject arbitrary `command`, `args`, or `env` values. Put launch
configuration in the trusted home config or an explicit `--config` file.

## Model policy

Different agents use unrelated model IDs. `acp-mcp` lets callers use stable
policy names over each agent's live catalog instead of hardcoding
provider-specific IDs everywhere.

Configuration follows the working directory, so the same MCP server can apply
different model defaults and restrictions by machine, repository, or
subdirectory.

### Model size

The normalized model-size values are:

```text
small
medium
large
xlarge
```

These are **configured family positions**, not universal capability rankings.

For example, you may choose to map:

```text
small  -> Haiku / Luna position
medium -> Sonnet / Terra position
large  -> Opus / Sol position
xlarge -> Fable / Astra position
```

`acp-mcp` does not infer these mappings from model names. You define them
explicitly.

### Thinking effort

The normalized effort values are:

```text
off
low
medium
high
xhigh
max
ultra
```

Effort is projected onto the normalized levels actually available for the
selected model. An exact level is used when available; otherwise the resolver
chooses the highest available level not above the request. If none is that low,
it uses the model's lowest available level. `off` means zero effort when
supported and otherwise the lowest available level.

Examples:

```text
Codex exposes through max:       ultra -> max
OpenCode model exposes through high: xhigh -> high
model has no off:                off -> lowest available level
available low, high:             medium -> low
```

Configured effort mappings are intersected with live ACP choices. `max` and
`ultra` are not special cases: they follow the same ordered projection as every
other request.

### Example: use Opus as `large`

```json
{
  "agents": {
    "antigravity": {
      "implementation": "agy",
      "models": {
        "allowedModels": ["claude-*", "gemini-*"],
        "deniedModels": ["gpt-oss-*"],
        "default": {
          "modelSize": "large",
          "thinkingEffort": "max"
        },
        "modelSizes": {
          "medium": {
            "modelsByThinkingEffort": {
              "low": "claude-sonnet-5-5-low",
              "medium": "claude-sonnet-5-5-medium",
              "high": "claude-sonnet-5-5-high"
            }
          },
          "large": {
            "modelsByThinkingEffort": {
              "low": "claude-opus-5-5-low",
              "medium": "claude-opus-5-5-medium",
              "high": "claude-opus-5-5-high"
            }
          }
        }
      }
    }
  }
}
```

If `claude-opus-5-5-high` is the highest configured `large` variant currently
advertised by the ACP, `large + max` resolves to that exact model.

If a mapped model is not advertised or is denied by policy, selection fails.
There is no hidden fallback to another model or size.

### Selection precedence

```text
explicit tool selection
-> configured default
-> downstream default
```

Allow/deny policy always applies.

## How it works

ACP and MCP cover different parts of the stack:

- **ACP** gives coding agents a structured session protocol.
- **MCP** gives a host a structured way to call tools.
- **acp-mcp** exposes ACP session control as MCP tools.

```text
                MCP
         +---------------+
         |               |
         v               |
   +-----------+         |
   |  acp-mcp  |         |
   +-----------+         |
     |       |           |
 ACP |       | ACP       |
     v       v           |
+---------+ +---------+  |
| agent A | | agent B |  |
+---------+ +---------+  |
     |           |        |
     v           v        |
  provider    provider    |
```

The parent host needs one MCP integration for `acp-mcp`, while downstream agents
are controlled through ACP.

## MCP tools

`acp-mcp` exposes 16 tools.

**Discovery**

- `list_agents`
- `list_models`

**One-shot delegation**

- `run_task`

**Sessions**

- `start_session`
- `load_session`
- `prompt`
- `get_events`
- `list_sessions`
- `get_session`
- `close_session`

**Configuration and control**

- `set_config_option`
- `set_mode`
- `cancel_prompt`
- `resolve_permission`

**Workspace recovery**

- `list_stale_workspaces`
- `cleanup_stale_workspaces`

## Doctor

```text
acp-mcp doctor
acp-mcp doctor --json
```

Doctor checks local configuration, effective config sources, agent definitions,
command/runtime prerequisites, protocol selection, and stale workspace state.

It runs locally and offline. It does not authenticate to providers, inspect
credentials, prove model entitlement, or contact providers simply to check
health.

## Claude Agent ACP through Codex

If Claude Agent ACP uses an externally configured Anthropic-compatible route,
Codex must explicitly forward the relevant environment variable names to its MCP
subprocess:

```toml
[mcp_servers.acp_mcp]
command = 'C:\Tools\acp-mcp\acp-mcp.exe'
args = []
env_vars = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
```

Do not put the secret values themselves in the Codex config.

## ACP versions

ACP v1 is the default and mature path.

ACP v2 is experimental and must be selected explicitly in trusted agent
configuration:

```json
{
  "agents": {
    "claude": {
      "acpProtocol": "v2"
    }
  }
}
```

There is no automatic v1/v2 retry.

## Important boundaries

- `acp-mcp` is a bridge, not a model provider.
- The live ACP advertisement is the source of truth for models and
  configuration.
- ACP children run with the launching user's OS privileges.
- `permissionPolicy: "read_only"` controls how `acp-mcp` answers ACP permission
  requests. It is **not** a filesystem or OS sandbox.
- Some downstream agents or adapters may act without asking ACP permission.
- Session events can contain prompts, paths, tool data, provider content, and
  other sensitive information.
- Provider credentials belong to the downstream agent or provider.
- There is no automatic model, implementation, or protocol fallback.
- SHA-256 verifies artifact integrity against a known hash; it does not
  authenticate the publisher.

## Development

The repository pins Deno 2.9.6 in `mise.toml`. Mise is development tooling only;
it is not a runtime dependency of the installed product.

```powershell
mise exec -- deno task check
mise exec -- deno task test
mise exec -- deno lint
mise exec -- deno fmt --check
mise exec -- deno task build
mise exec -- deno task release
```

Live compatibility tasks may consume provider quota:

```text
deno task compat <agent>
```

## Platform status

Packaged release:

- Windows x86_64

Runtime smoke:

- Windows
- native Linux under Debian 13 / WSL2
- Codex-hosted MCP under WSL2

Linux/WSL smoke validation does not currently provide a packaged Linux release
or establish support for other Linux distributions.
