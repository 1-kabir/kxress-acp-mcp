# acp-mcp

A stdio MCP server that starts one ACP agent process per managed session. The first slice supports OpenCode by default and arbitrary local ACP executables through JSON configuration.

## Run

Install Deno 2.9.6, then run `deno task start`. Configure an MCP host to launch `deno task start` from this directory. The server writes protocol data only to stdout.

The default profile launches `opencode acp`; authenticate separately with `opencode auth login`.

## Agent configuration

Pass `--config <path>` to load an explicit JSON config. On Windows the default is `%APPDATA%\acp-mcp\config.json`; elsewhere it is `$XDG_CONFIG_HOME/acp-mcp/config.json` or `~/.config/acp-mcp/config.json`.

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

Configured agents run with the current user's OS permissions. The bridge does not sandbox subprocesses.

Tools include `list_agents`, `start_session`, `get_session`, `prompt`, `get_events`, `cancel_prompt`, `resolve_permission`, `set_config_option`, `set_mode`, `list_sessions`, and `close_session`. A prompt call accepts `wait` and `waitMs`; if it is still running at the wait limit, the response includes its prompt ID. Use `get_events` with the session ID and `afterSequence` cursor to read updates, or `cancel_prompt` to send ACP cancellation. Raw ACP payloads and thought events are omitted from polling results unless requested.

Inbound `session/update` notifications are intercepted at the public SDK stream
boundary before SDK notification validation. The bridge journals their original
params, including metadata and unknown update tags, while all other ACP traffic
continues through the SDK client.

`start_session` accepts arbitrary advertised config IDs through its `config` object and an optional `modeId`. Config values are strings; boolean ACP options use `"true"` or `"false"`. `permissionPolicy` defaults to `read_only`; `operator` exposes requests through `get_session` and waits for `resolve_permission`, while `allow_all` and `deny_all` apply advertised ACP options. These policies rely on ACP permission requests and do not sandbox the child process.

`load_session` starts a fresh agent process and calls `session/load` only when the agent advertises that capability. Supply the original absolute working directory along with the ACP session ID.

## OpenCode smoke test

After installing and authenticating OpenCode, opt in to the integration check with `ACPMCP_OPENCODE_TEST=1 deno task test`. It launches `opencode acp` and asks for a short response. The test is ignored by default and uses the existing OpenCode login.
