<!-- .plans/held-upstream-reconciliation-20260827.md -->
<!-- reconcile the six held upstream candidates through current feature boundaries -->

# Held upstream reconciliation

Status: implementation, focused source gates, and required web/native integration passed.
Six approved feature commits and publication are next; GitHub CI and held-ref retirement remain gated.

## Bound state and authority

- Integration branch: `codex/held-upstream-reconciliation-20260827`.
- Starting main: `b8dc96333651cde93e65797d91e9929327d90612`.
- Starting tree: `9045df8b601235602b6efca15646e21e9d3eab3c`.
- The original main checkout remains untouched. Implementation uses an isolated worktree with
  worktree-local dependency files and caches; only the normal pnpm content store is shared.
- Node `24.19.0`, pnpm `11.10.0`, and existing dependency versions are retained. The frozen
  installation passed before feature work. No dependency upgrade is part of this plan.

The user wants worthwhile behavior incorporated into current main and the two held branches
retired afterward. Preserve the following exact source refs until reviewed adaptations are
published, required checks pass, and the coordinator performs final reconciliation:

| Source ref | Held full OID |
| --- | --- |
| `refs/heads/456code/upstream-sync-2026-08-04` | `b69e412d2c3db8cf512e5f29949f8518385d0da4` |
| `refs/heads/456code/upstream-sync-effect-bump` | `6aa38706364591669c209825db2b8394ff5336b7` |

Do not raw-push those historical branches, create recovery bundles/directories, or discard a
held ref before its useful behavior has a reviewed disposition. Do not touch unlisted refs,
tags, unrelated user changes, or the original checkout. No release is authorized.

## Six-candidate ledger

| Source full OID | Intended behavior | Current disposition | Verification status |
| --- | --- | --- | --- |
| `941738d8dbdf0e80d5721ad531b87dbe2d081218` | Search and navigate settings. | Adapted to current web settings ownership. | Source and integrated browser gates passed; publication pending. |
| `e952ca27f785dbfbf9f265c6116aa4375424ab41` | Search project file contents and open a result. | Adapted bounded server grep and current web file/search controls. | Shared/web source and integrated browser gates passed; publication pending. |
| `91794c2a5cdc8c1f316131e25d11c0689c5024d9` | Preserve useful mobile legacy-model selection behavior. | Adapted explicit lifecycle metadata to current provider inventories and model menus; obsolete layouts are not restored. | Source and integrated web/native gates passed; publication pending. |
| `6bcdf3ed39c4649e1f6275648a02e5b73d66043e` | Find mobile conversations by canonical message content. | Shared bounded server search and client atoms now feed both compact Home and wide Sidebar, including legacy/v2 rows. | Shared/mobile source and integrated web/native gates passed; publication pending. |
| `5fe0ca448cdd8f222b2f4d8803fffe097822a088` | CLI pairing convenience. | Adapted convenience behavior to the existing live pairing endpoint and storage-owner lease. | Source gates and real CLI credential creation/native consumption passed; publication pending. |
| `6aa38706364591669c209825db2b8394ff5336b7` | Treat explicit blank telemetry configuration as opt-out. | Preserved explicit blank semantics with the installed Effect configuration API. | Focused tests and targeted static gates passed; publication/CI pending. |

Search foundations also adapt `d4bb55435be15f73dc27ece06656a0a3b5325eb5` and
`b209d4626da69061084e07c4cdc5495f06c4e7f5` from the held history. These mixed historical
commits are behavioral references, not cherry-pick units. The installed Effect API already
preserves empty strings; no unsupported configuration option or dependency update will be added.

## Approved phases and ownership

1. **Preparation — complete.** Verify clean main, exact held refs, canonical origin, and the
   absent integration path/branch; create the isolated worktree and install frozen dependencies.
   The final preparation check found no dependency symlinks into the original checkout and
   confirmed unchanged original manifest, lockfile, dependency metadata, and Git configuration.
2. **Wave 1 — source gates complete.** Three non-overlapping Sol workers own shared search foundations
   and this ledger; telemetry/CLI; and web settings respectively. Search contracts and query
   registrations are handed to the UI worker before client implementation. All tests stay in
   the mirrored root `tests/` tree. Workers do not commit, publish, or start integrated servers.
3. **Client adaptation — complete.** Integrate the approved project/file search controls,
   conversation results, and still-relevant mobile model behavior into current web/native
   surfaces. Reuse the shared RPC/query factory; do not revive historical component layouts.
   Preserve each worker's explicit file ownership and run focused gates before integration.
4. **Integration passed; publication pending.** The coordinator ran one isolated web pass and
   one representative native pass after integrating affected client work and resolved scoped
   failures. Group changes into one coherent commit per feature. Publish reviewed changes,
   require all current-head CI checks, merge through the approved workflow, and verify main.
   Only then reconcile and retire the exact held refs. No broad local test suite or release.

## Search interfaces and invariants

`projects.searchContents` accepts a canonicalized workspace root, a whitespace-significant
nonempty query of at most 256 characters, a limit from 1 through 500, and explicit case-sensitive,
whole-word, and regex flags. Results contain relative paths, one-based line numbers, line text,
JavaScript string match ranges converted from native UTF-8 byte offsets, truncation state, and
an optional regex-fallback explanation. The existing `@ff-labs/fff-node` `0.9.4` cursor API is
used with a 250 ms budget and 100 matches per file. A separate lazy content index has a five-minute
idle lifetime; filename indexing does not pay content-indexing cost. Resource cleanup remains
scope-owned. The budget is checked before each result and after asynchronous containment work,
so a large native page cannot multiply it through unbounded filesystem postprocessing. Already
collected results survive exhaustion with `truncated: true`. Whole-word filtering is applied to
validated ranges after native matching.

`orchestration.searchThreads` accepts a trimmed query of 2–200 characters and at most 50 results.
It searches only canonical user/assistant messages from active, nonarchived, nondeleted threads
and projects, excludes streaming messages, escapes SQL LIKE `!`, `%`, and `_`, and returns one
ranked match per thread. Snippets are at most 240 characters. Both new RPCs require the existing
read authorization scope; no database migration or broad error-constructor refactor is needed.

Shared client search debounces for 200 ms, fans out only to connected environments, and uses the
existing public RPC query factory for cancellation and stale-result suppression. File-picker
browse accepts an empty filename query and optional entry kind. New picker/search keybindings
are added without evicting persisted user rules.

Mobile uses the same connected-only debounce and query-length bounds. Content matches augment,
not replace, title/project matches; environment-scoped keys prevent collisions and duplicates.
Both Home and the wide Sidebar pass updated query/match maps through virtualized list extra data.
Literal snippets retain user/assistant source labels without changing queue-failure metadata,
settled/reactivation ordering, or the empty-query layout. Failed searches fall back to local
title filtering rather than retaining previously successful content matches.

## Approved verification

Focused search regressions cover the important boundaries only:

- SQL wildcard escaping, ranking, exclusions, and query/result/snippet bounds.
- Read authorization for both new RPCs.
- Native grep budgets/caps, UTF-8 range conversion, invalid-regex fallback, whole-word behavior,
  and content-index disposal; existing scan mocks use `waitForIndexReady` where required.
- Client debounce, disconnected-environment exclusion, cancellation, and stale-result suppression
  through the public RPC query factory.
- Feature-specific settings, CLI, telemetry, and client-control tests within their assigned
  implementations; no exhaustive matrices or unrelated test expansion.

Run the smallest mirrored test sets, affected package typechecks, and changed-file formatting,
lint, comment/header, and diff checks. Do not run repo-wide `vp check`, workspace typecheck, or
the full local suite. The coordinator owns integrated web/native verification, required GitHub
CI, and exact final receipts. A missing or failed gate remains pending rather than being waived.

## Current receipts and remaining work

Settings source gate: 12 focused files / 63 tests passed (six new cases in two files), targeted
web typecheck passed, and 14 owned-file lint, format, comment, and diff checks passed. The static
catalog audit found 44 items and no missing declared anchors. Integrated browser proof passed.

Web project/conversation search source gate: seven focused files / 19 tests passed, targeted web
typecheck passed, and 16 owned-file format/header/diff checks passed. Lint exited successfully
with five pre-existing `OpenCommandPaletteDialog` warnings. Tests exercise the actual search
dialogs and active project selection, literal line highlighting, palette logic, and UI state.
Integrated browser proof passed.

Telemetry source gate: six focused tests passed with injected HTTP clients; targeted server
typecheck, lint, comments, and diff checks passed. Explicit blanks remain distinct from unset;
no real telemetry delivery occurred during tests.

CLI pairing source gate: four focused files / 22 tests passed across pairing, HTTP authorization,
runtime metadata, and telemetry; server typecheck and owned formatting/lint/header checks passed.
The real `pair --help` command verifies registration. Live issuance uses only the existing pairing
POST endpoint after verifying loopback storage-owner authority, exact live lease/PID identity,
canonical base, and environment identity; it grants only standard client scopes, follows no
redirects, and never opens a second live auth database. The display URL is separate from the
loopback issuance URL. Real CLI credential creation and native consumption passed.

Shared search source gate: five server files / 62 tests, two contract files / 60 tests, and two
client-runtime files / 26 tests passed. Targeted server, contracts, and client-runtime typechecks
passed. Native fixtures exercised UTF-8 ranges, case/whole-word matching, invalid-regex literal
fallback, canonical alias reuse, and symlink escape rejection. Deterministic regressions cover
query-wide per-file caps, total native/containment budget, scope disposal, SQL ranking/exclusions/literal
escaping, read scopes, and public-RPC debounce/cancellation/late-result isolation. Search atoms
expose raw query state and accept connected-environment IDs; pending old queries are dropped
immediately while the next query debounces. The public-RPC regression also checks short queries
and failed refreshes do not expose stale content matches. Integrated web/native proof passed.

Mobile conversation source gate: three focused files / 35 tests passed, targeted mobile typecheck
passed, and the combined 38 owned search/mobile TypeScript files passed formatting, comments,
and diff checks. Lint exited successfully with only three pre-existing schema-hoist warnings.
The new cases cover title/content union with environment/archive scope, unchanged empty-query
results, reactivation/settled ordering, and literal Unicode-safe snippet highlighting. These
source tests do not substitute for the required native integrated pass.

The search owner used the pinned Node 24 path and direct local executables, without triggering
dependency installation. Exact focused invocations, run from their package directories:

```sh
# apps/server
../../node_modules/.bin/vp test run workspace/WorkspaceSearchIndex.test.ts workspace/WorkspaceEntries.test.ts orchestration/Layers/ProjectionSnapshotQuery.test.ts ws/rpcAuthorization.test.ts keybindings.test.ts
# packages/contracts
../../node_modules/.bin/vp test run project.test.ts orchestration.test.ts
# packages/client-runtime
../../node_modules/.bin/vp test run state/threadSearch.test.ts state/runtime.test.ts
# apps/mobile
../../node_modules/.bin/vp test run features/home/homeThreadList.test.ts features/threads/sidebar/threadListV2.test.ts features/threads/sidebar/threadSearchHighlight.test.ts
```

`../../node_modules/.bin/tsc6 --noEmit` passed from server, contracts, client-runtime, and mobile.
Root-local Prettier, `vp lint`, and `node scripts/check-js-comments.ts` were restricted to owned
TypeScript paths; `git diff --check` passed. The server type gate required only the targeted
Cartographer declaration build, which completed successfully. No full workspace suite ran.

Legacy-model policy: an explicit distinct, nonblank Codex `upgrade`
or `upgradeInfo.model` target marks a superseded model; retain default, current, unknown, and custom
models normally, without expanding hidden inventory. Claude may explicitly mark Opus 4-8/4-7/4-6/4-5
and Sonnet 4-6 as superseded; Haiku 4-5 remains the current fast choice. Optional `isLegacy` is only
presentation metadata: old payloads remain normal and every model stays selectable. Legacy-model
source gates passed six focused files / 36 tests and targeted contracts/server/web/mobile
typechecks. All 16 owned TypeScript files passed formatting/comments; lint passed with existing
warnings only, and documentation formatting/diff checks passed. Integrated web/native model-menu
verification passed after the narrow native accessibility correction described below.

Preparation: frozen installation succeeded with Node `24.19.0` and pnpm `11.10.0`; both checkouts
were clean and held refs unchanged. The new shell initially selected Node 26; that installation
attempt was interrupted before preparation and rerun with explicit Node 24. The targeted
Cartographer prerequisite build later completed for server verification.

Source tests, targeted typechecks, final cross-feature source review, and client integration passed.
Commit grouping, publication, main-head CI, and source-ref retirement remain pending.
Update this section with exact commands and outcomes as each owning phase closes; do not infer
completion from source similarity or an earlier campaign.

## Final source integration checkpoint

The Sol xhigh combined review found no blocking mismatch across the six approved intents.
It checked current settings routes/anchors and focus handling; loopback-only pairing issuance
with standard scopes and no live-database bypass; blank telemetry configuration semantics;
canonical authorized conversation search and connected-only client state; native grep caps,
containment, lifecycle, and literal fallback; and explicit model lifecycle metadata that never
disables selection. The fixed held-history range did not expand into a new nightly audit.

The combined focused rerun passed **41 files / 323 tests**:

| Scope | Files | Tests | Focus |
| --- | ---: | ---: | --- |
| Server | 11 | 95 | Workspace indexes, projection search, authorization, keybindings, pairing, runtime state, telemetry, Codex and Claude inventories. |
| Contracts | 3 | 69 | Project, orchestration, and provider model schemas. |
| Client runtime | 2 | 26 | Thread search and the existing public query runtime. |
| Web | 21 | 95 | Settings, search dialogs, active workspace, palette, and model selection. |
| Mobile | 4 | 38 | Home/v2 conversation filtering, snippets, and model menu options. |

Targeted server, contracts, client-runtime, shared, mobile, and web typechecks all exited zero.
The web typecheck retains existing non-finite-schema suggestions in unchanged code. The focused
production web build passed in 11.11 seconds, including the existing dynamic HEIC decoder; its
existing chunk-size, sourcemap, and mixed-import warnings remain warnings. A subsequent tiny
presentation repair removed a duplicated regex-fallback sentence; its focused dialog test and
the final production build (11.49 seconds) both passed after that repair.

All 96 changed TypeScript/TSX files passed formatting, lint, and comment/header checks. Lint
reported only existing warnings in touched files; unrelated cleanup was deliberately omitted.
There is no dedicated shared keybindings test file: an attempted focused selector reported no
tests and is not counted as a pass. Shared defaults are exercised by the passing server
keybindings suite and shared package typecheck.

The original checkout was clean at the starting main OID after the combined run. Local main,
origin/main, and both held refs still match the exact OIDs above. At that point, 300 direct,
scoped dependency, and cache links across 15 discovered package roots showed no broken links
or links into the original checkout; inspected package/cache configuration contained no original
checkout path references. The lockfile is unchanged. These are point-in-time checks, not an
assertion that every ignored cache byte is identical. Verification commands owned by the source
worker terminated; the coordinator's isolated integration services remain active for UI proof.

## Integrated client checkpoint

The primary agent verified one authenticated isolated web environment and the representative
iOS development client against that same backend. These are live application observations,
separate from the source tests above:

- Settings search opened the source-control route and exact hash target, focused the destination,
  supported `/` search focus, and retained the route after empty results/Escape.
- `Cmd+P` found workspace filenames. `Cmd+Shift+F` exercised case-sensitive, whole-word,
  invalid-regex literal fallback, and Unicode content search, and opened a result at line 42.
  The final fallback explanation appeared once after the small presentation repair.
- Web conversation search found both user and canonical-assistant message matches and removed
  stale results when the query changed.
- The web Claude picker showed four current and five legacy entries. Keyboard navigation
  skipped the legacy heading, selected Opus 4.8, preserved that selection after reopening,
  and supported search/favorites. The temporary favorite was undone.
- The real `pair` CLI issued the credential consumed by the iOS client. A keyword absent from
  the thread title returned the assistant-message match with a highlighted `Agent:` excerpt;
  clearing the search removed the excerpt. Live simulator viewing used the same device.

Native legacy-model selection passed after a narrow three-file accessibility correction.
The native menu overlay, rather than its child label, now owns the button role and selected-model
label at both existing model-menu callsites. `ControlPillMenu` gained only the corresponding
React Native accessibility prop types; no dependency or selection behavior changed. The final
mobile rerun passed four files / 38 tests, the targeted typecheck, and changed-file static checks.

After reloading the current Metro bundle, semantic simulator automation exposed the selected
model button, opened adjacent current and legacy Claude groups, selected Claude Opus 4.8, and
confirmed that selection after reopening. The normal group contained Fable 5, Opus 5, Sonnet 5,
and Haiku 4.5; the separate legacy group contained the five explicitly superseded models.
Input-automation and stale-bundle/reload issues were verification-tool glitches that were
resolved, not product defects. The missing native button accessibility was a real product
correction and was verified live on the same simulator. No real provider turn ran outside the
disposable mock. Owned integration services and temporary client state are cleaned explicitly.

The final pairing cleanup exposed one additional accessibility gap: native environment-row
expand/remove controls lacked semantic action targets. Their existing handlers are unchanged;
button roles, unique name/URL labels, and expanded state now permit selecting only the temporary
environment without touching pre-existing Keychain entries. Existing pairing/environment cleanup
tests (two files / 12 tests), mobile typecheck, and changed-file static checks passed. This narrow
pairing-lifecycle correction belongs to the CLI feature commit. The primary then expanded only
the uniquely labeled temporary environment, selected its remove action, and confirmed through
the native dialog. A fresh semantic snapshot retained the two pre-existing environments and
removed only the task-added environment and its fixture project. No private storage was edited.

Owned backend, web, Metro, and simulator-stream processes terminated, their four listeners
closed, and the representative simulator shut down. The disposable 107 MB server base was
moved recoverably to Trash because the execution guard refused permanent removal; it was not
permanently deleted. The pre-existing native app artifact, app data, and Keychain entries were
preserved. This is temporary verification-state cleanup, not a new source archive or backup.

Read-only GitHub refresh at this checkpoint found live main unchanged at the starting OID,
no published reconciliation branch/PR, and main's completed CI checks successful (two expected
non-applicable jobs skipped). No staging, commits, remote writes, or source-ref cleanup occurred.

## Coherent feature commit plan

The user approved one commit per feature. All integrated client gates have closed, and local
commit preparation uses this dependency order:

| Order | Proposed commit | Scope |
| ---: | --- | --- |
| 1 | `fix(telemetry): honor explicit blank opt-outs` | Analytics service, its focused tests, and telemetry documentation. |
| 2 | `feat(cli): pair with a verified running local server` | Pair command/registration, exact pairing HTTP authorization, runtime/lease metadata, focused tests, and pairing docs. |
| 3 | `feat(settings): search and focus settings controls` | Settings catalog, current sidebar/routes/layout anchors, and focused settings tests. |
| 4 | `feat(search): search workspace files and contents` | Project contracts/RPC, native indexes, canonical workspace entry service, filename/content UI, shortcuts, and focused tests. |
| 5 | `feat(search): find conversations by message content` | Orchestration contracts/projection/RPC, shared query atoms, web palette snippets, both mobile list surfaces, and focused tests. |
| 6 | `feat(models): group explicitly superseded models` | Provider lifecycle producers, optional contract field, native/web model menus, focused tests/docs, and this complete reconciliation plan. |

The workspace and conversation concerns share `packages/contracts/src/rpc.ts`,
`apps/server/src/ws/rpcAuthorization.ts`, its new mirrored test, `apps/web/src/state/queries.ts`,
and `OpenCommandPaletteDialog.tsx`. Stage exact feature hunks in those files rather than whole
files: commit 4 adds only workspace RPC/query/actions, and commit 5 adds conversation RPC/query/
snippets. The authorization regression first covers the workspace method, then extends to both
methods when conversation search lands. Other changed files belong wholly to one feature.
Verify each staged diff is coherent and the final committed tree equals the verified working
tree; do not create an archive or recovery branch. Publication and exact held-ref retirement
remain coordinator-gated until all integrated and GitHub checks pass.
