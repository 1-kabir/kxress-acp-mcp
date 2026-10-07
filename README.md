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
not sandbox subprocesses. ACP permission policy controls permission responses;
`read_only` is the default and does not provide OS-level isolation.

Tools include `list_agents`, `start_session`, `load_session`, `get_session`,
`prompt`, `get_events`, `cancel_prompt`, `resolve_permission`,
`set_config_option`, `set_mode`, `list_sessions`, and `close_session`. A prompt
call accepts `wait` and `waitMs`; if it is still running at the wait limit, the
response includes its prompt ID. Use `get_events` with the session ID and
`afterSequence` cursor to read updates, or `cancel_prompt` to send ACP
cancellation. Raw ACP payloads and thought events are omitted from polling
results unless requested.

Inbound `session/update` notifications are intercepted at the public SDK stream
boundary before SDK notification validation. The bridge journals their original
params, including metadata and unknown update tags, while all other ACP traffic
continues through the SDK client.

`start_session` accepts arbitrary advertised config IDs through its `config`
object and an optional `modeId`. Config values are strings; boolean ACP options
use `"true"` or `"false"`. `permissionPolicy` defaults to `read_only`;
`operator` exposes requests through `get_session` and waits for
`resolve_permission`, while `allow_all` and `deny_all` apply advertised ACP
options. These policies rely on ACP permission requests and do not sandbox the
child process.

`load_session` starts a fresh agent process and calls `session/load` only when
the agent advertises that capability. Supply the original absolute working
directory along with the ACP session ID.

Sessions and event journals are held in memory by the `acp-mcp` process. A
server restart loses this bridge state. Loading an existing ACP session depends
on support from the underlying agent.

## OpenCode smoke test

After installing and authenticating OpenCode, opt in to the integration check
with `$env:ACPMCP_OPENCODE_TEST='1'; mise exec -- deno task test`. It launches
`opencode acp`, selects `opencode/longcat-2.5-preview-free` through the generic
ACP config option, and asks for a short response. The test is ignored by default
and uses the existing OpenCode login.
