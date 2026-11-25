# Server updates

456code removed upstream's background service and its launcher-driven updates. A server updates
only with the desktop app hosting it, from a build staged on the same machine
([staged updates](../operations/release.md#staged-updates));
[ReleaseUpdates](../../apps/server/src/fincke/ReleaseUpdates.ts) refuses every other request. The
upstream service launcher remains in the tree, dormant.

## Client acknowledgement

Desktop updates use a two-phase handoff (prepare token while connected, commit after receiving it)
because installing stops the bundled backend.

## Recovering interrupted threads

- On startup, retire effects tied to the lost process before admitting new work.
- Persist restart-continuation intent in the durable outbox and wait for activation before running
  it so slow providers never delay readiness.
- Cap consecutive crash recoveries per unfinished turn so a crashing turn cannot loop forever.
- Never auto-continue a turn that is archived, settled, snoozed, user-stopped, or waiting on a
  blocking user action (approval, question, or secret).
