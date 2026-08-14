<!-- docs/architecture/orchestrate-run-executions.md -->
<!-- defines exact orchestrate execution identity, evidence, lifecycle, retention, and compatibility -->

# Orchestrate Run Executions

An authoritative orchestrate result is an immutable execution identified by
`(threadId, runId, planRevision)`. A thread-global worktree path or branch is a compatibility view of
the current execution, not historical evidence. The server never creates execution provenance from
generic filesystem mutation, sibling-worktree discovery, or a read-time Git `HEAD`.

## Admission and evidence

The authenticated orchestrate toolkit admits one execution for an approved immutable plan revision.
Admission records the source turn and event sequence, repository root, canonical Git common
directory, and base OID. Re-admitting the same revision is idempotent only for the same immutable
identity; executing changed work requires a new plan revision.

An update names explicit worker-broker job IDs. Before binding any result, the server verifies each
broker record's run, repository, base, status, immutable job identity, head, worktree, and branch. It
separately proves that the selected integration target belongs to the recorded Git common directory
and resolves to the reported OID. Both the broker and integration worktrees must have that OID
checked out as live `HEAD` on the recorded symbolic branch. Job bindings are persisted in canonical
job-ID order, so request order is not identity. Admission and updates use content-stable command
IDs; a retry after a lost response returns the byte-identical committed execution. Generic
divergence detection remains an alarm and cannot admit or update an execution.

The server-internal command carries the expected provider instance without adding it to persisted
execution history. The command decider matches that exact instance, the projected provider session,
source turn, and orchestrate mode in its serialized command lane. Evidence verification also
rechecks the authenticated provider/turn scope immediately before dispatch. Stable command IDs
include that provider authority, so a different provider cannot consume another provider's retry
receipt. An authority change can therefore reject stale work even when the toolkit invocation began
while the turn was live.

## Lifecycle and availability

Execution lifecycle is monotonic:

```text
active -> completed | failed | cancelled | superseded
```

Availability is independent of lifecycle. An execution may be `available` while its verified
integration worktree exists and `unavailable` after that materialization is retired. The base OID is
immutable. An active observed head can advance only from verified evidence for the same execution;
the final head is frozen when the execution becomes terminal. Closing or retiring an execution does
not rewrite its source, repository, OIDs, job bindings, or timestamps.

The owning turn and session bound the lifetime of an active execution. Session completion or
replacement, thread archive, and thread deletion atomically emit a terminal execution update before
the owner-closing event. These owner transitions never leave an active execution orphaned.

The canonical worktree-removal path inspects the complete execution history for the repository root
being removed. It rejects removal while any matching exact execution is active. For terminal
executions it retires availability, attempts Git removal, and restores the exact frozen availability
rows after a failure, defect, or interruption only when the same root/common-directory/OID is still
proved present. Successful cleanup keeps the immutable execution record and job history.

Exact integration binding and worktree removal share one normalized, keyed worktree permit. The
permit covers evidence verification through persistence on the update side and retirement through
Git removal or compensation on the removal side. Compensation observes full Effect exits, including
typed failure, defect, and interruption, and attempts every required restoration before returning a
combined cause.

## Exact diff reads

The versioned exact diff query requires the full execution identity. It compares the persisted base
OID with the verified observed or final head OID and never derives either boundary from a current
branch or arbitrary `HEAD`. A surviving recorded worktree may anchor the Git operation. If worktrees
were pruned, the query may use the persisted canonical common object database after proving both
objects exist there. Missing identity or objects produce a typed unavailable result; they do not
fall back to the legacy thread-global query.

Architecture impact for an exact run uses the same immutable base/head commit pair returned by the
exact diff. The analysis service resolves both commits and their trees directly; it does not turn
the exact range back into a mutable branch-range query or read the current worktree `HEAD`.

## Client compatibility

The server advertises exact execution support through its environment capabilities. Client behavior
is deliberately additive:

- old clients continue using the legacy current-only path and `getRunDiff({ threadId })` contract;
- new clients connected to an old server see no exact capability and use the same bounded legacy
  behavior;
- on an exact-capable server, a legacy thread with `orchestrateRunExecution: null` keeps its legacy
  current-only path/query;
- a present exact execution supersedes the legacy path, and `availability: 'unavailable'` cannot
  resurrect it through fallback;
- the web's persisted `{ kind: 'run' }` selection means the current authoritative execution at read
  time; mobile consumes only the authoritative current-root projection and does not expose run
  history.

The legacy projection and query remain until an independently approved minimum-version policy and
external-consumer audit permit removal. Legacy path-only records are never promoted to historical
execution evidence by guessing run, revision, repository, or OIDs.

One boundary remains intentionally outside this contract: a worker-broker record may exist briefly
before its first authoritative execution binding. Until an update verifies and binds it, that
external record is not execution provenance and is never exposed as an exact run result.

## Operational recovery

Execution rows and broker-job bindings are retained when a worktree or broker artifact is removed.
An unavailable exact result can be diagnosed from its captured identity without recreating a path.
Operators must not edit lifecycle, availability, or OID columns to make a missing result appear
available; restore trustworthy Git objects/materialization or preserve the typed unavailable state.
