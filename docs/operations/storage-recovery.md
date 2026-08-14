<!-- docs/operations/storage-recovery.md -->
<!-- explains exclusive server storage ownership and migration-lineage recovery -->

# Server Storage Ownership and Migration Recovery

456code permits one mutation-capable server or offline CLI process for each canonical `baseDir`.
The lease covers every baseDir-derived mutable root, including SQLite and settings below `stateDir`
and the shared `caches` and `worktrees` directories. Development and user-data runtimes that point
at the same base directory are therefore mutually exclusive.

## Startup and CLI ownership

The launch boundary creates only the requested base directory, resolves its canonical path, and
opens `<baseDir>/.456code-storage.lock.sqlite` in an exclusive SQLite transaction before it creates
owned subdirectories, reads settings, opens application SQLite, runs migrations, builds providers
or reactors, or starts HTTP. The kernel-backed transaction serializes every acquisition and stale
recovery attempt and is released automatically if the process dies. While holding it, the process
atomically creates `<baseDir>/.456code-storage.lock`, a private diagnostic owner record containing a
random token, host, PID, observed process start, acquisition time, and the canonical base directory.
Both files are mode `0600`. `<stateDir>/server-runtime.json` is discoverability metadata associated
with that same token; it is not the lock or the acquisition mutex.

An offline CLI mutation follows the same rule. A project command first performs a read-only probe
for a live local server. When that owner is available, the CLI uses the private storage-owner token
only over loopback and only for the shell snapshot and versioned project-command endpoint. It does
not open the auth database or issue a temporary bearer session. If no live owner is available, the
CLI must acquire the exclusive lease before it constructs persistence. The token is never valid for
the legacy broad command endpoint or any unrelated HTTP route.

Service install/update first stops only an active stale unit. A nested CLI scope then acquires the
lease and materializes the pinned runtime and unit through `prepareInstall`; that scope closes before
systemd activation. `activatePrepared` performs daemon reload, enablement, restart, and linger only
after lease release, and readiness requires a different durable owner token from a non-CLI PID plus
an active systemd unit. If preparation fails, the previous active unit is restarted after the lease
scope closes. If activation fails, the previously installed unit definition/runtime is restored and
restarted after lease release even when that old unit was inactive before preparation. Uninstall
remains a service-manager removal and does not pre-acquire the service's lease.

## Contention and stale records

Lease acquisition is non-blocking. A process that cannot acquire the SQLite mutex reads the owner
record only to produce a bounded contention diagnostic; it never attempts recovery. An active
same-host owner, an owner on another host, or a recent unreadable owner record prevents startup.
Canonicalization means symlink or spelling aliases cannot create two owners for one storage tree.

Stale takeover is deliberately conservative:

1. Same-host PID liveness is checked, including process-birth comparison where the host exposes it.
2. An unreadable record is eligible only after the recovery grace interval.
3. Only the SQLite-mutex holder may quarantine a stale record and create the replacement owner.
4. The mutex remains held for the owner's entire lifetime, so concurrent stale observers cannot
   rename a replacement owner's record.
5. Graceful release removes the record only when its random token still matches, then releases the
   SQLite transaction.

Do not delete the lock merely because a launch failed. First prove the recorded process is gone and
that no service manager, desktop backend, or CLI process is restarting it. A cross-host record is an
operator decision, not an automatic stale-owner conclusion. Stop every old binary before deploying
the lease-aware runtime; mixed old/new writers are unsupported.

## Migration lineage invariant

The migration ledger is validated by exact `(migration_id, name)` identity against the complete
compiled manifest before numeric gap repair or forward migration. Duplicate manifest identities,
duplicate ledger IDs, unknown or newer IDs, and name mismatches fail before schema mutation. The
integrated high-water identities are:

|    ID | Canonical name                             |
| ----: | ------------------------------------------ |
|    52 | `ProjectionThreadsInteractionOrchestrate`  |
|    53 | `ProposalOrchestratePlanLinks`             |
|    54 | `ProjectionThreadOrchestratePlanLeadModel` |
|    55 | `ProjectionThreadsOrchestrateIntegration`  |
| 56-58 | Reserved; no ledger rows                   |
|    59 | `DiffAnalysisGenerations`                  |
|    60 | `RuntimeRecoveryAudit`                     |
|    61 | `ProviderRuntimeInbox`                     |
|    62 | `CheckpointCaptureIdentity`                |
|    63 | `OrchestrateRunExecutions`                 |
|    64 | `ProjectionThreadArchiveGeneration`        |
|    65 | `CheckpointRevertProviderGeneration`       |
|    66 | `ProviderRuntimeInboxProviderKind`         |
|    67 | `CheckpointRevertRequestedFence`           |

These migration identities are unreleased lineage. Migration 61 creates
`provider_runtime_inbox_sessions.provider_kind` as a required exact provider kind. Migration 66 adds
immutability enforcement; it does not introduce a `legacy-unresolved` sentinel or backfill.

One historical alternate lineage is recognized: migration 52 named `DiffAnalysisGenerations` from
the pre-integration Cartographer branch. Under the storage lease, the compatibility path verifies
the exact historical table constraints and indexes, applies the idempotent migration-59 convergence,
verifies the canonical interaction column, then transactionally records canonical identities 52 and 59. It runs only when row 59 is absent. A non-canonical row 59, a shape mismatch, or any other renamed
ID is an unknown lineage and performs no reconciliation writes.

## Recovery procedure

For a disposable development database, stop the owner and recreate the database from source state.
For retained data:

1. Stop every server, desktop backend, service manager, and offline mutation command using the base
   directory.
2. Preserve the database, WAL/SHM companions, lease record, and runtime metadata as one evidence
   bundle; create a private backup before any attempted recovery.
3. Inspect the migration ledger and schema with the repository's read-only SQLite tooling. Never edit
   `effect_sql_migrations` by hand.
4. If and only if the evidence matches the exact historical 52 signature, run the reviewed current
   binary once under the exclusive lease and retain its before/after validation output.
5. For every other mismatch, stop. Restore the untouched backup or escalate with the exact ledger,
   schema, binary version, and owner metadata. Do not disable validation or rename a row to force
   startup.

After an additive migration, rollback means retaining the compatible schema while disabling the
feature, or restoring a verified pre-migration backup under a full stop. An arbitrary older binary
must not open a newer retained database.
