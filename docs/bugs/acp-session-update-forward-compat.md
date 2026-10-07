# Bug report: unknown ACP `session/update` variants are rejected

## Summary

`acp-mcp` cannot currently preserve or forward an ACP `session/update` notification whose `update.sessionUpdate` discriminator is unknown to the pinned `@agentclientprotocol/sdk` 1.7.0 schema.

## Expected behavior

ACP update notifications with a valid session ID and an unrecognized update tag should remain opaque events. They should not close the ACP connection, and the event journal should retain the original params, including `_meta`.

## Observed behavior

The SDK's public `client()` app routes `session/update` through its built-in `SessionUpdateRouter`. That router runs `zSessionNotification.parse(message.params)` before the registered custom notification handler. The generated v1 update union rejects unrecognized tags, reports `Invalid params`, and closes or disrupts the connection. Registering `onNotification("session/update", parser, handler)` does not bypass that built-in router.

## Reproduction

Send a valid JSON-RPC notification over ACP stdio:

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"future_event_variant","detail":"example"}}}
```

With the SDK's normal agent-side `client.notify`, the same payload is rejected before transmission because the SDK validates known notification params. A raw fixture is therefore needed to reproduce the client-side failure reliably.

## Environment

- ACP protocol v1
- `@agentclientprotocol/sdk` 1.7.0
- Deno 2.9.6

## Investigation question

Is there a supported SDK extension point or configuration that disables/replaces the internal update router while keeping SDK-owned JSON-RPC framing, request correlation, and cancellation? If not, what public low-level SDK API should the bridge use to install a permissive notification parser without reimplementing JSON-RPC?

## Current impact

Known update variants are journaled with their raw notification params. Unknown variants remain a compatibility gap; the custom handler is not sufficient to make them forward-compatible.
