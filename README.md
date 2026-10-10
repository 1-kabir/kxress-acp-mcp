# acp-mcp

**Programmatic remote control for coding agents through ACP, exposed over MCP.**

`acp-mcp` lets an MCP-capable host control ACP-compatible coding agents as real,
stateful sessions.

A parent agent such as Codex, Claude, or OpenCode can discover available agents
and models, delegate work, inspect events, continue conversations, change
configuration, handle permission requests, cancel work, and keep several
downstream agents alive independently.

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

Each downstream agent talks to its own model or provider. `acp-mcp` provides the
control interface. It does not provide models, accounts, or provider
credentials.

## Why acp-mcp?

Calling another coding agent through a shell command works for simple cases, but
it throws away much of what an agent protocol can expose.

Headless CLI modes may:

- expose fewer models or configuration options
- use different defaults from the interactive or ACP interface
- make multi-turn continuation awkward
- flatten structured events into stdout
- provide limited session control

ACP gives coding agents a structured session protocol. MCP gives a host a
structured tool interface. `acp-mcp` connects the two.

That means a parent agent can treat another coding agent as a controllable,
long-lived worker instead of a one-shot subprocess.

The parent still decides what to delegate, when tasks should run, and whether
multiple agents should run concurrently. `acp-mcp` is a control plane, not a
scheduler.

## What can it do?

### Delegate a bounded task

Use `run_task` when you want to give another agent one job and receive one
compact result.

Good examples:

- investigate a flaky test
- review a diff for correctness problems
- implement an isolated module
- compare two technical approaches
- research an integration failure
- analyze a test suite

Typical flow:

```text
parent agent
  |
  +-> list_agents
  |
  +-> list_models
  |
  +-> run_task
  |
  +-> use result
```

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
switch implementations, models, or ACP protocol versions when the request fails.

### Keep an agent session alive

For work that needs multiple turns, start a managed session.

```text
start_session
  |
  +-> prompt
  |
  +-> get_events
  |
  +-> prompt
  |
  +-> get_events
  |
  +-> close_session
```

Managed sessions let the parent:

- send follow-up prompts
- inspect intermediate events
- change advertised configuration
- change modes
- resolve permission requests
- cancel an active prompt
- resume supported downstream sessions
- explicitly close work when finished

Use `run_task` when one request and one result are enough. Use a managed session
when the interaction itself matters.

`acp-mcp` keeps up to eight managed sessions per server process.

Bridge session state and event journals are process-local. A downstream session
may still be resumable after `acp-mcp` restarts if that ACP implementation
supports session resume.

### Run independent agents in parallel

Each managed session is independent, so the parent can coordinate several
specialists at once.

```text
Codex
  |
  +--> OpenCode session: implement backend change
  |
  +--> Claude session: review API design
  |
  +--> Antigravity session: investigate integration failure
```

This works best when the delegated tasks are independent enough to run
concurrently.

`acp-mcp` does not schedule or combine them automatically. The parent
orchestrator owns that logic.

## Supported agents

An **agent** is an ACP implementation that `acp-mcp` can launch.

The model selected inside that agent is a separate choice.

| Agent ID      | ACP implementation                      | Notes                                                   |
| ------------- | --------------------------------------- | ------------------------------------------------------- |
| `opencode`    | OpenCode `opencode acp`                 | ACP v1                                                  |
| `codex`       | `@agentclientprotocol/codex-acp`        | ACP v1                                                  |
| `claude`      | Claude Agent ACP                        | ACP v1 by default, experimental v2 available explicitly |
| `antigravity` | Selected Antigravity ACP implementation | Official Google implementation by default               |

Use `list_agents` to inspect the effective agent definitions.

Use `list_models` to ask a live ACP implementation what it currently exposes:

```text
list_models
  |
  +-> exact models and configuration currently advertised by that ACP
```

This matters because an agent's interactive UI, CLI mode, headless mode, and ACP
interface can expose different model catalogs or configuration options.

`acp-mcp` exposes what the downstream ACP implementation advertises. It cannot
bypass restrictions inside that implementation or invent models that it does not
expose.

## Quick start

### Download a release

The version-tagged release workflow builds native Windows x86_64 and Linux
x86_64 executables. Each GitHub Release includes both binaries, a SHA-256
sidecar, and a manifest for each target. The workflow publishes only when the
tag version matches `src/version.ts`, and publishes only if both native builds
and smoke tests pass.

Published downloads appear under
[GitHub Releases](https://github.com/kxress/acp-mcp/releases). SHA-256 lets you
compare the downloaded bytes with the published checksum; it does not
authenticate the publisher.

On Windows, download the `.exe`, optionally compare its hash with the `.sha256`
asset, then place it in a stable location. For example:

```powershell
$version = "0.2.1"
$artifact = ".\acp-mcp-$version-windows-x86_64.exe"
$expected = (Get-Content "$artifact.sha256").Split()[0]
$actual = (Get-FileHash $artifact -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "SHA-256 mismatch" }
$install = Join-Path $env:LOCALAPPDATA "Programs\acp-mcp"
New-Item -ItemType Directory -Force $install | Out-Null
Move-Item $artifact (Join-Path $install "acp-mcp.exe")
& (Join-Path $install "acp-mcp.exe") --version
```

Configure your MCP host to launch that executable. An absolute executable path
is the most predictable choice.

On Linux x86_64, download the binary and checksum, then install it in your user
bin directory:

```sh
version=0.2.1
sha256sum -c "acp-mcp-$version-linux-x86_64.sha256"
mkdir -p "$HOME/.local/bin"
install -m 0755 "acp-mcp-$version-linux-x86_64" "$HOME/.local/bin/acp-mcp"
"$HOME/.local/bin/acp-mcp" --version
```

The repository installer also accepts a directory containing the three
downloaded Linux release assets and installs by default to
`$HOME/.local/bin/acp-mcp`:

```sh
deno task install --release-dir ./acp-mcp-release-assets
```

This installer is repository tooling; the installed executable does not require
Deno. If `$HOME/.local/bin` is not on `PATH`, the installer reports that and
does not modify shell startup files.

The installed executable is native. Deno, mise, and the source checkout are not
required at runtime.

## Register with an MCP host

Running `acp-mcp` without arguments starts the MCP stdio server.

For Codex:

```toml
[mcp_servers.acp_mcp]
command = 'C:\Tools\acp-mcp\acp-mcp.exe'
args = []
```

The process hierarchy looks like this:

```text
host
  |
  +-> launches acp-mcp
        |
        +-> launches ACP agents
```

The MCP host decides which environment variables are inherited by `acp-mcp`.

Install and authenticate each downstream agent separately.

## MCP tools

`acp-mcp` exposes 16 MCP tools.

### Discovery

- `list_agents`
- `list_models`

### One-shot delegation

- `run_task`

### Sessions

- `start_session`
- `load_session`
- `prompt`
- `get_events`
- `list_sessions`
- `get_session`
- `close_session`

### Configuration and control

- `set_config_option`
- `set_mode`
- `cancel_prompt`
- `resolve_permission`

### Workspace recovery

- `list_stale_workspaces`
- `cleanup_stale_workspaces`

Capabilities vary between downstream ACP implementations. Discover what an agent
currently advertises instead of assuming every tool, mode, or configuration
option maps to every agent.

## Bring your own ACP agent

The built-in agent profiles are convenience presets. They are not a closed
integration list.

Any compatible stdio ACP server can be registered in trusted configuration:

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

The custom agent then participates in the same generic runtime path as the
built-in profiles:

```text
list_agents
list_models
run_task
start_session
...
```

`args` defaults to an empty array and `acpProtocol` defaults to `v1`.

Custom executable definitions belong in trusted home configuration or an
explicit `--config` file.

Repository configuration cannot introduce arbitrary commands, arguments,
environment variables, or ACP protocol definitions.

## Antigravity implementations

The `antigravity` profile supports three explicit implementations.

| Selector   | Implementation                      | Use when                                                 |
| ---------- | ----------------------------------- | -------------------------------------------------------- |
| `official` | Google's `agy_acp_server`           | You want the official/default ACP path                   |
| `refined`  | `simonepri/refined-antigravity-acp` | You want the refined wrapper around the official backend |
| `agy`      | `shubzkothekar/antigravity-acp`     | You want the richer dynamic `agy` CLI model catalog      |

The default is `official`.

### Official

```json
{
  "agents": {
    "antigravity": {
      "implementation": "official"
    }
  }
}
```

### Refined

```json
{
  "agents": {
    "antigravity": {
      "implementation": "refined"
    }
  }
}
```

### Community `agy` adapter

```json
{
  "agents": {
    "antigravity": {
      "implementation": "agy"
    }
  }
}
```

The tested `agy` path exposed a richer live model catalog, including Opus on the
tested account. Actual availability depends on the installed CLI, adapter
version, account, and entitlements.

The pinned `agy` adapter invokes the CLI with:

```text
--dangerously-skip-permissions
```

ACP permission mediation therefore does not protect those operations. The `agy`
implementation is intentionally opt-in.

## Configuration

Configuration uses:

```text
.acp-mcp.json
```

Without `--config`, configuration is discovered from the operation's working
directory.

Conceptually:

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

Merge behavior:

- objects merge recursively
- scalars replace earlier values
- arrays replace earlier arrays
- the nearest project configuration wins where it provides a value

Home configuration lives at:

```text
Windows: %USERPROFILE%\.acp-mcp.json
POSIX:   $HOME/.acp-mcp.json
```

A session captures its effective configuration when it starts or loads. Editing
`.acp-mcp.json` affects new operations and new sessions, not a session that is
already running.

### Exact config mode

Use:

```text
acp-mcp --config <path>
```

When `--config` is supplied, only that file is loaded. Home configuration and
project discovery are skipped.

The old location:

```text
%APPDATA%\acp-mcp\config.json
```

is no longer loaded implicitly, although a current-schema file there can still
be selected explicitly with `--config`.

## Project configuration trust boundary

Repository `.acp-mcp.json` files may define project-level policy such as:

- default model selection
- model allow and deny rules
- model-size mappings
- built-in Antigravity implementation selection

They cannot introduce or replace:

- `command`
- `args`
- `env`
- `acpProtocol`

Executable launch configuration belongs in trusted home configuration or an
explicit `--config` file.

This prevents entering a repository from implicitly trusting executable
definitions stored inside that repository.

## Model policy

Different agents expose unrelated model IDs.

`acp-mcp` lets callers work with normalized model sizes and thinking effort
instead of hardcoding provider-specific IDs throughout an orchestration layer.

Configuration follows the operation's working directory, so the same MCP server
can use different defaults and restrictions for different repositories or
subprojects.

### Model size

Normalized sizes are:

```text
small
medium
large
xlarge
```

These are configured family positions. They are not universal capability
rankings.

For example, a project could map:

```text
small  -> Haiku / Luna position
medium -> Sonnet / Terra position
large  -> Opus / Sol position
xlarge -> Fable / Astra position
```

`acp-mcp` does not infer these relationships from model names. You configure
them explicitly.

### Thinking effort

Normalized effort values are:

```text
off
low
medium
high
xhigh
max
ultra
```

The requested effort is projected onto the levels actually available for the
selected model.

If the exact level exists, it is used.

Otherwise, the resolver chooses the highest available level that does not exceed
the request. If no available level is that low, it uses the model's lowest
available level.

`off` means zero effort when the model supports it. Otherwise it resolves to the
lowest available effort.

Examples:

```text
Codex exposes through max:       ultra  -> max
OpenCode exposes through high:   xhigh  -> high
only medium, high available:     off    -> medium
only medium, high available:     low    -> medium
only medium, high available:     xhigh  -> high
only low, high available:        medium -> low
model has no off:                off    -> lowest available
available low, high:             medium -> low
```

Configured effort mappings are intersected with the model choices advertised by
the live ACP implementation.

`max` and `ultra` use the same ordered projection rules as every other level.

### Example: map Opus to `large`

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
advertised by the ACP implementation, `large + max` resolves to it.

If a mapped model is not advertised or is denied by policy, selection fails.

There is no hidden fallback to another model or size.

### Selection precedence

```text
explicit tool selection
  |
  v
configured default
  |
  v
downstream default
```

Allow and deny policy applies at every level.

## How it works

ACP and MCP cover different parts of the stack:

- ACP gives coding agents a structured session protocol.
- MCP gives a host a structured way to invoke tools.
- `acp-mcp` exposes ACP session control as MCP tools.

```text
              MCP
       +---------------+
       |               |
       v               |
  +-----------+        |
  |  acp-mcp  |        |
  +-----------+        |
     |       |         |
 ACP |       | ACP     |
     v       v         |
+---------+ +---------+|
| agent A | | agent B ||
+---------+ +---------+|
     |           |     |
     v           v     |
  provider    provider |
```

The parent host needs one MCP integration for `acp-mcp`. Downstream coding
agents are then controlled through ACP.

## Doctor

Run:

```text
acp-mcp doctor
acp-mcp doctor --json
```

Doctor checks:

- local configuration
- effective configuration sources
- agent definitions
- command and runtime prerequisites
- ACP protocol selection
- stale workspace state

Doctor runs locally and offline.

It does not:

- authenticate to providers
- inspect provider credentials
- prove model entitlement
- contact providers simply to perform a health check

## Claude Agent ACP through Codex

If Claude Agent ACP uses an externally configured Anthropic-compatible route,
Codex must explicitly forward the relevant environment variable names to the MCP
subprocess:

```toml
[mcp_servers.acp_mcp]
command = 'C:\Tools\acp-mcp\acp-mcp.exe'
args = []
env_vars = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
```

Do not put the secret values themselves in the Codex configuration.

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

## Security and operational boundaries

Keep these constraints in mind when using `acp-mcp`:

- `acp-mcp` is a bridge, not a model provider.
- The live ACP advertisement is the source of truth for models and
  configuration.
- ACP child processes run with the launching user's OS privileges.
- `permissionPolicy: "read_only"` controls how `acp-mcp` answers ACP permission
  requests. It is not a filesystem or OS sandbox.
- Some downstream agents or adapters may perform operations without requesting
  ACP permission.
- Session events may contain prompts, filesystem paths, tool data, provider
  content, and other sensitive information.
- Provider credentials belong to the downstream agent or provider.
- There is no automatic fallback between models, implementations, or ACP
  protocol versions.
- SHA-256 can verify an artifact against a known hash. It does not authenticate
  the publisher.

Treat downstream ACP agents with the same care you would give any local process
running under your account.

## Development

The repository pins Deno `2.9.6` in `mise.toml`.

Mise is development tooling only. It is not a runtime dependency of the
installed executable.

Common development commands:

```powershell
mise exec -- deno task check
mise exec -- deno task test
mise exec -- deno lint
mise exec -- deno fmt --check
mise exec -- deno task build
mise exec -- deno task release
```

Live compatibility checks are also available:

```text
deno task compat <agent>
```

Compatibility tasks may consume provider quota.

## Platform support

Packaged release targets:

- Windows x86_64
- Linux x86_64

Both targets use native executables and the same local release format. Linux is
also validated natively on Debian 13 / WSL2, including Codex-hosted MCP. The
GitHub release workflow builds Linux on Ubuntu; WSL2 is one tested Linux
environment, not a separate platform target. Other Linux distributions have not
been individually tested.

## License

Licensed under the [WTFPL, Version 2](LICENSE).
