# acp-mcp

A generic stdio MCP server that starts one configured ACP agent process per
managed session. Built-in profiles cover OpenCode, Codex ACP, Antigravity, and
Claude Agent ACP; JSON configuration can define or override local ACP commands.

## Install and run

The product entrypoint is a self-contained native executable. End users need no
source checkout, Deno, or mise. Maintainers can prepare a validated local
release with the repository-pinned Deno toolchain:

```powershell
mise exec -- deno task release
```

This runs the offline checks, builds and smoke-tests the native executable
outside the checkout, then writes a versioned artifact, SHA-256 checksum, and
JSON manifest under `dist/releases/`. The manifest records the product version,
target, source commit, and artifact hash. SHA-256 lets you compare bytes with a
known checksum; it does not establish publisher identity. Artifacts are local
and are not published automatically. The project does not currently provide code
signing or another publisher-authentication mechanism.

To install or update the validated Windows artifact, use:

```powershell
mise exec -- deno task install --release-dir dist/releases/acp-mcp-0.2.0-windows-x86_64
```

By default, installation targets `%LOCALAPPDATA%\Programs\acp-mcp\acp-mcp.exe`.
Override the destination with `--destination C:\Tools\acp-mcp\acp-mcp.exe`. The
installer verifies the manifest and checksum, then verifies the installed hash
and version. It does not change user configuration, `PATH`, or MCP host
registration. Close programs using the executable before updating it.

Windows x86_64 is the currently validated release target. A target is supported
only after a native build, outside-checkout smoke test, and packaging run on
that target. Other platforms are not currently claimed as release targets.

For development, maintainers can still build without packaging:

```powershell
mise exec -- deno task build
```

On Windows this creates `dist\acp-mcp.exe`; it is a checkout build artifact, not
a stable installed location. To install a separately validated artifact, use the
local install task above. The executable bundles its runtime.

Running `acp-mcp` starts the MCP stdio server. Use `acp-mcp --help` for the
small command-line interface or `acp-mcp --version` for its version. Run
`acp-mcp doctor` for offline checks of local config, agent executables, runtime
prerequisites, and disposable workspace state; `acp-mcp doctor --json` emits a
machine-readable, secret-safe report. Doctor does not start ACP agents, contact
providers, consume quota, or verify provider authentication. Its stale-workspace
summary does not inspect creator processes; it reports age-qualified workspaces
with unknown creator status separately. MCP protocol traffic stays on stdout;
startup errors go to stderr. The server closes managed ACP sessions when its
host closes stdin or sends SIGINT.

Doctor returns exit code `0` when there are no errors (warnings are allowed),
`1` when local diagnostic errors are found, and `2` for invalid CLI usage. It
does not delete stale workspaces. Use the MCP tools `list_stale_workspaces` and
`cleanup_stale_workspaces` to inspect and explicitly remove eligible leftovers.

The home configuration is `%USERPROFILE%\.acp-mcp.json` on Windows and
`$HOME/.acp-mcp.json` on POSIX. An MCP host can launch the installed command
directly:

The stdio server trusts the host and user that launch it; acp-mcp does not add a
separate MCP authentication or authorization layer. The host owns its server
registration, whether it starts acp-mcp, the environment passed to it, and
whether returned tools are exposed to the coding agent. If connected tools are
missing, check the host registration and startup status; `doctor` cannot inspect
third-party host configuration or predict the environment a future host process
will pass.

### Codex registration

Register the executable with the Codex CLI:

```powershell
codex mcp add acp_mcp -- acp-mcp
```

This adds a global stdio entry to Codex's `config.toml` and leaves other MCP
servers intact. The entry is equivalent to:

```toml
[mcp_servers.acp_mcp]
command = "acp-mcp"
args = []
```

Codex starts the server on demand. If the install directory is not on the host's
PATH, set `command` to the absolute executable path. Pass `--config <path>` in
`args` to use an explicit acp-mcp config file.

### Repository development

The Deno tasks are for maintainers working from a source checkout: `build`
produces the standalone executable, `check` and `test` validate the source, and
`compat <agent>` explicitly runs provider-backed live compatibility tests. The
planning scripts under `scripts/` are source-checkout utilities, not installed
product commands.

When the default user config is absent, the built-in `opencode` profile is
available and launches `opencode acp`; authenticate separately with
`opencode auth login`. This is one built-in integration in the generic bridge.

Built-in agent IDs use their canonical ACP launch paths:

- `opencode` starts OpenCode's native `opencode acp` mode.
- `codex` starts the maintained `codex-acp` adapter. Install it globally with
  `npm install -g @agentclientprotocol/codex-acp`. To use the documented
  one-shot route, configure `command: "npx"` and
  `args: ["-y", "@agentclientprotocol/codex-acp"]`; this may download the
  package when first run. The adapter bundles a compatible Codex CLI by default
  and supports `CODEX_PATH` when you want to select another executable.
- `claude` starts the
  [maintained Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp),
  powered by the official Claude Agent SDK. Install Node.js 22 or later and
  install the upstream adapter with
  `npm install -g @agentclientprotocol/claude-agent-acp`. The built-in profile
  launches `claude-agent-acp`; generic `agents.claude.command`, `args`, and
  `env` overrides support user-local installations and external provider
  configuration. Provider authentication, endpoint, and model remain user
  configuration. The profile does not choose billing or require an Anthropic
  subscription; the adapter still needs a supported provider configuration. Use
  `list_models` before selecting an exact model; there is no preferred Claude
  model in `acp-mcp`. The adapter can use providers compatible with the Claude
  Agent SDK, but this does not establish compatibility with every provider/model
  combination. Live validation used a user-configured OpenRouter route.
- `antigravity` starts Google's separate first-party ACP server. Install it from
  the
  [ACP Registry](https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp);
  on Windows the binary is `agy_acp_server.exe`. Put it on `PATH` or configure
  its absolute path. This remains the default Antigravity implementation and the
  official ACP baseline.
- The same profile can explicitly select the independent refined wrapper with
  `"implementation": "refined"`; `list_agents` and doctor identify the chosen
  implementation. Install Node.js 22+ and the wrapper with
  `npm install -g @simonepri/refined-antigravity-acp@1.4.2`, then set
  `env.REFINED_AGY_ACP_BIN` to an existing official `agy_acp_server` executable.
  The wrapper can download its Google backend when that setting is omitted;
  acp-mcp requires a resolvable executable setting before launching it, so
  normal acp-mcp startup does not provision the backend. The wrapper uses the
  official ACP process for authentication and model execution; its own
  ACP-advertised models/config are passed through without acp-mcp additions. It
  does not make Opus available unless it advertises it.

- The `"implementation": "agy"` selection uses the pinned
  [shubzkothekar/antigravity-acp](https://github.com/shubzkothekar/antigravity-acp)
  Windows x64 v1.2.0 adapter (revision
  `d10aa13c932236ef241863f2c8b3afdda2a2be12`), which drives the existing `agy`
  CLI. Run the explicit provisioning task below to verify the upstream release
  SHA-256 and install the adapter under
  `%LOCALAPPDATA%\acp-mcp\agents\antigravity-agy\1.2.0\`. It does not install or
  change `agy` or its authentication. Set `env.AGY_BIN` to the absolute path of
  an existing `agy.exe`; config values do not expand environment-variable
  placeholders. The adapter is v1-only in this profile. It dynamically discovers
  and advertises models. In the tested account and adapter version, ACP
  advertised 18 choices including `claude-opus-5-5-high`; availability depends
  on the installed CLI, account, and entitlement. acp-mcp does not add models.
  The adapter invokes `agy` with `--dangerously-skip-permissions`, so its
  actions are not mediated by ACP permission requests and `permissionPolicy`
  cannot gate those actions. The adapter's upstream README warns that
  third-party tools accessing Antigravity with personal OAuth may violate
  Google's terms and could lead to account suspension or termination; review the
  [current Antigravity terms](https://antigravity.google/terms) before choosing
  this implementation. It is an explicit community-adapter trust and account-
  risk choice, not official Google software.

Select refined explicitly in `%USERPROFILE%\.acp-mcp.json` (replace the
placeholder with the actual absolute executable path; config paths do not expand
environment variables):

```json
{
  "agents": {
    "antigravity": {
      "implementation": "refined",
      "env": {
        "REFINED_AGY_ACP_BIN": "C:\\Tools\\Antigravity ACP\\agy_acp_server.exe"
      }
    }
  }
}
```

Select the agy-backed implementation explicitly (replace the `AGY_BIN`
placeholder with the absolute path to the existing CLI executable):

```json
{
  "agents": {
    "antigravity": {
      "implementation": "agy",
      "env": {
        "AGY_BIN": "C:\\Tools\\Antigravity CLI\\agy.exe"
      }
    }
  }
}
```

All profiles use the same acp-mcp session, configuration, timeout, permission,
event, and cleanup path. Downstream implementations can still transform ACP
traffic or advertise different capabilities. Custom ACP stdio commands work
without a built-in profile. `list_agents` includes `commandFound` to report
whether the configured executable is present; it does not check authentication
or provider access.

### Compatibility status

This table distinguishes established live evidence from implementations that
have not yet been live validated through acp-mcp. Live evidence records
demonstrated compatibility, not current installation or provider availability;
check `list_agents` for local command availability. Arbitrary configured ACP
agents remain supported by the generic launch/session path, but are not implied
to be live validated here.

| Agent                                                                                             | Built-in profile                | Live evidence                                                                                                                                                                                                                                                                                                                                           | Protocol evidence                                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [OpenCode](https://opencode.ai/docs/cli/acp/)                                                     | Yes                             | OpenCode 2.0.18, v1: `run_task`, advanced sessions, config, load/resume, cleanup. A controlled write occurred without an ACP permission request.                                                                                                                                                                                                        | v1 currently live validated; v2 unconfirmed                                                      |
| [Codex ACP](https://github.com/agentclientprotocol/codex-acp)                                     | Yes                             | Adapter 2.1.1, v1: `run_task`, advanced sessions, cancellation, cross-session isolation, load/resume, cleanup. Legacy `set_mode` changed state without `current_mode_update`; mode config was observable.                                                                                                                                               | v1 currently live validated; v2 unconfirmed                                                      |
| [Antigravity official](https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp) | Yes (`antigravity`, default)    | ACP 1.3.0, v1: `run_task`, advanced sessions, permission denial, load/resume, cleanup. Tested `oauth-personal` ACP auth path advertised 11 Gemini choices; `agy` CLI 1.3.2 showed a broader 18-choice catalog. Version/auth sensitive.                                                                                                                  | v1 currently live validated; v2 unconfirmed                                                      |
| [Antigravity refined](https://github.com/simonepri/refined-antigravity-acp)                       | Yes (`implementation: refined`) | Wrapper 1.4.2 / source `7590d40d170b18dbd66338514e42e08e63bae072`; raw ACP and installed acp-mcp v1 validation passed. Four Gemini choices; no Opus in the tested catalog.                                                                                                                                                                              | v1 currently live validated; capabilities depend on wrapper/backend advertisement                |
| [Antigravity agy](https://github.com/shubzkothekar/antigravity-acp)                               | Yes (`implementation: agy`)     | Adapter 1.2.0 / source `d10aa13c932236ef241863f2c8b3afdda2a2be12`; v1 live validated. Tested ACP advertised 18 choices including Opus; `run_task`, multi-turn continuity, model switch, resume, cancellation, and cleanup passed. Adapter uses `--dangerously-skip-permissions`; personal OAuth use carries the upstream-documented account/terms risk. | v1 currently live validated; cancellation observed; ACP permission mediation is bypassed         |
| [Claude Agent ACP](https://github.com/agentclientprotocol/claude-agent-acp)                       | Yes                             | Adapter 0.88.0: direct installed runs validated v1 and experimental v2 through one external provider route. In one host-launched setup discovery worked but session creation did not; the route was ineffective and the failing process hop was not observable.                                                                                         | v1 direct-process live validated; v2 experimental/route-specific; host-launched route unresolved |

ACP protocol versions are the `protocolVersion` selected during `initialize`;
they are unrelated to an agent or package's software version. The bridge
supports ACP v1 and the experimental ACP v2 draft through separate protocol
drivers. ACP v1 is the mature/default path. ACP v2 and the SDK's v2 entrypoint
may change incompatibly. The table records agent evidence, not just bridge
capability: Claude v2 was exercised end to end against one externally configured
provider route. This does not establish compatibility with other provider/model
combinations. The Claude adapter exposes an upstream experimental v2 mode; the
bridge enables it only when Claude is explicitly configured for v2. ACP v2
remains a draft.

Protocol selection is per agent in `%USERPROFILE%\.acp-mcp.json` on Windows or
`$HOME/.acp-mcp.json` on POSIX. Omitted `acpProtocol` means `v1`, preserving the
existing default. For example:

```json
{
  "agents": {
    "claude": {
      "acpProtocol": "v2"
    }
  }
}
```

Claude's built-in profile supplies its documented v2 opt-in environment setting
when selected. Custom ACP agents may also set `acpProtocol` to `"v1"` or `"v2"`.
The bridge uses only the configured protocol: it does not retry or silently fall
back when initialization fails. `acp-mcp doctor` reports the local selection and
executable availability, but does not prove that the agent supports or accepts
that protocol.

ACP agents differ in their model/config catalogs, modes, permission requests,
and load/resume support. Use live discovery and advertised capabilities rather
than assuming parity between profiles. Codex as an MCP host is distinct from the
downstream Codex ACP agent represented by the `codex` profile.

### Live compatibility tests

`deno task test` runs offline/deterministic tests and does not start real
agents. To explicitly run an opt-in live test, use the PowerShell-friendly
runner:

```powershell
mise exec -- deno task compat antigravity
mise exec -- deno task compat claude
mise exec -- deno task compat claude --protocol v2
```

Targets are `opencode`, `codex`, `antigravity`, and `claude`. Invoke one target
at a time. These tests launch the selected local agent and may require provider
credentials or use quota/API billing. No target (or `--help`) prints usage and
does not contact a provider. A missing executable or a real integration failure
returns a nonzero exit status; see the relevant setup section above.

For repository planning with Claude or another ACP agent, discover models and
configuration through the host-connected `acp-mcp` MCP tools, then use a
disposable workspace when relative writes should not touch the checkout. The
repository planning scripts documented below are a deliberate source-checkout
workflow using a separate local bridge path; they do not represent or replace
the host-connected service. If its MCP tools are unavailable, report that and
skip optional delegated planning rather than launching another bridge. A
disposable workspace is not an OS sandbox.

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

### Antigravity ACP installation on Windows

#### Provision the agy-backed community adapter

Run:

```powershell
mise exec -- deno task provision:antigravity-agy
```

#### Install the official Google ACP server

Download the Windows archive listed by the official
[ACP Registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)
and extract the entire archive in a user-local directory such as
`%LOCALAPPDATA%\acp-mcp\agents\antigravity\<version>\`. Keep
`localharness_external.exe` alongside `agy_acp_server.exe`; the server needs
both. Then configure `agents.antigravity.command` in
`%USERPROFILE%\.acp-mcp.json` to the absolute path of `agy_acp_server.exe` and
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

For the refined implementation, install the upstream npm package separately and
configure `agents.antigravity.implementation` as `"refined"`. Keep the official
server and its `localharness_external.exe` together in their existing
installation directory, and point `REFINED_AGY_ACP_BIN` at that server through
the profile's `env` map. Do not run the wrapper's editor `setup` command for
acp-mcp; acp-mcp does not install or update either component. The wrapper passes
ACP authentication, permission, session, and cancellation traffic to the
official server and adds fixes around that ACP stream. Upstream currently
documents Windows support and Node.js 22+; use live ACP discovery for models,
config, modes, and resume support.

For the `agy` implementation, run the explicit Windows x64 provisioning task
above, keep the official Google server installation untouched, and configure
`agents.antigravity.implementation` as `"agy"` with `env.AGY_BIN` pointing to
the existing `agy.exe`. The community adapter is pinned to v1.2.0 and is not
downloaded during normal MCP startup. It supports ACP v1 and advertises its
dynamic catalog after session startup. In live testing, `session/cancel`
canceled an active prompt and stopped its `agy` child; behavior may change with
future adapter versions. The adapter does not relay `agy` approvals as ACP
permission requests. Its upstream project warns that third-party Antigravity
OAuth use may violate Google's terms and risk account suspension or termination.
This is a community integration, not an official Google implementation. The
explicit selector values are `official` (default), `refined`, and `agy`; acp-mcp
does not switch implementations automatically or merge their model catalogs.

## Agent configuration

Without `--config`, acp-mcp loads `~/.acp-mcp.json` (Windows:
`%USERPROFILE%\.acp-mcp.json`) and then discovers `.acp-mcp.json` files from the
operation's working directory up to the filesystem root. Project files are
applied outermost to nearest, so the nearest project setting wins. Objects merge
recursively, arrays replace, and scalars replace. The home file is not applied
twice if it is also an ancestor. Missing files are optional; built-in profiles
remain available.

The effective project context is resolved for each operation that accepts a
`cwd` (`run_task`, session creation/load, `list_models`, and `list_agents`). If
omitted, the MCP process cwd is used. A managed session keeps the configuration
resolved when it was created or loaded; edits affect later operations/sessions.

Pass `--config <path>` for deterministic exact-file configuration. This loads
only that file: home and project discovery are disabled. A missing or invalid
explicit file is an error and never falls back.

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

Known agent fields are validated with field-specific errors. Unknown fields are
currently allowed for forward-compatible configuration; they do not add behavior
unless acp-mcp or that profile consumes them.

Home and explicit configs are trusted launch configuration sources and may
define executable, arguments, and environment. Auto-discovered project configs
are restricted to model policy and closed built-in implementation choices such
as Antigravity `official`, `refined`, or `agy`; they cannot set `command`,
`args`, or `env`. This prevents opening a repository from launching an arbitrary
project-selected executable.

### Model policy

Per-agent policy uses exact live ACP model IDs and simple `*`/`?` patterns.
`allowedModels` limits the advertised catalog when present; `deniedModels`
subtracts from it and always wins. An explicit model request cannot bypass these
rules. If no configured default exists, acp-mcp leaves the downstream-selected
model unchanged. It never invents models, silently switches models, or retries
another choice.

An exact `default.model` or abstract `default.modelSize` can be configured; the
two are mutually exclusive. An MCP request's exact `model` or `modelSize`
overrides that selector, and request `thinkingEffort` overrides the configured
default effort. Policy filtering still applies. The generic `set_config_option`
tool also enforces allow/deny policy when changing a model.

`modelSize` is a user-configured family-position abstraction with exactly four
values: `small`, `medium`, `large`, and `xlarge`. It is independent of thinking
effort and is not a capability, quality, speed, or cost ranking. For example, a
user may map Claude Haiku/Sonnet/Opus/Fable or OpenAI Luna/Terra/Sol/Astra to
those positions; the runtime does not infer mappings from names.

Normalized `thinkingEffort` values are `low`, `medium`, `high`, `xhigh`, `max`,
and `ultra`. Concrete requests fail if unsupported. `max` and `ultra` saturate
at the highest effort advertised for the selected model. For effort-encoded
model IDs, configure each exact variant explicitly. No model-size candidate
lists or hidden fallback are supported.

For downstreams that expose effort separately, map normalized values to the
advertised ACP config option and values, for example:

```json
{
  "thinkingEffort": {
    "configOption": "thought_level",
    "values": { "low": "low", "medium": "medium", "high": "high" }
  },
  "modelSizes": {
    "large": { "model": "opus", "maxThinkingEffort": "high" }
  }
}
```

Only values present in the live ACP advertisement can be selected. `max` and
`ultra` cap at the highest mapped and currently advertised effort; a concrete
unsupported effort returns an error.

Example for the `agy` Antigravity ACP, whose adapter advertises exact
effort-suffixed IDs (availability depends on the current ACP catalog and account
entitlement):

```json
{
  "agents": {
    "antigravity": {
      "implementation": "agy",
      "models": {
        "allowedModels": ["claude-*", "gemini-*"],
        "deniedModels": ["gpt-oss-*"],
        "default": { "modelSize": "large", "thinkingEffort": "max" },
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

Project configs can inherit home model-size mappings and override only a
specific default. For example, a repository `.acp-mcp.json` can set
`agents.antigravity.models.default` to
`{ "modelSize": "medium",
"thinkingEffort": "high" }`; a nested project dotfile
can set it to `{ "modelSize": "large", "thinkingEffort": "ultra" }`. The more
specific project selector wins while inherited mappings remain in effect.
Claude-family users commonly map small/medium/large/xlarge to
Haiku/Sonnet/Opus/Fable; OpenAI-family users may map them to
Luna/Terra/Sol/Astra. These are user policy examples, not names inferred by
acp-mcp.

Configured agents run with the current user's OS permissions. The bridge does
not sandbox subprocesses. ACP permission policy controls responses to
`session/request_permission`; it does not intercept ordinary tool calls or
provide OS-level isolation. By default, `read_only` allows requested
agent-reported `read`, `search`, `fetch`, and `think` kinds and rejects other
requested kinds. ACP agents may perform actions without requesting permission,
so `read_only` does not guarantee that a task cannot modify files.

ACP children run with the launching user's OS privileges; acp-mcp does not
privilege-drop or sandbox them. The stdio transport has no separate acp-mcp
caller authentication, so access is governed by the launching host and user.
Advanced session results intentionally expose ACP agent/provider content when
requested. `get_events` may contain user or assistant text, tool details, paths,
permission context, and agent/provider metadata; requesting raw events exposes
the original ACP envelope. Treat these as potentially sensitive content rather
than sanitized diagnostic logs. acp-mcp does not add child environment values to
event journals. Child stderr is drained internally for bounded diagnostics; it
is not prompt activity, journal content, or forwarded in startup errors.

For a built-in profile, configured `command` and `args` replace its launch
values. Configured `env` entries override same-named inherited or profile
values; other parent environment variables remain inherited. The built-in
profile's protocol metadata is retained, and `acpProtocol` selects its protocol
explicitly.

The `run_task` tool may send its task and repository content read by the ACP
agent to that agent's configured model provider. `read_only` does not keep
repository data local, restrict network access, or sandbox the child process.
Codex and other MCP hosts continue to apply their own approval and security
policies. See the
[ACP permission request protocol](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission)
for the agent's permission-request behavior.

For a deliberate source-checkout planning workflow, use the repository script
from PowerShell. It creates its own local bridge path and is intended for
maintainer orchestration/testing; its discovery results are not the catalog of
an already-connected host MCP service. For normal agent workflows, use the
connected `list_models` and config discovery tools instead. If they are
unavailable, do not use this script as a substitute. When choosing the
source-checkout workflow deliberately, first discover that local workflow's
candidates with a required privacy and cost policy:

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
primitive and uses exactly its supplied `cwd` for both the ACP session and
launched process.

#### Stale workspace recovery

Normal planning workflows remove their snapshots immediately. A hard crash may
leave product-owned workspaces behind. Use `list_stale_workspaces` to inspect
eligible candidates (24-hour age threshold by default), then call
`cleanup_stale_workspaces` when you want to remove all currently eligible
workspaces. Both tools accept an optional `olderThanMs` threshold. Recent or
active workspaces and entries without a valid ownership manifest are preserved;
the tools do not accept arbitrary paths or scan/stop agent processes.

`run_task.idleTimeoutMs` defaults to 10 minutes and limits consecutive silence
from the task's ACP session. Any inbound `session/update` for that session
resets it, including update variants this bridge does not recognize. Active
tasks can run longer than 10 minutes; there is no absolute runtime limit. MCP
request cancellation still cancels the task immediately. For
`permission_required` handoffs, `permissionLeaseMs` (default 2 minutes) controls
how long the session remains available for operator resolution; after the
handoff, that lease owns the session lifecycle.

ACP initialization, session creation/resume, and startup configuration have a
separate 30-second bound before a managed session is created. `close_session`
cancels an active prompt before closing the agent session; the close RPC is
bounded at 5 seconds before process cleanup continues. A graceful MCP stdio
disconnect closes managed sessions. Forced server termination is not a
cross-platform child-cleanup guarantee.

The `cwd` supplied to `run_task`, `start_session`, or `load_session` is used
both as the ACP session working directory and as the launched agent process's
working directory. Agent profiles cannot silently override it.

ACP updates for the active session and ACP permission requests count as task
activity. The bridge does not use arbitrary subprocess stderr as a heartbeat.

The MCP API currently exposes 16 tools: `run_task`, `list_models`,
`list_agents`, `list_stale_workspaces`, `cleanup_stale_workspaces`,
`start_session`, `load_session`, `get_session`, `prompt`, `get_events`,
`cancel_prompt`, `resolve_permission`, `set_config_option`, `set_mode`,
`list_sessions`, and `close_session`. Use `run_task` for one-shot work. Use
explicit session tools for multi-turn conversations, manual permission handling,
or event inspection. A prompt call accepts `wait` and `waitMs`; if it is still
running at the wait limit, the response includes its prompt ID. Use `get_events`
with the session ID and `afterSequence` cursor to read updates, or
`cancel_prompt` to send ACP cancellation. Raw ACP payloads and thought events
are omitted from polling results unless requested.

The bridge supports up to eight active in-memory sessions per server process.
Closing or failing a session releases capacity. A server restart loses the
bridge's session map and journals; an underlying ACP session may still be
loadable when that agent supports `session/load`.

Each MCP tool advertises effect and open-world annotations to help hosts decide
how to present or gate calls. These are behavioral hints, not security controls
or a sandbox; host approval policies and the tool implementation remain
authoritative.

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
is a generic one-shot ACP task operation that can also support subagent-style
workflows. Request `allow_all` explicitly when needed. With `operator`, a
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

For repository planning where relative writes should not affect the real
checkout, use the disposable planning workflow described above. Direct
`run_task` against a real checkout is also valid when the caller explicitly
accepts that execution environment. In either case, use `list_models` when the
exact model/config selection needs live validation and give the ACP agent a
concise task rather than pasting repository contents unless you intend to send
them to its configured provider.

Review the host's approval prompt for external ACP calls and approve the
invocation if appropriate. The host's approval flow remains the boundary for
starting the external agent.

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
