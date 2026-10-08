# Changelog

## 0.2.0 (unreleased)

### Breaking changes

- Rename the one-shot `delegate` MCP tool to `run_task` and its `prompt` input
  to `task`.
- Rename the `discover_models` MCP tool to `list_models`. No deprecated aliases
  are provided; update MCP callers and per-tool approval settings.

### Added

- `run_task` failures now include a compact generic error kind and stage, with a
  JSON-RPC code when the ACP agent provides one. Provider messages and raw
  diagnostics remain private; the bridge does not retry or switch models.
