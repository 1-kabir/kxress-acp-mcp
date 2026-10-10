# acp-mcp

acp-mcp exposes ACP-compatible coding agents through a common MCP interface. It
connects an MCP host such as Codex to a downstream agent such as OpenCode,
Codex ACP, Antigravity, or Claude Agent ACP:

```text
MCP host -> acp-mcp -> ACP agent -> model/provider
```

acp-mcp is the bridge; it does not provide models or agent credentials.

## Why use it?

MCP hosts can call tools, while ACP gives coding agents a common way to expose
sessions, models, and configuration. acp-mcp joins those interfaces so a host
can use supported ACP agents without a separate bespoke MCP integration for
each one.

You can discover the models an agent actually advertises, run a one-shot task,
or keep a session for multi-turn work, events, and configuration changes.
Project-level configuration can also set model policy for work in a repository.

## Quick start

The currently validated packaged target is Windows x86_64. Local release
artifacts are prepared by an operator; this repository does not publish hosted
downloads or package-manager releases.

For this project, a maintainer currently builds and installs the local Windows
artifact from a source checkout. The checkout's pinned toolchain is Deno 2.9.6
and mise:

```powershell
mise install
mise exec -- deno task release
mise exec -- deno task install --release-dir dist/releases/acp-mcp-0.2.0-windows-x86_64
```

This creates the validated bundle and installs it. The installer defaults to
`%LOCALAPPDATA%\Programs\acp-mcp\acp-mcp.exe` and accepts
`--destination <executable-path>` to choose another location. Close programs
using acp-mcp before updating it. The installer verifies the artifact checksum,
installed bytes, and version. It does not change PATH, user configuration, or
MCP host settings.

The installed native executable does not need Deno, mise, or a source checkout.
Once it is on the machine, check it with:

```powershell
acp-mcp --version
acp-mcp doctor
```

## Register an MCP host

Configure the host to start the installed executable over stdio. For Codex, a
direct registration can look like:

```toml
[mcp_servers.acp_mcp]
command = 'C:\Tools\acp-mcp\acp-mcp.exe'
args = []
```

Running `acp-mcp` without arguments starts the MCP server. Use the actual
executable path where you installed it. The host owns this registration,
starts acp-mcp, controls the environment passed to it, and decides which
returned tools are available to the agent. If the executable is on the host's
PATH, the command can be `acp-mcp`.

Install downstream agents separately. For example, the Codex adapter is
available as `@agentclientprotocol/codex-acp` on npm; Claude Agent ACP requires
Node.js 22+ and `@agentclientprotocol/claude-agent-acp`. The official Google
Antigravity ACP server is listed in the
[ACP Registry](https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp).

## Agents

An agent is the ACP implementation that acp-mcp launches. It is distinct from
the model selected by that agent. Built-in profiles currently include:

| Agent ID | What it launches | Notes |
| --- | --- | --- |
| `opencode` | OpenCode's `opencode acp` command | ACP v1 |
| `codex` | The `codex-acp` adapter | ACP v1; install with `npm install -g @agentclientprotocol/codex-acp` |
| `claude` | Claude Agent ACP | Node.js 22+; install `@agentclientprotocol/claude-agent-acp`; ACP v1 by default, v2 when explicitly selected |
| `antigravity` | A selected Antigravity ACP implementation | Official Google server by default; see below |

Install and authenticate downstream agents separately. Use `list_agents` to see
the effective configured profile and whether its command is available. Use
`list_models` to ask a live ACP agent what model choices it advertises.

## Antigravity implementations

The `antigravity` profile has three explicit implementations. Omit
`implementation` to keep the official Google server as the default.

| Selector | Implementation | What to expect |
| --- | --- | --- |
| `official` | Google's `agy_acp_server` | Default, official ACP baseline. Its advertised catalog can differ from the `agy` CLI catalog. |
| `refined` | `simonepri/refined-antigravity-acp` | Explicit wrapper around the official ACP backend; live validated with Gemini model choices and `thought_level`, but did not advertise Opus in the tested setup. |
| `agy` | `shubzkothekar/antigravity-acp` v1.2.0 | Explicit community adapter that uses the existing authenticated `agy` CLI. Opus was advertised and validated in the tested account/catalog. |

For example, put this in a trusted home config to select the community adapter:

```json
{
  "agents": {
    "antigravity": {
      "implementation": "agy",
      "env": {
        "AGY_BIN": "C:\\Tools\\agy.exe"
      }
    }
  }
}
```

The `agy` adapter is not official Google software. It uses the user's existing
`agy` authentication. The pinned adapter invokes `agy` with
`--dangerously-skip-permissions` and does not expose normal `agy` approval
requests through ACP, so acp-mcp cannot mediate those operations with
`permissionPolicy`. Choose it explicitly with that tradeoff in mind. Its live
catalog depends on the adapter, CLI, account, and entitlements; Opus is not
available to every account. acp-mcp uses the choices advertised by the selected
ACP implementation and does not merge in CLI-only models.
Its upstream warns that third-party tools using Antigravity personal OAuth may
violate Google's terms and could put the account at risk; review the
[Antigravity terms](https://antigravity.google/terms) before choosing it.

On Windows x86_64, provision the pinned adapter with
`mise exec -- deno task provision:antigravity-agy`. This installs the adapter
under `%LOCALAPPDATA%\acp-mcp\agents\antigravity-agy\1.2.0\` and verifies the
upstream release hash. Install the `agy` CLI separately and point `AGY_BIN` at
its executable.

Install the `refined` wrapper with
`npm install -g @simonepri/refined-antigravity-acp@1.4.2`. It requires Node.js
22+ and an installed official `agy_acp_server` executable. Configure its path with
`env.REFINED_AGY_ACP_BIN` in trusted configuration. The `official` and
`refined` implementations use the Google ACP backend; selecting one never
silently falls back to another.

## Configuration

The configuration filename is `.acp-mcp.json`. Without an explicit
`--config` argument, acp-mcp loads the home file and then discovers project
files from the operation's working directory up to the filesystem root:

```text
~/.acp-mcp.json
  -> /work/.acp-mcp.json
    -> /work/repo/.acp-mcp.json
      -> /work/repo/subproject/.acp-mcp.json
```

On Windows the home file is `%USERPROFILE%\.acp-mcp.json`; on POSIX it is
`$HOME/.acp-mcp.json`. Project files apply from outermost to nearest. Objects
merge recursively, scalar values replace earlier values, and arrays replace
earlier arrays. The nearest project file wins where it sets a value. An
operation's `cwd` determines project discovery; session configuration is
captured when that session starts or loads.

For example, a home file can set an exact default model, while a repository
file changes that default for the project. Replace these illustrative IDs with
IDs returned by `list_models`:

```json
{
  "agents": {
    "antigravity": {
      "implementation": "agy",
      "env": {
        "AGY_BIN": "C:\\Tools\\agy.exe"
      },
      "models": {
        "default": { "model": "exact-home-model-id" }
      }
    }
  }
}
```

`repo/.acp-mcp.json`:

```json
{
  "agents": {
    "antigravity": {
      "models": {
        "default": { "model": "exact-project-model-id" }
      }
    }
  }
}
```

Project files are useful for project policy and the closed built-in
Antigravity implementation selector. They cannot define or replace executable
`command`, `args`, or `env` settings. Put launch configuration in the trusted
home file, or pass an exact file with `--config`.

`acp-mcp --config <path>` uses exactly that file: it does not also load the
home file or discover project files. A missing or invalid explicit file is an
error. The same option is available to doctor.

## Model policy

Model names vary across agents. A project may want to choose a model family
position, restrict which advertised IDs can be used, or request a level of
thinking effort. These are configured per agent under `agents.<id>.models`.

### Model size

`small`, `medium`, `large`, and `xlarge` are user-configured model-family
positions. They are independent of thinking effort and are not a ranking of
quality, speed, cost, or capability.

For example, a user might map `small` to a Haiku or Luna model, `medium` to
Sonnet or Terra, `large` to Opus or Sol, and `xlarge` to Fable or Astra.
These are policy examples, not built-in name inference: acp-mcp does not assume
that a model containing `opus` is large. Each mapping must name an exact model
that the live ACP advertises.

### Thinking effort

The normalized values are `low`, `medium`, `high`, `xhigh`, `max`, and
`ultra`. The first four are concrete requests: if the selected model cannot
provide one, the request fails instead of silently lowering it. `max` and
`ultra` are saturating requests that resolve to the highest supported effort
for the selected model. If only low, medium, and high are available, both
resolve to high.

An ACP may expose effort as a separate config option, such as
`thought_level`, or encode it in separate advertised model IDs. Configure the
mapping to match that agent's live ACP surface.

### Example: Antigravity agy model policy

The following illustrates effort encoded in exact model IDs. It is a
user-provided policy example; the live ACP catalog remains authoritative.

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

With that mapping, `large` plus `max` resolves to the highest configured
variant that the live ACP advertises and policy allows. If the available
variants stop at `high`, the exact result is
`claude-opus-5-5-high`. If a mapped ID is not advertised or is denied, the
selection fails; acp-mcp does not try another size or model.

A separate-config-option mapping can be configured like this:

```json
{
  "agents": {
    "claude": {
      "models": {
        "thinkingEffort": {
          "configOption": "reasoning_effort",
          "values": {
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh"
          }
        }
      }
    }
  }
}
```

Change option and value strings to match the choices advertised by the selected
ACP. A concrete effort not present in both the mapping and live config is an
error.

### Selection and policy

Selection precedence is:

1. Exact `model` or `modelSize` supplied to a tool call.
2. The agent's configured `models.default`.
3. The downstream agent's own default, if no selector is configured.

An exact model and a model size cannot be supplied together. `allowedModels`
filters the live catalog when present; `deniedModels` then removes matching
IDs, so deny always wins. Patterns support exact IDs and simple case-sensitive
`*` wildcards. Explicit tool arguments do not bypass policy. There is no
automatic model fallback.

`list_models` reports advertised choices after policy filtering and marks the
effective configured default where it can be resolved. For a session, selection
and policy are resolved against that session's cwd and retained for its
lifetime. A later project-file edit affects new operations/sessions, not an
already running session. An explicit `set_config_option` call can still change
the downstream session configuration.

## One-shot tasks

Use `list_models` to inspect an agent's live choices, then call `run_task` for
one requested execution. For example:

```json
{
  "agentId": "antigravity",
  "task": "Review the failing test and suggest a minimal fix.",
  "modelSize": "large",
  "thinkingEffort": "max",
  "cwd": "C:\\work\\my-project"
}
```

`run_task` returns a compact final result. It does not retry another model,
implementation, or protocol. Use a session when you need to continue the
conversation, inspect updates, or control it interactively.

## Sessions

Sessions are for multi-turn work. A typical flow is:

```text
start_session
  -> prompt
  -> get_events
  -> prompt
  -> close_session
```

Use `get_session` to inspect state, `set_config_option` or `set_mode` when the
agent advertises those controls, `resolve_permission` for an operator policy,
and `cancel_prompt` to request ACP cancellation. `load_session` is available
when the downstream agent supports resume/load. Capabilities and config options
differ among agents, so use live discovery rather than assuming every agent
supports the same controls.

The server keeps up to eight active managed sessions in memory per process.
Restarting acp-mcp loses its in-memory session map and event journals; the
underlying agent session may still be loadable if that agent supports it.

## MCP tools

The server exposes 16 tools:

**Discovery:** `list_agents`, `list_models`

**One-shot:** `run_task`

**Sessions:** `start_session`, `load_session`, `prompt`, `get_events`,
`list_sessions`, `get_session`, `close_session`

**Configuration and control:** `set_config_option`, `set_mode`,
`cancel_prompt`, `resolve_permission`

**Workspace recovery:** `list_stale_workspaces`, `cleanup_stale_workspaces`

## Doctor

`acp-mcp doctor` checks local configuration, effective agent definitions,
command resolution, declared runtime prerequisites, selected ACP protocol, and
workspace state. It is local, offline, and secret-safe. Use
`acp-mcp doctor --json` for structured output, or
`acp-mcp doctor --config <path>` to inspect an exact trusted config file.

Doctor does not log in, inspect credentials, contact providers to test health,
or verify that a model is available to your account. It also cannot inspect an
MCP host's registration or predict what environment that host will pass to
acp-mcp.

## Important boundaries

- acp-mcp is a bridge, not a model provider. Downstream ACP model/config
  advertisements are the source of truth.
- ACP children run with the launching user's OS privileges. The stdio server
  trusts its launching host/user and adds no separate MCP authentication.
- `permissionPolicy: "read_only"` controls how acp-mcp answers ACP permission
  requests. It is not filesystem protection or an OS sandbox; an agent may act
  without asking for permission.
- Session events can contain user, assistant, tool, path, permission, and
  provider/agent content. They are caller-visible session data, not sanitized
  logs. Handle them accordingly.
- Model/provider credentials belong to the downstream agent and its provider.
  acp-mcp does not read credential files or provide authentication.
- There is no automatic model, implementation, or protocol fallback.
- SHA-256 checks a release artifact against a known hash; it does not prove who
  published that hash.

## ACP protocol versions

ACP v1 is the default and mature path. ACP v2 is experimental and must be
selected explicitly in trusted agent configuration with `"acpProtocol": "v2"`.
The selected protocol is not retried as another version if it fails, and the
downstream agent must support the chosen version.

## Development and platform status

The repository uses Deno and mise for development. For example:

```powershell
mise exec -- deno task check
mise exec -- deno task test
mise exec -- deno lint
mise exec -- deno fmt --check
mise exec -- deno task build
mise exec -- deno task release
```

`deno task compat <agent>` runs an explicit live compatibility test and may
use provider quota. Ordinary tests remain offline.

Packaged release target:
- Windows x86_64.

Runtime smoke:
- Windows and Linux/WSL.

Linux/WSL runtime validation does not mean a packaged Linux release is
available.
