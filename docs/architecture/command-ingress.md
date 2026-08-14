<!-- docs/architecture/command-ingress.md -->
<!-- defines WebSocket, HTTP, and CLI ownership for orchestration commands -->

# Orchestration Command Ingress

456code has one canonical `OrchestrationEngine`, but its public transports intentionally expose
different application contracts. The engine owns command invariants, canonical events, receipts,
and projections. Transport code owns authentication and response encoding; WebSocket additionally
owns its established interactive bootstrap/admission workflow.

## WebSocket contract

Authenticated WebSocket clients can use the full supported client-command contract. Before the
engine, the WebSocket application flow may validate import continuation consent, create a missing
thread or worktree, run project setup, serialize startup admission, roll back partial bootstrap, and
track attachment lifecycle. These are interactive application semantics, not generic engine
behavior, and they are not implicitly promised by HTTP.

## Environment HTTP contract

The versioned environment HTTP endpoint accepts only these project commands:

- `project.create`;
- `project.meta.update`; and
- `project.delete`.

The retained legacy endpoint still decodes the historical broad command union for compatibility,
but it applies the same project-only runtime allowlist. Every other command returns the typed
endpoint-specific unsupported result before engine effects. The compatibility decoder is not a
promise of WebSocket bootstrap, readiness, continuation, or rollback parity.

Old bearer clients may continue sending supported project commands through the legacy endpoint.
Removing its broad schema/tag requires an out-of-repository consumer inventory or an explicitly
approved minimum client version; tracked-callsite migration alone is not enough.

## Project CLI ownership

The project CLI first performs a read-only runtime-state and live-server probe. When the canonical
local storage owner is available, the CLI sends its private storage-owner token over loopback only
to the exact shell snapshot and versioned project-command routes. The token is not a bearer
credential, cannot authorize the legacy endpoint, and is not accepted by unrelated routes.

If there is no live owner, the CLI acquires the same canonical `baseDir` storage lease before it
cleans stale runtime metadata or constructs persistence. A new CLI connected to an old server fails
explicitly; it never falls back to legacy bearer dispatch and never opens offline persistence while
another process owns storage.

Service status is read-only. Install/update stops only an active stale unit, then a nested CLI scope
acquires the storage lease and materializes the pinned runtime and unit through `prepareInstall`.
That scope closes before `activatePrepared` performs daemon reload, enablement, restart, and linger.
Readiness requires a different durable owner token from a non-CLI PID plus an active systemd unit.
If preparation fails, the previous active unit is restarted after the lease scope closes. If
activation fails, the previously installed unit definition/runtime is restored and restarted after
lease release even when that old unit was inactive before preparation. Uninstall can stop/remove the
service without pre-acquiring a lease held by that service.

## Checkpoint-revert settlement

Public metadata and lifecycle commands remain fenced while a checkpoint revert is active. The
engine's non-transport `dispatchInternal` path admits only a causally owned `thread.meta.update`:
either its `domain-event` source sequence is less than the revert's `requestSourceSequence`, or its
`provider-runtime` source sequence is at most `providerInboxHighWater`. This lets first-turn
branch/title settlement and already received provider metadata drain without exposing an HTTP,
WebSocket, or CLI bypass contract.

## Lifecycle effects

Archive resource cleanup is not owned by either transport. An archive action records its archive
generation and captured provider and sorted terminal identities. Under the shared lifecycle permit,
the durable archive reactor rechecks that generation and unions the persisted provider identities
with every still-open durable provider generation for the archived thread. It exact-stops the full
set and refuses success while any remain open; terminal cleanup is restricted to the exact persisted
lifecycle identities. WebSocket, HTTP, import, and internal callers therefore share the same
post-commit lifecycle semantics. Thread deletion remains a separate, stronger lifecycle.
