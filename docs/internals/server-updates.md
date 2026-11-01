# Server updates

456code removed upstream's background service and its launcher-driven updates. A server
updates only with the desktop app hosting it, from a build staged on the same machine
([staged updates](../operations/release.md#staged-updates));
[ReleaseUpdates](../../apps/server/src/fincke/ReleaseUpdates.ts) refuses every other
request. The upstream service launcher remains in the tree, dormant.

Desktop updates use a two-phase handoff because installing the app stops
its bundled backend. Preparation returns a token while the connection is alive;
the client commits that token only after receiving it. Otherwise backend shutdown
could lose the only successful RPC result. The client must then observe the
prepared version after reconnecting. If installation fails, desktop restarts the
stopped backends and replays the failure for the same token.

## Recovering interrupted threads

Restart continuation is an environment-owned preference, on by default. A
`settings.json` that fails to decode turns it off, since the file may hold an
opt-out. The
[v2 recovery service](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
requires matching durable run, provider thread, session, and native resume identity.
Queued runs never started, so recovery holds them and continues the run they wait
behind. A settled run qualifies only when the restart cancels work the agent waits on
(a subagent, a background task, or a shell or monitor the agent marked with
`t3_background_wait`) and its session was live, so stale records from an older crash
never wake it. Its continuation prompt is the note of what will not report back. An
unmarked shell or monitor does not wake a settled run: most are dev servers and their
watchdogs that nobody waits on, so that note waits for the next user message.

Recovery retires effects tied to the lost process and records continuation intent
in the durable outbox. That intent survives another restart before provider startup.
Continuation effects wait for activation; a slow provider must not delay the server's
readiness. Graceful shutdown captures intent before
closing providers, then reconciles after ingestion has stopped so a late completion
cannot be overwritten by a stale cancellation.

The [continuation handler](../../apps/server/src/orchestration-v2/RestartContinuation.ts)
rechecks the preference, provider selection, newer user work, a stop the user requested,
and maintenance turns such as `/compact` before dispatching. Intent and delivery both
refuse a thread that is archived, settled, or still snoozed, a cut turn whose provider
turn already ended, and a run waiting on the user: an approval, question, or secret that was pending,
or that recovery closed on the cut turn. Message-capable questions stay answerable, so
they do not block. Delivery also stops after three consecutive continuations in one
`restartContinuationOfRunId` chain, so a turn that crashes the server cannot loop. Stable
command and message IDs prevent duplicate submissions after an outbox retry. Codex
resumes without adding provider prompt text unless the turn lost background work;
other adapters receive the continuation message through their normal turn path.

Delegated tasks (`delegate_task` child threads) are reconciled as their own threads,
never as the parent's background work. The orchestrator settles child results and
completion deliveries in a startup pass after reconciliation, because the terminal-run
listener ignores reconciliation's cancellations. A cancelled child whose restart
continuation is still pending in the outbox is not a result yet; the continuation's run
settles it, or the handler settles it when it declines to continue. Schedulers wait for
activation so they cannot start runs that reconciliation would then cancel.
