<!-- docs/operations/checkpoint-recovery.md -->
<!-- explains checkpoint repository identity, read compatibility, and destructive revert safeguards -->

# Checkpoint Identity and Revert Recovery

456code treats a checkpoint ref as a name, not as durable proof that the ref still identifies the
repository and commit captured for a turn. New checkpoint captures persist three canonical identity
fields alongside the published ref:

- `checkpointCaptureRoot`: the real path of the worktree used for capture;
- `repositoryCommonDir`: the real path of Git's common directory for the repository; and
- `checkpointCommitOid`: the exact object ID published at the checkpoint ref.

The same contract applies to the turn-zero baseline and every later checkpoint. The published ref
remains useful for retention and diagnostics, but reads and destructive restores prove repository
identity and ref immutability before using it.

## Read compatibility

An authoritative checkpoint has all three identity fields. A read first considers the recorded
capture root. If that worktree was pruned, it may use another available candidate only when Git
resolves that candidate to the persisted canonical common-directory anchor and the checkpoint ref
currently resolves to the captured OID. This permits a surviving sibling worktree from one
repository without requiring the pruned path to resolve and without allowing a reused path,
unrelated repository, or moved ref to impersonate the capture.

A diff resolves both endpoints independently and passes the two recorded OIDs to Git. The endpoints
must resolve to the same canonical common directory; comparing two same-named refs without this
proof is rejected.

Two legacy read modes remain deliberately weaker:

- A checkpoint recorded without a capture root may be read from the current worktree when its ref
  resolves there. This preserves the historical null-root fallback.
- A checkpoint with a recorded root but no OID may be read only after the recorded and current roots
  both resolve to the same canonical common directory and the ref resolves in that repository.

These modes are read-only compatibility. The server does not guess or backfill an OID from the
current value of a mutable ref.

## Destructive revert admission

A revert requires a complete authoritative identity. The engine transaction that accepts
`thread.checkpoint.revert` appends the request event and immediately reserves a `requested` journal
row with its `requestSourceSequence` and `providerInboxHighWater`. Reservation performs no restore
root resolution or filesystem work, but it closes conflicting lifecycle and mutation admission for
the thread.

Before promoting that row to `admitted`, CheckpointReactor drains ProviderCommandReactor through
the sequence immediately before `requestSourceSequence`, drains both provider-inbox lanes through
`providerInboxHighWater`, re-reads the settled thread/session/execution state, captures the exact
provider generation, and verifies all of the following:

1. The target root is the current selected/provider-session root, resolved to its canonical real
   path.
2. That root belongs to the captured canonical Git common directory.
3. The checkpoint ref still resolves to the captured OID.

An invalid or unrecoverable `requested` row moves to `aborted` without starting destructive work.
Public metadata and lifecycle commands remain fenced while a revert is active. The engine's
non-transport `dispatchInternal` path admits only a causally owned `thread.meta.update`: either its
`domain-event` source sequence is less than `requestSourceSequence`, or its `provider-runtime`
source sequence is at most `providerInboxHighWater`. This lets first-turn branch/title settlement
and already received provider metadata drain without creating a general admission bypass.

The admitted journal records the exact restore root, repository anchor, commit OID, and provider
generation before any filesystem mutation. It stages and preflights the recorded tree, reads the
provider-native turn count, and freezes `rolledBackTurns` for the attempt. It marks the attempt
before calling the exact provider rollback, then exact-stops that provider generation and drains
both provider-inbox lanes through the durable terminal event. Only after re-reading the settled
projection does it compute stale refs, restore and post-verify the filesystem from the recorded OID,
publish the projection transition, and delete only the recorded stale refs.

Identity loss or an indeterminate provider rollback moves the journal to `manual-required`. A
provider that explicitly declares rollback unsupported is exact-stopped before filesystem restore,
and the completed revert publishes that limitation. Restart recovery repeats the same identity
proof and resumes against the recorded restore root and provider generation; a different current
provider-session root does not redirect an in-progress restore.

Migration 67 preserves journals already in a terminal or `manual-required` state. Older nonterminal
journals created before the request fence move to `manual-required`, because their request barriers
and provider-first ordering cannot be reconstructed. Any resumed journal missing checkpoint
identity or an exact provider generation likewise fails closed before destructive work. Because no
safe automatic resume predicate is defined for these refusals, they remain non-resumable through
the internal reactor and visible through the authenticated recovery diagnostics. Do not edit the
journal or checkpoint tables to manufacture identity.

## Failure diagnostics

Checkpoint identity failures are typed so callers can distinguish the required response:

| Condition                               | Meaning                                                                   | Response                                                          |
| --------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `checkpoint-identity-missing`           | The persisted fields are incomplete or inconsistent                       | Treat as legacy/incomplete; do not restore                        |
| `checkpoint-repository-mismatch`        | The current root or diff endpoints belong to another Git common directory | Select the captured repository or stop                            |
| `checkpoint-ref-oid-mismatch`           | The checkpoint ref no longer resolves to the captured OID                 | Preserve evidence and investigate ref movement                    |
| `checkpoint-root-unavailable`           | Neither the capture root nor a proven sibling worktree is usable          | Restore repository/worktree availability or stop                  |
| `checkpoint-destructive-legacy-refusal` | A legacy checkpoint or journal lacks destructive identity proof           | Use manual diagnostics; never infer identity from the current ref |

Missing or pruned objects, unavailable worktrees, repository replacement, and ref movement are
expected operational failure modes. They must be resolved by restoring trustworthy repository
evidence, not by weakening admission checks.
