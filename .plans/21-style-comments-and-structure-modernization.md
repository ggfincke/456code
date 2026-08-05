<!-- .plans/21-style-comments-and-structure-modernization.md -->
<!-- phase shared style adoption, private docs, and structural cleanup -->

# Plan: Style, Comments, and Structure Modernization

## Status

Completed at the approved scope on 2026-08-01. The execution ledgers below
record Phases 0-4, including single quotes and the high-confidence structural
waves. Implementing the separately designed `ChatView`, `ws`, and
`ClaudeAdapter` splits remains approval-gated by plan 23; those proposed
follow-ups do not keep this modernization plan active. Permanent publication
remains out of scope.

Review baseline: `main` at `1d078d3029d781f034dccd58440ac8731fd65328`
on 2026-08-01. Re-ground the live branch, working tree, generated surfaces, and
active plans before starting any phase.

## Objective

Merge the strongest repository conventions from TierListBuilder with the
existing 456code architecture and toolchain:

- adopt Allman braces, no routine semicolons, and single quotes for owned
  JavaScript and TypeScript
- adopt the shared low-noise comment style as an enforced 456code convention
- preserve `.plans/` as the tracked, repository-visible planning surface
- make `dev-docs/` an ignored local surface for non-public working material
- split oversized files and crowded directories only where a real ownership,
  lifecycle, or dependency boundary exists

The target is a maintainable 456code house style. This is not a wholesale copy
of TierListBuilder's dependencies or directory tree.

## Settled Decisions

### Formatting profile

| Setting | 456code decision | Source of the decision |
| --- | --- | --- |
| brace style | Allman | TierListBuilder convention |
| semicolons | `false` | TierListBuilder convention |
| quotes | single | TierListBuilder convention; explicitly accepted |
| trailing commas | `all` | retain 456code's modern TypeScript default |
| indentation | 2 spaces | shared convention |
| print width | 100 | retain 456code's density; Allman already adds height |
| arrow parentheses | always | shared convention |

The intended Prettier options are:

```json
{
  "plugins": ["prettier-plugin-brace-style"],
  "braceStyle": "allman",
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "tabWidth": 2,
  "printWidth": 100,
  "arrowParens": "always"
}
```

Defensive automatic-semicolon-insertion guards remain valid where a leading
token could otherwise join the previous expression. No grep-based or lint rule
may ban every semicolon.

### Tool ownership

- Prettier with `prettier-plugin-brace-style` exclusively formats owned
  JavaScript and TypeScript.
- Oxfmt continues to format non-overlapping formats such as JSON, CSS,
  Markdown, and YAML.
- Oxlint remains the JavaScript and TypeScript linter, including the local
  `oxlint-plugin-456code` rules.
- Vite+, `vp staged`, and `.vite-hooks/pre-commit` remain the repository's
  command and hook surfaces.
- ESLint, Husky, and lint-staged are not imported solely to reproduce
  TierListBuilder's implementation.

Prettier and Oxfmt must never both own the same JavaScript or TypeScript file.
Stock Oxfmt would erase the Allman layout even if it also emitted no routine
semicolons.

### Comment profile

Every covered owned source file eventually follows this contract:

- exactly two opening comment lines: repo-relative path, then an untagged
  lowercase purpose phrase
- plain lowercase comments above the unit they explain, with no side comments
- block documentation reserved for larger constructs such as classes,
  interfaces, enums, actors, protocols, and similarly substantial types
- only `*`, `!`, `?`, and `TODO` as structured comment tags, used sparingly
- ASCII `->`, stable symbol and module references, and no source line-number
  references

Generated, vendored, third-party, and format-owned output is exempt. Shebangs
remain above the two-line header. Swift keeps its language-specific `MARK`
syntax and tooling directives.

### Documentation ownership

| Surface | Tracking | Responsibility |
| --- | --- | --- |
| `docs/` | tracked | maintained public product, architecture, and operations documentation |
| `.plans/` | tracked | publishable implementation plans, decisions, checkpoints, and closeout state |
| `dev-docs/` | ignored | local non-public audits, speculative designs, raw evidence, and working notes |
| `AGENTS.md` | tracked | concise contributor and agent rules with links to maintained tracked guides |

A tracked plan must be self-contained. It may acknowledge optional local
evidence, but it must not require an ignored `dev-docs/` file to explain its
scope, decisions, or acceptance criteria. Ignored storage is not secret
storage; credentials and tokens do not belong in `dev-docs/`.

### Structural policy

Line count and direct-child count are triage signals, not automatic reasons to
split. A move or extraction needs at least one repository-backed boundary:

- distinct product or domain ownership
- distinct state, lifecycle, or side-effect ownership
- a narrower dependency direction or public contract
- an independently understandable rendering or transformation unit
- a directory grouping that communicates a stable feature or provider domain

Do not create one-function files, speculative shared abstractions, barrel
indexes, or directory layers that merely rename an existing pile of files.
Keep facades where they protect callers from an internal migration.

## Current Baseline

A current mechanical inventory across `apps/`, `packages/`, `scripts/`,
`oxlint-plugin-456code/`, and `tests/`, excluding generated and dependency
output, found:

| Signal | Current count |
| --- | ---: |
| owned source and test files in the measured languages | 2,143 |
| JavaScript and TypeScript family files | 2,120 |
| approximate exact two-line JavaScript/TypeScript headers | 421 |
| approximate JavaScript/TypeScript header backlog | 1,699 |
| files at or above 1,000 lines | 106 |
| files from 600 through 999 lines | 111 |
| directories with more than 10 direct measured files | 55 |

The header scan is an estimate until the final checker defines every exemption
and proper-name case. Its purpose is to establish that migration must be
batched, not to create a permanent baseline allowlist.

Current pressure points include:

- `apps/web/src/components/ChatView.tsx` at roughly 6,700 lines
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` at roughly 4,200 lines
- `apps/web/src/components/Sidebar.tsx` at roughly 3,600 lines
- `apps/web/src/composerDraftStore.ts` at roughly 3,600 lines
- `apps/server/src/ws.ts` at roughly 3,100 lines

The existing `vp fmt` command currently owns all formatting through Vite+, and
`vp staged` runs that formatter for every staged path. The Vite+ formatter
ignores `.plans/`; preserve that exclusion during the initial formatter
baseline so unrelated historical plans are not churned.

`dev-docs/` currently contains three tracked documents and four untracked
documents, and it is not ignored. The private working files remain user-owned
throughout this migration.

## Phase 0: Policy and Documentation Boundary

### Changes

1. Add a tracked contributor guide under
   `docs/contributing/comment-style.md` containing the repository's complete
   comment and formatting contract.
2. Keep `AGENTS.md` concise: record mandatory rules and link to the tracked
   guide rather than duplicating its full rationale.
3. Reconcile `.plans/README.md` with every current plan and record each plan's
   active, superseded, completed, or historical status without deleting plans
   merely because their paths or commands are stale.
4. Extract any still-active decisions from the three tracked `dev-docs/`
   records into suitable tracked plans, then stop tracking the original files
   while preserving the local copies.
5. Add `dev-docs/` to `.gitignore` and verify both existing and newly created
   local files with `git check-ignore`.

### Boundaries

- Do not move raw non-public audit prose into `.plans/` merely to retain it in
  Git.
- Do not delete the four current untracked `dev-docs/` files.
- Do not make existing tracked plans depend on local private evidence.
- Do not combine documentation-boundary changes with formatter churn.

### Acceptance

- a fresh clone receives every mandatory convention and every active plan
- `dev-docs/` is absent from normal Git status while existing local files
  remain readable
- `.plans/README.md` accurately indexes the tracked planning surface
- documentation links and targeted Markdown formatting checks pass

### Phase 0 execution ledger

Tracked documentation patch, 2026-08-01:

- completed `docs/contributing/comment-style.md` as the self-contained formatting, comment,
  language, exemption, and change-hygiene guide
- linked the guide and recorded `docs/`, `.plans/`, and `dev-docs/` ownership in the project section
  of `AGENTS.md`
- replaced the partial `.plans/README.md` list with a complete status-calibrated inventory
- preserved the durable approval-gated core-review remediation work in the self-contained
  `.plans/22-core-review-remediation.md` instead of promoting raw audit prose

Lead integration completed the repository-state portion of Phase 0:

- add `dev-docs/` to `.gitignore`
- stop tracking the three existing `dev-docs/` records while preserving their local copies
- verify the existing and newly created local files with `git check-ignore`

All seven local files retained identical SHA-256 hashes across the transition. `git check-ignore`
confirmed both formerly tracked and already-local files resolve through the new `dev-docs/` rule.
Phase 0 is complete.

## Phase 1: Formatter Ownership and Mechanical Baseline

### Changes

1. Add repository-pinned Prettier and `prettier-plugin-brace-style` versions,
   using the settled formatting profile above.
2. Exclude JavaScript and TypeScript from Oxfmt ownership while retaining
   Oxfmt for its non-overlapping formats.
3. Make root write, check, staged-file, and CI commands call the same partition
   so local hooks and CI cannot disagree.
4. Prove formatting idempotence by running the aggregate write command twice
   and requiring an empty second diff.
5. Apply the JavaScript and TypeScript mechanical baseline as a dedicated
   change, separate from comment rewrites and structural refactors.

### Prototype gate

Before formatting the repository, verify the exact Vite+ integration available
at the implementation revision. If `vp fmt` cannot delegate JavaScript and
TypeScript to repository-owned Prettier, add the smallest root command wrapper
needed to preserve the existing `fmt`, `fmt:check`, and staged-file interfaces.
Do not introduce a second task runner.

### Acceptance

- representative TS, TSX, JS, JSX, MJS, and CJS fixtures emit Allman braces,
  no routine semicolons, and single quotes
- JSON, CSS, Markdown, and YAML remain under one formatter only
- a second formatter pass produces no diff
- focused formatting and lint commands pass on the changed tooling
- the baseline revision is recorded in `.git-blame-ignore-revs` after its hash
  exists, without rewriting unrelated history

Formatting-only work does not add or modify runtime tests.

### Phase 1 execution ledger

The formatter partition and comment-rule prototypes landed in temporary
checkpoint `76d50a09ff02dfeee7187b74575e4bc2327ef658`:

- Prettier 3.9.6 with `prettier-plugin-brace-style` owns JavaScript and
  TypeScript; Oxfmt owns the remaining supported formats
- root write, check, staged-file, and CI commands use the same partition
- six local Oxlint comment rules and the cross-language checker passed focused
  positive, negative, and safe-fix fixtures
- generated, vendored, private, native-project, and format-owned outputs are
  explicitly excluded

The clean-file-only mechanical baseline is
`36a357a1ce7df86e16b6f13c0bc2fefecfd1ebc0`. A repeated repository formatting
pass retained the identical tracked JavaScript and TypeScript content hash
`d75e1f15bfdf1f6d545cb72aaa9239873836412ca9823115248828ceff521123`. The
baseline is recorded in `.git-blame-ignore-revs`; pre-existing user changes and
their staged state were excluded and preserved. Phase 1 is complete.

## Phase 2: Comment Rules and Semantic Migration

### Enforcement design

Prototype Oxlint comment-token and filename support inside
`oxlint-plugin-456code`. Prefer local Oxlint rules for JavaScript and
TypeScript when they can reliably enforce the contract. If an exact rule is
not expressible through the current plugin API, use one repository-owned
checker for the unsupported languages or checks rather than importing ESLint.

The final gate covers:

- exact path and purpose headers
- canonical comment tags
- lowercase plain-comment starts with identifier and proper-name exemptions
- block documentation only on the permitted larger constructs
- no inline comments and no Unicode arrows

### Migration order

1. Land the checker and validate its behavior on small explicit fixtures
   without making the legacy repository fail globally.
2. Enable semantic comment rules first and clean violations by package or
   feature boundary.
3. Require complete compliance immediately for every new, moved, or
   substantially revised source file.
4. Keep the exact file-header rule scoped to migrated roots until structural
   paths stabilize.
5. Track the shrinking backlog in this plan rather than committing a permanent
   exception list for every legacy file.

### Acceptance

- every migrated root passes the same non-mutating local and CI check
- comments explain intent, ownership, ordering, or constraints instead of
  narrating visible syntax
- durable design history moves to tracked maintained docs or publishable plans
- no behavior changes are mixed into comment-only batches

### Phase 2 execution ledger

The migration completed in bounded application, package, test, tooling, and
native batches. The final JavaScript/TypeScript rules reject invalid headers,
block-doc use, tags, inline prose, Unicode arrows, and plain-comment casing.
The cross-language checker applies the same header and comment contract to
owned shell, Python, Swift, and Kotlin sources while preserving shebangs and
language tooling directives.

Temporary migration scripts were removed after the backfill. The final
repository check reports no comment errors; unrelated lint warnings remain
outside this plan. Generated schemas, vendored sources, private docs, native
project output, and format-owned artifacts retain narrow explicit exemptions.

## Phase 3: Structural Reorganization

Every moved or split file adopts the final formatter and comment contract in
the same phase, including its final repo-relative header. Preserve behavior,
public imports, Effect service boundaries, and test mirroring unless a phase
explicitly approves a contract change.

### Wave A: high-confidence client boundaries

- split `MessagesTimeline` into minimap, grouping, and row presentation units
- split `composerDraftStore` into model, persistence, and runtime facade units
- split `SettingsPanels` by route-owned panel while retaining route assembly
- split `session-logic` into pending-turn, worklog, and timeline ownership
- split mobile `ThreadFeed` and `threadActivity` along feed presentation and
  worklog/state boundaries

### Wave B: high-confidence server and infrastructure boundaries

- extract the pure provider message-to-command mapping from
  `ProviderRuntimeIngestion`
- group SSH scripts and helpers by connection, installation, and transport
  ownership
- group source-control implementations by provider while preserving explicit
  package subpath imports
- separate ACP normalization from transport/runtime orchestration
- reorganize root scripts by build, release, development, and repository
  maintenance responsibility

### Wave C: separately designed high-risk files

`ChatView`, `ws`, and `ClaudeAdapter` require their own dependency and state
ownership designs before extraction. Their size alone is not an approved split
design. For each one, first identify the stable facade, state owner, side-effect
owner, and focused regression surface; then approve a dedicated sub-plan.

### Preserve unless evidence changes

Keep flat migration ordering, generated schema files, Effect Service/Layer
pairs, preview and terminal managers, `ExactGitSnapshot`,
`ProjectionSnapshotQuery`, platform-native view implementations, CSS entry
files, UI primitives, and route registration structures intact unless a later
review demonstrates a concrete boundary problem.

### Directory rule

Audit any directory with more than 10 direct owned files, but reorganize only
when at least three files share a stable feature, provider, lifecycle, or
platform owner. A folder must make imports and ownership easier to predict; it
must not exist only to reduce a file count.

### Acceptance per wave

- no mixed client, server, native, and script wave in one review unit
- moved tests continue to mirror their source paths under `tests/`
- explicit imports and package exports remain valid; no convenience barrels
- the smallest relevant existing tests, formatter, lint, and package
  typechecks pass
- any user-visible behavior change receives the required integrated client
  verification; a behavior-preserving refactor is reported as such

New tests are not implied by a file split. If a phase exposes a major unguarded
contract, propose that focused test separately before modifying the suite.

### Phase 3 execution ledger

Completed behavior-preserving boundaries:

- client timeline rendering now has explicit grouping, row, and minimap units
  behind the existing `MessagesTimeline` facade
- composer drafts now separate model selection, persistence, and runtime while
  retaining the exact `composerDraftStore` export surface
- settings panels, session logic, mobile thread activity, and mobile feed rows
  have feature-owned modules behind their former entry paths
- SSH remote-script construction is separated from tunnel lifecycle behind the
  existing package facade
- source-control implementations and mirrored tests are grouped by provider
  without barrels or changed external imports
- provider runtime event-to-activity mapping is separated into the pure
  `ProviderRuntimeEventMapping` module while the ingestion module retains the
  established export path

Focused client checks passed 192 tests across web timeline/session,
composer/settings, and mobile thread-activity surfaces. SSH passed 14 focused
tests and its package typecheck. Source control passed 173 tests across 14
focused files. The provider-runtime mapping and ingestion surfaces pass all 46
current focused tests. An earlier diagnostic run temporarily supplied the
concurrently developed `AttachmentLifecycleRepository`; the concurrent work
has since added that same service to the maintained harness, so no diagnostic
test edit remains.

Two reviewed Wave B items intentionally produce no file moves:

- ACP normalization already lives in `AcpCoreRuntimeEvents`,
  `AcpRuntimeModel`, and provider extension modules, separate from
  `AcpSessionRuntime` transport/lifecycle ownership
- root scripts already distinguish reusable helpers under `scripts/lib/`;
  moving command entrypoints into category folders would change documented
  command paths without creating a stronger runtime boundary

Wave C's required current-state designs are recorded in
`.plans/23-high-risk-large-file-boundaries.md`. Their implementations remain
separately approval-gated as required by this plan.

## Phase 4: Header Completion and Strict Gates

### Changes

1. Recount the remaining owned-source backlog after all approved moves.
2. Backfill exact path and purpose headers in bounded package batches, writing
   a meaningful purpose phrase rather than deriving it from the filename.
3. Resolve remaining semantic comment violations without changing behavior.
4. Enable the exact-header rule for every owned source root in local lint,
   staged-file checks, and CI.
5. Remove temporary migrated-root scoping and confirm no permanent legacy
   allowlist remains.

### Acceptance

- every covered file has exactly two correct header lines
- generated, vendored, and format-owned exemptions are explicit and narrow
- staged checks reject a newly missing or stale path header
- moving a file requires updating its header in the same change
- all formatter and comment checks are idempotent and non-conflicting

### Phase 4 execution ledger

The final gate is global for every covered owned root. `vp staged` partitions
formatting and comment checks by language, and CI runs the same aggregate
`comments:all:check` command. The environment-scoped legacy opt-in was removed,
and no per-file legacy allowlist remains.

On 2026-08-01, a repository write pass followed by `fmt:check` and
`comments:all:check` completed successfully. The native header batch and final
strict tooling gate are isolated in temporary orchestration checkpoints; final
publication remains out of scope.

## Commit and Review Boundaries

When implementation is approved, keep these concerns separate:

1. documentation ownership and `dev-docs/` ignore transition
2. formatter dependencies, command partition, and fixtures
3. mechanical Allman, no-semicolon, and single-quote baseline
4. comment enforcement plus bounded package migration batches
5. one structural wave or high-risk sub-plan per review unit

Do not commit or publish these phases as one repository-wide blob. Preserve
unrelated dirty work and private `dev-docs/` material throughout.

## Verification Policy

- Re-ground branch, head, status, ignored files, and running processes before
  each phase.
- Use targeted format, lint, typecheck, and existing test commands for the
  affected packages; do not run routine repository-wide suites locally.
- Backend behavior changes require focused tests for the changed behavior.
- Frontend feature or user-visible behavior changes require the repository's
  integrated web or mobile verification pass after integration.
- CI owns the complete repository-wide verification suite.

## Completion Criteria

This plan is complete only when:

- Allman braces, no routine semicolons, and single quotes are deterministic
  across write, check, staged-file, and CI surfaces
- the comment contract is tracked, enforced, and satisfied across all covered
  owned source files
- `.plans/`, `docs/`, `dev-docs/`, and `AGENTS.md` have distinct and consistently
  applied responsibilities
- every approved large-file and crowded-directory change has a documented
  ownership boundary and preserved behavior
- temporary migration scopes are removed and the final gates are strict

## Decision Log

| Date | Decision |
| --- | --- |
| 2026-08-01 | retain `.plans/` as the tracked planning convention |
| 2026-08-01 | make `dev-docs/` ignored and non-public |
| 2026-08-01 | prioritize comment-style adoption during modernization |
| 2026-08-01 | adopt Allman braces and no routine semicolons |
| 2026-08-01 | adopt single quotes while retaining 100-column width and trailing commas everywhere supported |
