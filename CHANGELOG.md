# Changelog

## 0.2.0 (unreleased)

### Breaking changes

- Rename the one-shot `delegate` MCP tool to `run_task` and its `prompt` input
  to `task`.
- Rename the `discover_models` MCP tool to `list_models`. No deprecated aliases
  are provided; update MCP callers and per-tool approval settings.
- Rename `run_task.timeoutMs` to `idleTimeoutMs`; it now limits consecutive
  silence rather than total task duration. `permissionLeaseMs` configures the
  separate operator handoff lease.

### Added

- Built-in Codex ACP adapter and first-party Antigravity ACP server profiles.
  `list_agents` now reports whether each profile's executable is present.
- `run_task` failures now include a compact generic error kind and stage, with a
  JSON-RPC code when the ACP agent provides one. Provider messages and raw
  diagnostics remain private; the bridge does not retry or switch models.
- Agent profiles may opt into compact semantic failure classification. The
  OpenCode classifier recognizes explicit rate-limit wording as a heuristic;
  generic ACP codes alone are never interpreted as provider conditions.
