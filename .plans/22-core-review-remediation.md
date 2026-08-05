<!-- .plans/22-core-review-remediation.md -->
<!-- preserve approval-gated remediation work from the current core reviews -->

# Plan: Core Review Remediation

## Status

Proposed. This plan preserves the durable remediation work identified by the July 2026 core
reviews after raw audit evidence leaves the tracked repository. It does not approve code changes,
tests, dependency changes, commits, or publication. Re-verify every group against the live branch
before implementation because the review baselines included moving and uncommitted worktrees.

## Objective

Resolve the few cross-cutting correctness, lifecycle, and performance boundaries that remain
valuable after deduplication and adversarial verification, without turning audit findings into a
repository-wide cleanup campaign.

## Workstreams

### 1. Orchestrate and workers surfaces

- make plan supersession and revision identity independent of virtualized mount order
- keep approval replies correlated to one run and reject ambiguous duplicate stage identities
- give worker snapshots, readiness, run rollups, and activity one server-owned read-model lifecycle
- preserve thread scope in worker deep links and render unknown/failed/live states consistently
- stabilize composer send identities so streaming does not invalidate every mounted plan row

Gate with focused workers store/broadcaster, client-runtime fallback, plan-store, plan-card grammar,
and panel-logic checks. Redesign supersession before encoding it in tests.

### 2. Server durability and protocol liveness

- route provider responses while earlier inbound approval or question handlers remain pending
- make committed orchestration intents recoverable across reactor downtime with a durable cursor or
  outbox design
- make settings-file and provider-secret changes one compensated commit boundary
- stage checkpoint restore and revert work so filesystem, provider, and projection state cannot
  silently diverge
- preserve snapshot-first stream handoff without missing changes between the snapshot and
  subscription

These items need design-level invariants and deterministic fault/interleaving checks. Do not patch
them as independent catch blocks or retries.

### 3. Provider switch and runtime lifecycle

- clean up hidden turns on timeout and non-timeout failure, and treat `turn.aborted` as a
  lifecycle-closing event
- preserve an unconsumed handoff across consecutive switches and keep the model-selection cache
  aligned with switch completion
- enforce interaction-mode capability at the server boundary so every client converges on the same
  valid mode
- retain provider identity on usage events and keep usage derivation provider-scoped
- preserve per-thread FIFO while removing the global cross-thread stall caused by awaited switch
  compaction

Sequence lifecycle cleanup before handoff consolidation, client follow behavior, usage work, and
the higher-risk concurrency change. Capture live provider catalogs before changing cheap-model
selection aliases.

### 4. Client, desktop, SSH, and auth ownership

- serialize mobile draft hydration, writes, clearing, and attachment persistence under one owner
- make preview close own recording cleanup and file-editor disposal flush only unsaved revisions
- keep desktop restart, update, relaunch, picker, and main-window lifecycle transitions recoverable
- cancel in-flight SSH tunnel creation and lease shared remote runtimes by resolved remote identity
- bound replay/credential state and require explicit policy decisions for pairing consumption,
  cookie precedence, and archive behavior

Keep each client or runtime boundary in its own implementation unit and run integrated verification
only for user-visible surfaces actually changed.

### 5. Measured performance and narrow maintenance

Measure before changing streaming cadence, diagnostics sampling, terminal process snapshots,
worker-history rendering, long-thread snapshots, queue depth, Explorer polling, or mobile Markdown
rendering. Each optimization must preserve exact final text, ordering, ownership, and failure
semantics.

Consolidate only already-proven policy copies, such as work-log extraction, settled-turn mapping,
provider identity stamping, and import normalization bounds. Confirm owner intent before deleting
apparently unreachable modules. Keep contracts schema-only and use explicit shared subpath exports.

## Sequencing

1. Land low-risk orchestrate/workers state corrections and their focused regression net.
2. Repair provider-switch lifecycle and handoff correctness before client follow behavior.
3. Address server durability, protocol, settings, desktop, SSH, and auth groups in bounded designs.
4. Make the provider-switch concurrency change alone after the lifecycle guards have soaked.
5. Run measurements, then take only the maintenance work naturally touched by an approved group.

## Acceptance

- every implemented group is re-verified against live symbols and current contracts before editing
- focused regressions prove the distinguishing interleaving, fault, or state transition
- no compatibility shim, broad abstraction, or exhaustive test matrix is added without a present
  repository-backed need
- performance changes include a before/after measurement and exact correctness comparison
- tracked plans and maintained docs contain every required decision; ignored local evidence is
  optional and never required to understand or execute a group

## Explicit Non-Goals

- no raw audit transcript or finding-by-finding evidence archive in `.plans/`
- no security-review claim; security remained outside the source reviews
- no approval of all groups as one implementation or commit series
- no refactoring solely for line count, test-count reduction, or apparent textual duplication
