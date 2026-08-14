<!-- .plans/27-native-architecture-impact.md -->
<!-- tracks the phased native impact and advanced atlas product-boundary implementation -->

# Plan: Native Architecture Impact and Advanced Atlas

## Status

COMPLETED on 2026-08-09. The user authorized all phases to run straight through, with phase-scoped
verification and a stop only when the approved plan contradicted the live code.

The implementation starts from `fix/session-postmortem` at
`756068c1e0fd70b99985053abb32b8c22570f5a7`. The checkout contains unrelated concurrent work; every
pre-existing modified or untracked path remains user-owned and must be preserved.

### Historical supersession note (2026-08-09)

This plan records the completed intermediate release that paired native Impact with an optional
Advanced Atlas. The subsequent native architecture integration supersedes that presentation
boundary: Proposal Review now keeps Narrative and source Changes with a compact architecture row;
Impact opens as its own native Before / Diff / After resource; Repository Atlas and Architecture
Scope are native 456code resources; and no Advanced Atlas iframe or separate Atlas SPA is shipped.
The analyzer, immutable target authority, bounded exactness, retained artifacts, CLI, and MCP
contracts remain. Removal of the Cartographer `serve` and `embed-server` browser commands and the
browser package surface is an intentional breaking change.

The original product decision, phase ledger, and closeout evidence below remain accurate for that
historical intermediate implementation. Use
[`docs/integrations/cartographer.md`](../docs/integrations/cartographer.md) for the maintained
product and runtime contract.

## Product decision

- The normal proposal surface is **Proposal Review** with **Narrative**, **Changes**, and native
  **Impact** views.
- Native Impact consumes an authorized bounded graph comparison without creating or loading an
  Atlas context.
- The complete Cartographer workbench remains available through an explicit **Open Advanced Atlas**
  action and as the separate **Repository Atlas — Advanced** surface.
- Internal persisted surface and view identifiers remain unchanged during this implementation.
- Package pruning and proposal-generation admission-policy redesign remain separate follow-ups.

## Phase ledger

| Phase | Scope | Status | Verification |
|---|---|---|---|
| 1 | Truthful product language, entry points, and comparison Changes-lens restoration | complete | 40 focused tests pass; web typecheck passes; targeted lint/comments/format/diff pass; Atlas typecheck has one unrelated existing fixture cast error |
| 2 | Additive native Impact capability, contract, RPC, service projection, and client query | complete | 32 focused tests pass; contract/client typechecks pass; server typecheck is baseline-red only in unrelated tests; targeted lint/comments/format/diff pass |
| 3 | Shared native Impact presentation in Proposal Review and Diff | complete | 34 focused tests pass; web typecheck and targeted lint/comments/format/diff pass |
| 4 | Lazy Advanced Atlas opening with exact lease/recovery ownership | complete | 23 focused tests pass; web typecheck and targeted lint/comments/format/diff pass; stale-result and StrictMode review findings repaired |
| 5 | Documentation, focused builds, integrated web acceptance, and packaged desktop smoke | complete | desktop closure build, staged Cartographer smoke, Electron smoke, arm64 ZIP integrity/content checks, and isolated Proposal Review/Repository Atlas browser acceptance pass; live Diff ready-result acceptance was interrupted by unrelated concurrent server-watch restarts |

## Approved invariants

1. Proposal and diff comparison authority continues to come from exact retained generation IDs;
   browser callers never supply filesystem paths or artifact locations.
2. Exact totals are calculated before witness-list truncation. The UI never derives a safety claim
   from a bounded witness list.
3. Current-worktree and standing-project targets remain single-graph Advanced Atlas contexts; the
   native Impact RPC does not invent a `HEAD` comparison for them.
4. A ready analysis performs zero Atlas-open calls until the explicit Advanced action.
5. Existing request fencing, restart recovery, exact-origin validation, and close-once lease
   ownership remain intact after the Advanced gate is introduced.

## Deferred work

- Dedicated analyzer executable and production archive slimming.
- Standalone CLI/MCP compatibility decisions.
- True proposal-analysis admission changes after an admissible performance measurement.
- Mobile presentation.
- Provider approval/dispatch split-brain presentation.

## Closeout evidence

- Focused implementation verification passed across contracts, server handlers, client runtime,
  Proposal Review, Diff Impact, Atlas URL restoration, and Advanced Atlas lease ownership.
- Contracts, client runtime, and web typechecks pass. Atlas typecheck remains red only at the
  pre-existing `embedReadOnly.test.ts` fixture cast. The server-wide typecheck remains red in
  unrelated concurrent provider-recovery and pre-existing Cartographer-core diagnostics; none of
  the native Impact-owned server paths reports an error.
- The complete `build:desktop` dependency closure passes for Cartographer core, Atlas, web, server,
  and Electron. Staged Cartographer and Electron runtime smokes pass.
- A fresh arm64 ZIP package builds through the production staging path. Archive integrity passes,
  and the archive contains the Electron app, bundled server/client, Cartographer server/CLI/web
  artifacts, and the patch-preview worker.
- Isolated browser acceptance verifies Proposal Review naming, Narrative/Changes/Impact tabs,
  exact native Impact totals and bounded evidence with zero iframe, explicit Advanced Atlas entry,
  Back-to-Impact restoration, and the separate Repository Atlas surface. The Diff surface exposes
  Changes/Impact and the correct unavailable state; repeated unrelated server watcher restarts
  prevented a stable live ready-result pass, while the mounted Diff lifecycle regressions cover
  ready, stale, re-analysis, Advanced entry, and lease cleanup.
