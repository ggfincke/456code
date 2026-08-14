<!-- docs/operations/runtime-recovery.md -->
<!-- explains authenticated diagnostics and audited runtime recovery operations -->

# Runtime Recovery

456code deliberately stops durable automation when it cannot prove whether work is safe to retry or
complete. The runtime recovery API makes those blocked states inspectable without exposing raw
payloads or requiring direct database edits. It does not turn every blocked row into an operator
mutation.

## Authorization boundary

Read-only list and detail endpoints require `orchestration:read`. A mutation requires the separate
`orchestration:recover` scope. That scope is part of the closed authorization schema but is excluded
from both standard-client and default administrative scope bundles, so existing credentials never
inherit it.

Recovery authority is CLI-issued only. OAuth token exchange does not accept this scope, and the
pairing-credential route rejects attempts to delegate it even when the authenticated issuer already
holds recovery authority.

Issue a new recovery credential explicitly while the server storage is under the command's
exclusive lease:

```sh
456code auth session issue --recovery --label runtime-recovery --subject operator-name
```

Store the returned bearer token as a secret. If the session is DPoP-bound, every request must also
carry its matching DPoP proof. Revoke the session after the recovery window, or issue a replacement
without `--recovery` to return to the default administrative scope bundle. Reissuing or downgrading
one credential does not alter any previously issued token; revoke the old recovery session
explicitly. Before downgrading to a binary whose closed scope schema predates
`orchestration:recover`, revoke every recovery-scoped session with the current binary; an older
binary is not required to decode or safely ignore the newer persisted scope.

## Administrative HTTP surface

| Method | Path                                            | Required scope          | Purpose                                         |
| ------ | ----------------------------------------------- | ----------------------- | ----------------------------------------------- |
| `GET`  | `/api/recovery/actions`                         | `orchestration:read`    | List blocked durable reactor actions            |
| `GET`  | `/api/recovery/actions/:actionId`               | `orchestration:read`    | Inspect one action and its audit history        |
| `POST` | `/api/recovery/actions/:actionId`               | `orchestration:recover` | Request one owner-registered recovery operation |
| `GET`  | `/api/recovery/checkpoint-reverts`              | `orchestration:read`    | List requested or manual checkpoint journals    |
| `GET`  | `/api/recovery/checkpoint-reverts/:operationId` | `orchestration:read`    | Inspect one requested or manual journal         |

List responses return at most 100 rows. When `truncated` is true, pass the opaque `nextCursor`
unchanged as the `cursor` query parameter on the same endpoint until `nextCursor` is null. Cursors
are versioned and list-specific; a malformed cursor or one copied between the action and checkpoint
lists returns `invalid_cursor`. Stable keyset ordering includes the full timestamp/owner/sequence/ID
tuple, so rows with identical timestamps remain discoverable without offset drift. An exact action
detail is available only while the action is blocked or after this boundary has recorded a recovery
audit for it; an audited action remains inspectable as it advances through normal queue states.

Diagnostics expose allowlisted identifiers, state, timestamps, attempts, materialized dependency
counts, summaries, and SHA-256 digests. They do not return provider payloads, prompts, credentials,
raw errors, workspace paths, repository common directories, or commit OIDs. Checkpoint identity is
reported only as `present` or `missing` for the capture root, repository common directory, and commit
OID. A missing field commonly identifies a legacy journal and never grants a recovery action.

The materialized blocked-action count is not a complete future blast radius. Later source events may
not have materialized yet, and the checkpoint diagnostic separately explains when a `requested` or
`manual-required` journal keeps new-turn admission closed for its thread.

## Current evidence and action matrix

| Owner/effect/version                                                                                  | Recoverable state | Allowed action | Required evidence                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `architecture-auto-analysis` / `architecture.diff-analysis.request` / v1                              | `manual`          | `retry`        | The reported dependency or transient failure is repaired; the owner will revalidate current checkpoint identity and generation deduplication |
| `provider-runtime-ingestion` or `provider-runtime-checkpoint` / `provider.runtime-event.consume` / v1 | Any blocked state | None           | Each inbox consumer has independent durable progress, and neither currently declares a safe operator replay or resolution predicate          |
| `thread-archive` / `thread.archive.cleanup-exact` / v1                                                | Any blocked state | None           | The persisted archive generation and resource lifecycle identities are diagnostic only; the owner never retargets a replacement resource     |
| Any unregistered owner/effect/version tuple                                                           | Any blocked state | None           | No exact owner policy exists, so the diagnostic remains read-only                                                                            |
| Requested checkpoint revert                                                                           | `requested`       | None           | Durable request fence awaiting authoritative event replay; missing or mismatched source identity auto-aborts through its owner               |
| Manual checkpoint revert                                                                              | `manual-required` | None           | Resume and post-restore abort are not proven idempotent or cleanup-safe; inspect only                                                        |

There is no generic mark-succeeded or skip endpoint. The existing low-level delivery resolution stays
internal for domain compensation and is not an operator contract.

Archive membership is selected under the shared lifecycle permit and guarded by a monotonic archive
generation, not timestamps. One action persists its captured provider and terminal identities.
Execution for that same generation unions the persisted provider identities with every still-open
durable provider generation for the archived thread, exact-stops the full set, and refuses completion
while any remain open. Terminal cleanup remains restricted to the exact persisted lifecycle
identities. A stale archive generation succeeds without touching replacement resources. Timestamps
are diagnostic only. Archive preserves proposal generations, retained architecture artifacts, and
terminal history. Blocked archive actions are read-only in this recovery API because no operator
mutation currently proves the same generation and external side effect atomically.

The archive reactor's first installation starts at the current projection snapshot sequence. Migration
064 leaves every pre-cutover thread at archive generation `0`, and no historical archive is replayed:
those rows have no captured resource identity, so the provable reconciliation set is empty rather than
guessed. Every later archive event enters the durable lane. This is a direct durable cutover, not a
shadow interval; deploy one storage-lease owner containing both the reactor source and the removal of
the old WebSocket-local cleanup hook.

## Performing the declared architecture retry

1. Read the action detail and confirm `reactorId` is `architecture-auto-analysis`, `effectKind` is
   `architecture.diff-analysis.request`, `operationVersion` is `1`, `status` is `manual`, and
   `allowedActions` contains `retry`.
2. Investigate the redacted digest and owner summary. Repair the underlying transient dependency;
   do not retry merely to clear the lane.
3. Copy the current `updatedAt` value into `expectedUpdatedAt`. Supply a specific operator reason and
   the exact confirmation value advertised by the diagnostic.
4. Submit the optimistic mutation:

   ```json
   {
     "action": "retry",
     "expectedStatus": "manual",
     "expectedUpdatedAt": "2026-08-09T00:00:00.000Z",
     "confirmation": "retry-owner-declared-idempotent",
     "reason": "transient dependency repaired"
   }
   ```

5. A successful response reports `pending` and includes the immutable audit row. A `stale_state`
   response means the state or timestamp changed; reread the detail and reassess instead of replaying
   the old request.

The state transition and audit insertion share one SQLite transaction. If either write fails, the
action remains blocked. Retry returns work to the normal owner queue; it never asserts that the
effect succeeded.

## Audit and recovery policy

Migration 60 creates append-only `runtime_recovery_audit` history. Each accepted reactor mutation
records the authenticated session and subject, exact reactor/effect/version tuple, action,
before/after state, timestamp, and operator reason. Database constraints require this owner tuple for
reactor actions; database triggers deny updates and deletes, and this implementation performs no
automatic audit pruning. A detail response returns at most the newest 100 audit rows in chronological
order and sets `auditsTruncated` when older retained history exists. Read-scoped responses expose
actor session, actor subject, and reason only as SHA-256 digests; their full values remain in the
immutable audit row. Each reactor audit remains self-contained if its source action later becomes
unavailable: it retains the action ID, exact owner tuple, effect, transition, and operator evidence
without a foreign-key dependency on the action table.

Do not edit blocked action, checkpoint, progress, or audit rows directly. If an effect has no allowed
action, preserve its diagnostic and escalate to the owning domain for an explicit evidence predicate
and atomic transition. Rollback may disable mutation routes while retaining read-only diagnostics
and audit history; an older binary must not be used to erase or reinterpret the additive schema.
