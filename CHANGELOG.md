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
- The disposable planning script no longer selects a default agent or model. Use
  its live `models` and `configs` views, then pass exact `--agent` and `--model`
  values to `run`; the privacy policy is required and optional cost filters are
  session-selected.

### Added

- Add MCP tools to inspect stale disposable planning workspaces and explicitly
  delete eligible workspaces through the shared ownership- and age-checked
  cleanup implementation. The tools report workspace IDs rather than accepting
  arbitrary paths.
- Add a concise live-validated agent compatibility matrix and an explicit
  PowerShell-friendly runner for the existing opt-in live compatibility tests.
  Document the current ACP protocol-version audit; no ACP v2 client support is
  included.
- Add an explicit helper for unique disposable planning snapshots. It copies
  tracked working-tree contents and non-ignored untracked files without Git
  metadata, and documents that the snapshot is mutation containment rather than
  an OS sandbox. Add a planning CLI that checks live model/privacy metadata,
  uses fresh clones from one canonical snapshot for each explicitly selected
  candidate, and only retries an allowed rate-limit classification.
- Add compact, filtered, paged live model summaries and selected-model config
  inspection to the planning script. Candidate summaries preserve ACP order and
  never rank or select a model.
- OpenCode Zen and Go enrichment now covers provider-qualified advertised
  models, distinguishes current per-token price from subscription access and
  limited-time free status, adds the documented Jev paid-counterpart tier, and
  exposes source-backed privacy facts. Planning fallback guidance is bounded and
  remains in the ACP usage skill; `run_task` never routes or retries.
- Built-in Codex ACP adapter and first-party Antigravity ACP server profiles.
  `list_agents` now reports whether each profile's executable is present.
- Add the built-in Claude Agent ACP profile for the maintained adapter. The
  launch profile stays provider-neutral; live validation uses a user-configured
  OpenRouter route and does not establish a default model.
- Live validation confirmed Antigravity reuses its persisted ACP authentication
  across fresh server processes. Documentation covers the separate ACP auth
  selector and a stable user-local executable configured by absolute path. The
  opt-in compatibility test checks launchability and child termination without
  requiring zero exit status after a completed task.
- `run_task` failures now include a compact generic error kind and stage, with a
  JSON-RPC code when the ACP agent provides one. Provider messages and raw
  diagnostics remain private; the bridge does not retry or switch models.
- Agent profiles may opt into compact semantic failure classification. The
  OpenCode classifier recognizes explicit rate-limit wording as a heuristic;
  generic ACP codes alone are never interpreted as provider conditions.

### Changed

- Declare explicit read-only, destructive, idempotency, and open-world hints for
  every public MCP tool; these annotations describe behavior but do not enforce
  security policy.
- Clarify that `read_only` governs only ACP permission requests and is not a
  filesystem sandbox; deterministic coverage demonstrates that a fake ACP
  process can write directly without requesting permission.
