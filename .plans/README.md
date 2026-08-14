<!-- .plans/README.md -->
<!-- index the repository's tracked maintainability plans -->

# Maintainability Plans

This is the complete inventory of tracked Markdown in `.plans/`. Statuses describe the evidence in
each document, not an inferred code-completion claim. `Historical` preserves an older planning or
baseline record whose current execution state is not established; `proposed` preserves an
unapproved plan without guessing that it started.

| Plan | Status | Evidence |
| --- | --- | --- |
| [01-shared-model-normalization.md](01-shared-model-normalization.md) | historical | Legacy desktop/renderer proposal with no execution ledger. |
| [02-typed-ipc-boundaries.md](02-typed-ipc-boundaries.md) | historical | Legacy desktop IPC proposal with no execution ledger. |
| [03-split-codex-app-server-manager.md](03-split-codex-app-server-manager.md) | historical | Legacy desktop decomposition proposal with no closeout state. |
| [04-split-chatview-component.md](04-split-chatview-component.md) | historical | Legacy renderer component proposal with no closeout state. |
| [05-zod-persisted-state-validation.md](05-zod-persisted-state-validation.md) | historical | Legacy renderer persistence proposal with no execution ledger. |
| [06-provider-logstream-lifecycle.md](06-provider-logstream-lifecycle.md) | historical | Legacy desktop provider-log proposal with no execution ledger. |
| [07-ci-quality-gates.md](07-ci-quality-gates.md) | historical | Bun/Turbo-era CI proposal with no closeout state. |
| [08-precommit-format-and-lint.md](08-precommit-format-and-lint.md) | historical | Pre-Vite+ hook proposal whose named tooling is no longer authoritative. |
| [09-event-state-test-expansion.md](09-event-state-test-expansion.md) | historical | Legacy renderer test proposal with no execution ledger. |
| [10-unify-process-session-abstraction.md](10-unify-process-session-abstraction.md) | historical | Legacy desktop process proposal with no execution ledger. |
| [11-effect.md](11-effect.md) | superseded | Its original migration sequence is replaced by the current-state rewrite in plan 12. |
| [12-effect-new.md](12-effect-new.md) | historical | Older Effect migration snapshot with no final execution ledger. |
| [13-provider-service-integration-tests.md](13-provider-service-integration-tests.md) | proposed | Test design and PR split only; no implementation status is recorded. |
| [14-server-authoritative-event-sourcing-cleanup.md](14-server-authoritative-event-sourcing-cleanup.md) | historical | Architecture commit-series snapshot with no maintained completion state. |
| [15-effect-server.md](15-effect-server.md) | proposed | Short server rewrite sketch with no approval or execution record. |
| [16-pr89-review-remediation-phases.md](16-pr89-review-remediation-phases.md) | active | Phase strategy points to the live checklist, which still contains open work. |
| [16c-pr89-remediation-checklist.md](16c-pr89-remediation-checklist.md) | active | Canonical checklist contains both completed and remaining `TODO` findings. |
| [17-claude-agent.md](17-claude-agent.md) | active | Some contract tasks are marked complete while later adapter, UX, and rollout phases remain. |
| [17-provider-neutral-runtime-determinism.md](17-provider-neutral-runtime-determinism.md) | completed | Explicitly records all seven sections implemented, with one optional helper deferred. |
| [18-server-auth-model.md](18-server-auth-model.md) | proposed | Target auth architecture and phases are defined without an execution ledger. |
| [19-remote-endpoints-hosted-static.md](19-remote-endpoints-hosted-static.md) | proposed | Endpoint and hosted-app phases are defined without an implementation status. |
| [19-version-control-phase-1-vcs-driver-foundation.md](19-version-control-phase-1-vcs-driver-foundation.md) | proposed | VCS foundation design has migration steps but no execution ledger. |
| [20-version-control-phase-2-source-control-provider-foundation.md](20-version-control-phase-2-source-control-provider-foundation.md) | proposed | Provider foundation design has migration steps but no execution ledger. |
| [21-style-comments-and-structure-modernization.md](21-style-comments-and-structure-modernization.md) | completed | Phases 0-4 are complete; the remaining high-risk follow-ups continue under active plan 23. |
| [22-core-review-remediation.md](22-core-review-remediation.md) | proposed | Durable remediation groups are preserved but remain re-verification and approval gated. |
| [23-high-risk-large-file-boundaries.md](23-high-risk-large-file-boundaries.md) | active | `ChatView` terminal + send/retry slices are committed; WebSocket assembly and Claude session/finalizer remain gated, and integrated send/retry acceptance is deferred. |
| [24-layout-execution-designs.md](24-layout-execution-designs.md) | active | All implementable Phase 3c bodies are committed; explicit ws, Claude, decider/projector, and GitVcsDriver façade HOLDs plus deferred web/mobile acceptance remain open. |
| [25-t3code-upstream-selective-porting.md](25-t3code-upstream-selective-porting.md) | proposed | Implementation-ready manual adaptation plan for all 17 accepted commits from the 35-commit upstream t3code review window. |
| [26-cartographer-absorption.md](26-cartographer-absorption.md) | completed / presentation superseded | Preserves the original absorption and remediation record; native resources retired the iframe, context URL, and browser-origin acceptance surface. |
| [27-native-architecture-impact.md](27-native-architecture-impact.md) | completed / presentation superseded | Preserves the intermediate native Impact plus Advanced Atlas release; the maintained integration is now fully native and iframe-free. |
| [28-coral-provider-integration.md](28-coral-provider-integration.md) | Early Access Core shipped | Disabled-by-default Coral driver; Phase 2 HTTP MCP/Orchestrate parked; Phases 3–4 not this release. |
| [README.md](README.md) | active | Maintained inventory and status index for the tracked planning surface. |
| [branch-environment-picker-in-chatview-input.md](branch-environment-picker-in-chatview-input.md) | historical | Legacy renderer UX proposal with obsolete package paths and no closeout state. |
| [effect-atom.md](effect-atom.md) | proposed | AtomRpc migration phases are specified without an implementation ledger. |
| [git-flows-integration-tests.md](git-flows-integration-tests.md) | historical | Legacy desktop test plan uses obsolete source and command paths. |
| [git-flows-test-plan.md](git-flows-test-plan.md) | historical | Legacy renderer test plan uses obsolete source and command paths. |
| [git-integration-branch-picker-worktrees.md](git-integration-branch-picker-worktrees.md) | historical | Legacy desktop/renderer implementation proposal with no closeout state. |
| [mdx-cartographer-integration.md](mdx-cartographer-integration.md) | partially superseded | SafeDocument MDX and immutable proposals remain current; native architecture resources supersede the hosted Cartographer phases. |
| [orchestrate-core-workflow-review.md](orchestrate-core-workflow-review.md) | active | Implementation report leaves visual polish and two broker follow-ups open. |
| [session-import-continuable.md](session-import-continuable.md) | completed | Execution ledger records every phase and focused acceptance complete. |
| [spec-1-1-cutover-plan.md](spec-1-1-cutover-plan.md) | historical | Hard-cutover sequence has no maintained completion ledger. |
| [spec-contract-matrix.md](spec-contract-matrix.md) | historical | Point-in-time SPEC gap matrix still reports the pre-cutover baseline. |
| [test-pruning-audit.md](test-pruning-audit.md) | completed | Groups 1-7 and the deferred densify follow-up are explicitly recorded complete. |
