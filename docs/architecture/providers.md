# Provider architecture

Web and mobile clients communicate with the server through Effect RPC over the authenticated
`/ws` WebSocket route. [`WsRpcGroup`](../../packages/contracts/src/rpc.ts) is the shared protocol
contract, and both client and server install Effect's JSON serialization layer.

RPC identities are grouped by domain. Examples include `server.getConfig`,
`server.refreshProviders`, `cloud.getRelayClientStatus`, `workers.list`, and
`orchestration.dispatchCommand`. Streaming RPCs such as `orchestration.subscribeShell` and
`orchestration.subscribeThread` carry live updates; there is no separate channel-and-sequence push
envelope.

Provider lifecycle actions enter through orchestration commands rather than a `providers.*` RPC
namespace. The server's `ProviderService` routes work through the provider adapter registry and
exposes one canonical provider event stream to orchestration.

Five built-in provider drivers are registered in
[`builtInDrivers.ts`](../../apps/server/src/provider/builtInDrivers.ts):

- Codex
- Claude
- Cursor
- Grok
- OpenCode

## Client transport

[`RpcSessionFactory`](../../packages/client-runtime/src/rpc/session.ts) owns one WebSocket Effect RPC
session attempt. The shared connection runtime prepares authenticated endpoints, owns retry policy,
and replaces sessions; application components do not construct transports or RPC clients.

## Server-side orchestration layers

Provider runtime events flow through queue-based workers:

1. **ProviderRuntimeIngestion** — consumes provider runtime streams, emits orchestration commands
2. **ProviderCommandReactor** — reacts to orchestration intent events, dispatches provider calls
3. **CheckpointReactor** — captures git checkpoints on turn start/complete and publishes internal
   synchronization receipts

All three use `DrainableWorker` internally and expose `drain()` for deterministic test
synchronization. `RuntimeReceiptBus` keeps those checkpoint milestones available to tests and
harnesses; its production layer intentionally does not retain or broadcast them.
