<!-- docs/architecture/providers.md -->
<!-- describes provider adapters, durable runtime admission, and orchestration consumers -->

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
durably admits canonical provider events before any state-changing orchestration consumer sees
them. Its process-local event stream remains only a compatibility/observability surface.

Durable provider-session identity is the provider kind, provider instance, thread, and logical
session generation captured when that adapter lifecycle began. Migration 61 requires the exact
provider kind when it creates a generation, and migration 66 makes that kind immutable; there is no
sentinel or backfill state. ProviderService validates an event's origin before admission and never
assigns a delayed event to whichever generation is current at receipt time.

Every settings-driven registry mutation is likewise mediated by ProviderService. Removal or
replacement first marks the instance as reconfiguring, so commands admitted after that retirement
fence fail. The old subscription stays alive while the exact adapter is stopped and its real
`session.exited` event is admitted in FIFO order. Only successful terminal admission permits the
registry to remove or replace the route. A failed stop leaves the durable generation and its
generation-bound MCP credential live for exact cleanup. Additions use the same mutation gate, so no
settings change can install a route after shutdown fences admission high-water.

Eight built-in provider drivers are registered in
[`builtInDrivers.ts`](../../apps/server/src/provider/catalog/builtInDrivers.ts):

- Codex
- Claude
- Cursor
- Grok
- OpenCode
- Coral (Early Access)
- Gemini — gemini-cli over ACP stdio (`gemini --acp`), disabled by default
- Antigravity (Experimental) — `agy` over persistent NDJSON stdio, disabled by default

Gemini and Antigravity remain separate provider identities. Each driver launches its official
Google executable and lets that executable own its login and native session files. 456code does not
copy credentials between them, extract Google tokens, or redirect one CLI through the other's
backend. Antigravity's headless protocol is not ACP, so it has a dedicated runtime rather than an
ACP compatibility shim.

## Google CLI capability boundary

The two Google providers intentionally expose different runtime contracts:

| Provider                   | Process transport                                                              | Runtime modes                                                                                                                 | Session/model limits                                                                                                                                | Attachments and orchestration                                                                   |
| -------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Gemini                     | `gemini --acp` over ACP JSON-RPC stdio                                         | Conservative `approval-required` fallback; `auto-accept-edits` and `full-access` only after ACP confirms their exact mode IDs | Multi-turn and replay-gated `session/load`; rollback and active-turn input unsupported; model switching only when the CLI advertises it             | Images supported; plan interaction only after ACP confirms it; orchestration is a prompt prefix |
| Antigravity (Experimental) | Persistent `agy --input-format stream-json --output-format stream-json` NDJSON | `auto-accept-edits` and acknowledgement-gated `full-access`                                                                   | Opaque `conversation_id` continuation; rollback, active-turn input, and in-session model/interaction-mode switching unsupported; one turn at a time | No native attachments; orchestration is a prompt prefix                                         |

Antigravity full-access admission is server-enforced with the exact capability acknowledgement
`antigravity-full-access-v1`. The server cannot review individual headless tool calls, so a client
or direct RPC caller that omits the acknowledgement is rejected before the session starts.
Neither provider shares credentials with the other, extracts CLI tokens, calls a direct Google
backend, or uses a Python SDK/sidecar.

## Client transport

[`RpcSessionFactory`](../../packages/client-runtime/src/rpc/session.ts) owns one WebSocket Effect RPC
session attempt. The shared connection runtime prepares authenticated endpoints, owns retry policy,
and replaces sessions; application components do not construct transports or RPC clients.

## Server-side orchestration layers

Provider work crosses four ownership stages:

1. **ProviderService / ProviderRuntimeInbox** — after ProviderService receives and canonicalizes an
   adapter event, it appends the receipt with a logical provider-session generation before metrics,
   NDJSON, or process-local publication. A fatal admission error quarantines the exact adapter route
   so commands cannot continue entering a provider with no durable observer.
2. **ProviderRuntimeIngestion lane** — replays an independent durable cursor, restores its
   transactional aggregation buffer after restart/failure, and emits deterministic orchestration
   commands.
3. **CheckpointReactor lane** — replays its own durable cursor and captures checkpoints/turn
   transitions. It waits without claiming an action until the ingestion cursor has committed the
   same receipt sequence, so projection reads are sequence-consistent and upstream lag does not
   consume retry attempts.
4. **ProviderCommandReactor** — reacts to committed orchestration intent events and dispatches exact
   provider calls through the scoped service.

The two provider-inbox lanes persist separate cursor, buffer, lease, retry/manual, and session
completion state. Pruning requires both consumers to prove completion. The provider subscription
scope outlives ordinary service children during finalization so native terminal events can be
admitted before admission is fenced. Shutdown stops live adapters and waits for their exact terminal
sequences, closes only durable orphans with no live adapter, interrupts subscriptions, verifies that
no durable generation remains open, and then fences admission at the persisted high-water. Startup
resumes admission only after both inbox lanes and downstream owners drain through that handoff.
Retained/backlog counts, oldest-pending age, admission mode, and per-consumer lag are emitted as
runtime metrics.

Enabled MCP credentials are scoped to the thread, provider instance, and provider-session
generation. Exact revocation follows durable terminal admission, so a delayed terminal from an old
generation cannot revoke a replacement credential. Root shutdown still performs final revocation of
all credentials; disabled mode remains explicit.

Durability begins only after ProviderService has received and canonicalized the adapter event. The
built-in adapters currently cross process-local async queues before that boundary; provider-native
replay or acknowledgement is a separate protocol-specific completeness limit. `RuntimeReceiptBus`
keeps checkpoint milestones available to tests and harnesses; its production layer intentionally
does not retain or broadcast them.
