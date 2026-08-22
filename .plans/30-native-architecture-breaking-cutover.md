<!-- .plans/30-native-architecture-breaking-cutover.md -->
<!-- execute the current-only native architecture contract cutover and dogfood setup -->

# Plan: Native Architecture Breaking Cutover and Dogfood Setup

## Status

COMPLETE. This amendment supersedes only the compatibility commitments in
[plan 29](29-native-architecture-views-product-rescue.md). Plan 29 remains the historical product
rescue and implementation record. The authority, security, immutability, graph UX, and evidence
requirements introduced there remain current unless this amendment explicitly replaces them.

At the user's direction, all implementation phases complete before any test edits or test runs.
Luna subagents source read-only context; Sol/root owns every repository edit. The final phase then
updates the focused tests, runs bounded checks, and leaves one authenticated dogfood environment
available for inspection.

## Breaking boundary

The product now has one current Native Architecture protocol. This cutover removes only adapters
introduced or retained for older Impact, Repository Map, Architecture Scope, Atlas Index, analyzer
manifest, and project-metadata shapes. It does not authorize removing unrelated provider,
orchestration, checkpoint, graph-history, or migration compatibility.

The only current schemas are:

- Planned Impact payload and projection version 1;
- ArchitectureGraphProjection version 1;
- Atlas Index version 6;
- project Atlas metadata version 2; and
- analyze-trees manifest version 2 with required `impact-projection.json`.

Version tags remain on these current wire and artifact boundaries for validation. A version tag
without an alternate decoding branch is not a compatibility layer.

## Canonical contracts

### Capability and RPC policy

- Remove `architectureGraphViewsV2`. Existing `architectureImpact` means the environment has the
  analyzer needed by the one native architecture product; it never selects an older protocol.
- Remove the raw `cartographer.getArchitectureImpact` application RPC and its V1/V2 UI result
  union. Retain raw `impact.json` as sealed exact evidence and retain the MCP
  `architecture_graph_diff` engine surface.
- Keep `cartographer.getArchitectureImpactProjection` as the only Impact Diff application query.
- Keep the existing Repository Map and Architecture Scope RPC method names, but give each one
  current request schema and one `ArchitectureGraphProjection` result. Remove request/response
  unions, the request-side `projectionVersion` selector, and V1 public result types. The sole
  `ArchitectureGraphProjection` response retains its required version-1 validation tag.
- Remove `legacy-artifact` and `legacy-index`. Obsolete or incomplete immutable evidence fails
  through current invalid or unavailable errors.

### Artifact and ready-state policy

- Atlas Index v5, project metadata v1, and analyze-trees manifest v1 are not decoded.
- Every ready proposal or diff result requires the canonical sealed raw GraphDiff, semantic Impact
  projection, changed-file authority, retained base/head source-tree digests, and all existing
  containment and digest validation.
- Lifecycle and migration columns may remain nullable. The ready service boundary may not return a
  nullable raw diff, semantic projection, changed-file count, or immutable source identity.
- Old labels-only Impact artifacts, legacy filenames, paired-graph re-diffing, and optional retained
  base-source fallback are removed.
- Mutable standing caches may rebuild an invalid index from current graph authority. An immutable
  published generation never reinterprets or silently upgrades an old index.

### Admission policy

- Durable architecture admission is the only proposal-generation start and retry authority.
- Remove manual client/server start fallback, unadmitted-row lookup, and adoption of unkeyed
  generations.
- Missing Planned Impact remains a valid current state, so `plannedImpactRef` stays optional.
- Missing or corrupt Verified evidence fails closed and never reads current workspace bytes for an
  obsolete immutable resource.

### Web and persistence policy

- Impact Diff, Diff, Proposal Review, Orchestrate, and Explorer consume only exact projection
  descriptors and `ArchitectureGraphProjection`.
- Repository Map owns Architecture and Structure drill-down. The standalone Architecture Scope
  resource and legacy canvas/presenter stack are removed.
- Internal Cartographer and Atlas identifiers with one current implementation remain. This is not
  an internal cosmetic rename.
- Right-panel storage moves to version 13. Migration preserves unrelated tabs, exact architecture
  source files, current exact Impact descriptors, and current standing Repository Map resources.
  It drops obsolete comparison-bound raw Impact and standalone Scope resources.
- Composer storage stays at version 11 with its additive architecture concern migration and current
  add, remove, dedupe, promotion, retry, and exact-once serialization behavior.

## Upgrade and failure behavior

- A normal Repository Map preparation may replace an invalid mutable standing cache by building a
  current generation. An immutable old pin reports unavailable.
- Historical ready proposal/diff rows without current semantic evidence remain stored but are not
  readable as ready results. A newly admitted retry creates a new generation.
- Historical proposals without durable admission do not start analysis through a fallback.
- Servers advertising architecture analysis implement the current RPCs. The client has no
  older-server architecture view fallback.
- Reverted plans remain absent from active lookup while exact pinned Planned and Verified resources
  retain their historical read-only status.

## Execution ledger

| Phase | Scope | State | Evidence |
| --- | --- | --- | --- |
| 0 | Record this breaking amendment and register it. | complete | This file and `.plans/README.md`. |
| 1 | Collapse Cartographer core and shared contracts to current-only schemas. | complete | Atlas v6-only core, current Map/Scope inputs, projection-only responses, and raw Impact application RPC removal are implemented; verification is deferred to Phase 4. |
| 2 | Collapse server artifacts, projections, and durable admission lifecycle. | complete | Metadata v2, manifest v2, canonical sealed GraphDiff/projection/source identities, projection-only Map/Scope handlers, and admitted-only starts are implemented; verification is deferred to Phase 4. |
| 3 | Collapse web runtime, right-panel persistence, and maintained documentation. | complete | Projection-only Impact and Repository Map presenters, in-map Scope drill-down, v13 resource migration, obsolete presenter/RPC removal, and the documented current minimum contract are implemented; verification is deferred to Phase 4. |
| 4 | Update focused tests, run bounded checks, and complete retained dogfood acceptance. | complete | Compatibility-only tests were removed, current-only fixtures were reconciled, all bounded gates passed, and the authenticated `.456code/dev` dogfood environment remains running with a verified Map -> Impact -> anchor -> concern flow. |

## Phase 4 closeout evidence

- Focused contract, Atlas, projection-artifact, admission, RPC, web projection, composer, and v13
  storage tests passed. The final in-worktree cache regression run passed 22 checks across three
  focused files after exposing and fixing a source-development materialization failure.
- Cartographer core built before server verification. Affected contracts, core, server, and web
  type checks passed. Targeted formatting, lint, comment-style, and `git diff --check` passed; the
  remaining diagnostic output is the repository's existing suggestion-only baseline.
- A live-source scan found no exact raw Impact RPC, architecture view capability fork, legacy
  artifact/index errors, V1/V2 Map or Scope result unions, or retired raw presenter modules. The
  current projection response keeps only its version-1 validation tag.
- The pre-migration database was backed up consistently at
  `.456code/dev/userdata/state.sqlite.pre-070-20260821-110731`; its integrity check is `ok` and its
  migration high-water mark is 51. The retained live database has migration high-water mark 70 and
  all four migration-070 Native Architecture tables.
- Repository Map built from the registered 456code project. Architecture rendered 10 systems and
  21 relationships; Structure rendered 8 root objects and 14 relationships, then drilled into
  `apps/` as four exact child directories.
- Exact working-tree analysis against HEAD produced a sealed ready generation with raw GraphDiff,
  semantic projection, immutable sources, 167 changed files, 10 projected systems, and 21 projected
  relationships. Selecting Server Runtime exposed bounded evidence and exact source actions.
- The selection opened Server Runtime in its pinned standing generation with an explicit older-map
  disclosure. Adding the concern created one local `Server Runtime` architecture chip, sent no
  turn, survived a backend restart, and left the selected thread Settled. Browser error logs were
  empty at handoff.
- Dogfood exposed that exact tree materialization correctly rejects direct writes into a worktree,
  while source development stores its ignored server cache under `.456code`. Diff and proposal
  generation now materialize through an external stage, require the in-worktree cache to be Git
  ignored, and publish the completed tree into the owned cache only after exact materialization
  succeeds.

## Final acceptance

After all implementation edits:

1. Delete compatibility-only tests and update only the major contract, Atlas, artifact, admission,
   server RPC, projection UI, and storage-migration coverage under root `tests/`.
2. Build Cartographer core before server checks, then run affected contracts/core/server/web type
   checks plus targeted formatting, lint, comment-style, focused tests, and `git diff --check`.
3. Assert live source contains no `architectureGraphViewsV2`, `legacy-artifact`, `legacy-index`, raw
   Impact application RPC, Map/Scope request or response unions, or legacy architecture presenter.
4. Back up `.456code/dev/userdata/state.sqlite`, start the source web stack against `.456code/dev`,
   and allow the retained database to migrate through migration 070.
5. Use the existing 456code project to build and inspect Repository Map Architecture and Structure,
   analyze the working tree against HEAD as Impact Diff, inspect a selection, follow its standing
   anchor, add a non-sending concern chip, and leave the authenticated environment running.

No full workspace test suite, mobile pass, automatic panel open, or automatic maximize belongs to
this acceptance phase.
