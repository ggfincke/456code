<!-- .plans/25-t3code-upstream-selective-porting.md -->
<!-- plan the manual adaptation of 17 selected upstream t3code changes -->

# Plan: Selective t3code Upstream Porting

## Status

**Proposed — implementation is not authorized or started.**

This plan covers every upstream change previously classified as appropriate to
port from `pingdotgg/t3code`. “Port” means reproduce the selected behavior at
the current 456code owner. It does not mean merge, pull, or cherry-pick the
upstream commits.

Evidence baseline:

- Local immutable base: `40a2b10267bf9df970eadc45d69f14e6b45229aa`
- Prior upstream tracking point: `7537adc30f41059afcfeb8bd20368cb0acfce293`
- Reviewed upstream head: `4f5834ba72c5905a318c00456dd21271b2fa9d6f`
- Upstream window: 35 commits
- Selected adaptations: 17 commits
- Orchestration run: `t3code-port-plan-17-v8m4`
- Research result: 10/10 read-only workers completed at the immutable base;
  every broker verification passed with zero changed files and zero scope
  violations

The shared checkout became dirty with unrelated desktop/tray and
`AppSidebarLayout` work during research. That work is user-owned and outside
this plan. Future implementation must re-ground the live checkout and preserve
those changes.

## Intended outcome

Land the 17 selected behaviors through seven concern-scoped pull requests. Each
PR must be independently buildable and revertible, except where this plan marks
an internal cutover as atomic. The final state must:

1. Preserve provider compatibility without weakening runtime validation.
2. Reduce snapshot payload cost without losing client-visible tool state.
3. Preserve every physical workspace represented by a logical project group.
4. Fix the selected web and mobile interaction defects at their current owners.
5. Isolate GitHub Release publication from the shared Release App quota while
   preserving stable-finalization identity and branch behavior.

## Non-negotiable invariants

- Do not merge or cherry-pick the upstream range. Apply each behavior manually.
- Do not restore removed cloud, relay deployable, launcher, or managed-tunnel
  architecture.
- Keep xterm as the web terminal owner. Do not import upstream Ghostty web-font
  settings or create `SettingsFontPreviews.tsx` merely to accept a stale hunk.
- Preserve the native `WorkersPanel`, current right-panel surfaces, current web
  project ordering, primary-environment preference, remote-environment
  presentation, and grouped-project labels.
- Full orchestration payloads remain in persistence. Projection is a transport
  boundary, not a data-retention or secret-redaction boundary.
- Tests remain under root `tests/`, mirroring source paths without `src`.
- Follow Allman braces, no semicolons, single quotes, exact two-line file
  headers, lowercase plain comments, and ASCII `->`.
- Add only major regression tests. Do not test Tailwind class strings, exact
  copy literals, screenshots in unit tests, or implementation-only snapshots.
- Mobile remains pre-1.0: do not add a compatibility reader, migration, or
  dual-write for `projectGroupingEnabled`. The old boolean is intentionally
  ignored after cutover; an absent valid mode resolves to `repository`.
- Do not push, release, deploy, dispatch a workflow, create a tag, seed shared
  state, or mutate an external provider without separate authorization.

## Commit disposition ledger

| # | Upstream commit | Selected behavior | Local disposition | Phase |
| ---: | --- | --- | --- | --- |
| 1 | `3d429662c` | Kimi/OpenCode-compatible preview schemas | Adapt contracts annotations and root server test | 1A |
| 2 | `47dfc6526` | Preserve grouped physical workspaces on mobile | Adapt through shared builder plus web/mobile cutovers | 3 |
| 3 | `3c5bdb84a` | Truncate long project-switcher names | Adapt current `DraftHeroHeadline` styling and titles | 4C |
| 4 | `9235c83eb` | Keep command menu anchored during panel motion | Adapt extracted command-menu layer | 4A |
| 5 | `9697b765e` | Isolate release API quota | Adapt release job and operations guide; retain finalize App token | 7 |
| 6 | `37d3667de` | Refresh model shortcut labels | Adapt extracted model-picker owner | 4B |
| 7 | `de592a00e` | Enrich terminal font previews | Port mobile and showcase portions; reject absent web hunk | 6B |
| 8 | `3da315e7b` | Slim MCP result payloads | Adapt current activity transport projector | 2A |
| 9 | `1ffba7093` | Preserve plan-sidebar dismissal across navigation | Adapt session-scoped per-thread subject identity | 5A |
| 10 | `a483337a0` | Honor timestamp format in snooze labels | Adapt current web-owned snooze helpers and callers | 5B |
| 11 | `b7d1981b5` | Drop superseded tool updates from snapshots | Adapt conservatively; reject unconditional dropping | 2B |
| 12 | `e4abc31f1` | Pin intentional interleaved-collapse divergence | Combine with 2B using local evidence only | 2B |
| 13 | `ab3b55e29` | Clarify Auto permission fallback | Change extracted footer-mode copy only | 4D |
| 14 | `99d91ddaa` | Keep unknown ACP approvals actionable | Map ACP fallback to `dynamic_tool_call` | 1B |
| 15 | `470d4eb99` | Make mobile pending cards opaque | Adapt nested activity-card owners | 6A |
| 16 | `aa16c180e` | Align composer inline chips | Adapt only local wrapper/skill-label offsets | 4E |
| 17 | `4f5834ba7` | Clear Woke only on explicit actions | Adapt successful-action acknowledgement atomically | 5C |

All 17 commits have an implementation destination. “Reject” below always
means rejecting a subhunk or obsolete dependency, not silently dropping the
selected behavior.

## Explicitly excluded upstream context

The following are not prerequisites for this plan:

- Update, launcher, cloud, and managed-tunnel commits from the 35-commit window.
- Ghostty/configurable web-font commits, including the hidden
  `8eca20005b47e197b3610f7996f3fd02355c1891` dependency behind the absent web
  preview.
- The broad upstream agent-observability parent around `3da315e7b`; current
  456code already has native Workers ownership and top-level agent metadata.
- Upstream colocated or legacy `apps/server/test` test paths.
- Upstream database counts, byte percentages, or claims that every completion
  is a payload superset. Current-provider evidence must stand on its own.
- Unrelated Android header margin changes and stale file-facade edits in
  `47dfc6526`.

## Dependency graph

```text
P0 rebaseline
 |
 +-> P1A preview schema
 +-> P1B ACP fallback
 +-> P2A MCP projection -> P2B conservative update collapse
 +-> P3G0 shared grouping builder
 |     +-> P3Gweb web behavior-preserving cutover -> P4C project truncation
 |     +-> P3Gmobile atomic mobile cutover
 +-> P4A/P4B/P4D/P4E independent web fixes
 +-> P5A plan dismissal
 +-> P5B snooze formatting
 |     +-> P5C Woke actions (after P5A and P5B due shared owners)
 +-> P6A/P6B independent mobile visual fixes
 +-> P7 release isolation
```

`P3G0`, `P3Gweb`, and `P3Gmobile` may be separate commits in one PR. The
mobile cutover itself is atomic: preferences, settings, home grouping,
new-task selection, and obsolete-helper removal must not land separately.

## Recommended PR and commit sequence

| PR | Scope | Internal commits | Dependency |
| --- | --- | ---: | --- |
| 1 | Provider compatibility | 2 | P0 |
| 2 | Server transport projection | 2 | P0 |
| 3 | Shared/mobile grouped workspaces | 3 | P0 |
| 4 | Web composer/model/project polish | 5 | P3Gweb only for project truncation |
| 5 | Plan, snooze, and Woke state | 3 | P0; P5C follows P5A/P5B |
| 6 | Mobile pending cards and terminal preview | 2 | P0; preferably after P3Gmobile for one mobile campaign |
| 7 | Release token isolation | 1 | P0; privileged review required |

Suggested commit messages:

- `fix(provider): preserve forward-compatible approvals and preview schemas`
  may be split into `fix(mcp)` and `fix(acp)` if review ownership differs.
- `perf(server): slim MCP activity payloads`
- `fix(server): conservatively collapse completed tool updates`
- `refactor(client-runtime): centralize project group construction`
- `refactor(web): delegate project grouping to client runtime`
- `fix(mobile): preserve grouped physical workspaces`
- Keep each of the five Phase 4 web behaviors as its own `fix(web)` commit.
- Keep plan dismissal, snooze formatting, and Woke acknowledgement as three
  commits even if they share `ChatView` or `SidebarV2`.
- `fix(mobile): make pending request cards opaque`
- `fix(mobile): enrich terminal appearance previews`
- `fix(ci): isolate GitHub release credentials`

## Phase 0 — rebaseline and conflict gate

### Entry criteria

- Implementation has separate user approval.
- Record live `HEAD`, `upstream/main`, branch, tracked/untracked/ignored state,
  and active processes.
- Establish ownership of every dirty path. Do not assume the checkout remains
  equal to this plan’s immutable base.

### Procedure

1. Fetch only `upstream/main` if a refresh is authorized.
2. Re-run the 17-commit file ledger against the implementation base.
3. If unrelated dirty work remains, use an in-place synthetic snapshot for
   exact comparison or work around it by disjoint paths; do not reset it.
4. Re-check every current owner named below. Stop if later local work already
   implemented or materially redesigned a selected behavior.
5. Create no temporary orchestration commits in the real branch.

### Exit gate

A checkpoint records the exact base and either confirms this plan unchanged or
updates the affected phase before implementation begins.

## Phase 1 — provider compatibility

### Phase 1A — preview schema descriptions (`3d429662c`)

Current owners:

- `packages/contracts/src/previewAutomation.ts`
- `tests/apps/server/mcp/toolkits/preview/tools.test.ts`

Design:

1. Keep `BoundedUrl` trimmed, non-empty, and limited to 2048 characters.
2. Remove the description from the reusable `Schema.isNonEmpty()` check.
3. Define one `URL_GUIDANCE` string in the contracts module.
4. Apply complete guidance at the three provider-facing properties:
   `PreviewAutomationOpenInput.url`, `BrowserNavigationTarget` direct URL, and
   `PreviewAutomationNavigateInput.url`.
5. Do not change `normalizePreviewUrl`, navigation cardinality, http(s)
   enforcement, toolkit registration, or server execution logic.

Why: Effect’s generated schema can compose reusable checks and field
annotations through `allOf`. Multiple description-bearing members break the
Kimi/OpenCode consumer, while moving documentation outward preserves runtime
validation.

Major regression:

- Extend the existing preview toolkit test to recursively reject multiple
  described `allOf` members in the affected schemas.
- Retain existing decode assertions for blank, oversized, and invalid
  navigation combinations; do not duplicate them.

### Phase 1B — unknown ACP approvals (`99d91ddaa`)

Current owners:

- `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts`
- `tests/apps/server/provider/acp/AcpCoreRuntimeEvents.test.ts`
- `packages/client-runtime/src/thread-activity/pendingRequests.ts` already
  recognizes `dynamic_tool_call`

Design:

1. Change `AcpCanonicalRequestType` to include `dynamic_tool_call` rather than
   `unknown`.
2. Preserve execute/read/edit/delete/move mappings exactly.
3. Map every other non-empty ACP permission kind to `dynamic_tool_call` for
   both opened and resolved events.
4. Leave global canonical `unknown` non-actionable. Only the ACP normalizer
   receives the forward-compatible fallback.
5. Do not change provider response callbacks, request IDs, replay, persistence,
   or UI action components.

Major regressions:

- Add one table covering known and future ACP kinds for both opened and
  resolved events.
- Add one shared pending-request test only if no existing test proves that
  `dynamic_tool_call` becomes a command-style actionable request. The owner is
  `tests/packages/client-runtime/thread-activity/pendingRequests.test.ts`, not
  a duplicate web session test.

### Focused Phase 1 gates

```sh
(cd apps/server && pnpm exec vp test run provider/acp/AcpCoreRuntimeEvents.test.ts mcp/toolkits/preview/tools.test.ts)
(cd packages/client-runtime && pnpm exec vp test run thread-activity/pendingRequests.test.ts)
pnpm exec vp run --filter @t3tools/contracts --filter @t3tools/client-runtime --filter 456code typecheck
```

Run the shared pending-request command only if that new test is warranted and
added. Run targeted formatter, comment, and lint checks over the changed phase
files.

### Runtime acceptance and limits

- Cursor/Grok ACP: an unfamiliar tool kind must render actions, accept or
  decline through its existing option IDs, and resolve once.
- OpenCode with Kimi: preview tools must register and valid open/navigate calls
  must execute.
- OpenCode with another available model: repeat tool registration to guard a
  provider-general regression.
- Reconnect while the provider process remains alive must keep an approval
  actionable. A server/provider restart may use the existing stale-terminal
  failure; this phase does not persist callbacks.
- If those providers or credentials are unavailable, record the provider
  cells as unverified. Deterministic schema and event tests still gate merge,
  but they do not justify claiming live Kimi/Grok acceptance.

### Rollback and stop conditions

The schema and ACP changes are independently revertible and migrate no data.
Stop if known mappings change, a response does not settle its provider
callback, malformed canonical requests become actionable, generated schemas
retain competing descriptions, or runtime URL constraints weaken.

## Phase 2 — server transport projection

Current owners:

- `apps/server/src/orchestration/ActivityPayloadProjection.ts`
- `tests/apps/server/orchestration/ActivityPayloadProjection.test.ts`
- `packages/client-runtime/src/thread-activity/worklogNormalization.ts` is the
  client presentation reference, not a new server dependency

### Phase 2A — MCP payload slimming (`3da315e7b`)

Replace only the current `mcp_tool_call` pass-through.

Codex-shaped `data.item` keeps:

- `type`, `id`, `tool`, `server`, `status`, `arguments`
- `appContext`, `error`, `durationMs`
- an optional summarized `result`

Claude-shaped top-level data keeps:

- `toolName`, `input`, `toolCallId`, and `kind` when present
- an optional summarized `result`

All shapes keep file references found by the existing bounded walker. Outer
activity fields, including `agentId` and `parentToolUseId`, survive through the
existing activity spread.

Result summarization must:

- accept a string or text blocks;
- find the first useful non-empty line;
- collapse whitespace and cap the display summary at the existing 84-character
  policy;
- avoid joining an entire large block array into another result-sized string;
- omit non-renderable result bulk and unknown metadata;
- preserve error/status presentation through retained item or outer fields.

This is slimming, not a hard cap: arguments and provider inputs remain because
clients may render them. Never describe the projection as redaction.

### Phase 2B — conservative lifecycle collapse (`b7d1981b5` + `e4abc31f1`)

The upstream unconditional drop is unsafe locally. Current client normalization
can merge command, raw command, files, title, item type, request kind, detail,
and MCP item data from an update when the completion lacks them.

Required pipeline:

1. Project each activity first.
2. Apply current context-window snapshot filtering to the projected rows.
3. Establish chronological ranks with
   `compareOrchestrationThreadActivities`; preserve the original snapshot array
   order in the returned rows.
4. Scan by turn and lifecycle identity for the nearest later completion.
5. Prefer non-empty `data.toolCallId`. Otherwise use the normalized
   `itemType`/title-or-summary/detail fallback only when it is sufficiently
   identifying; uncertain and identity-less rows remain.
6. Drop an update only when the projected completion subsumes every
   client-visible contribution the shared normalizer could take from it:
   detail, command, raw command, changed-file set, tool title, item type,
   request kind, and MCP item data.
7. Keep cross-turn, unmatched, post-completion, malformed, mismatched-ID, or
   content-bearing updates.
8. Filter snapshots only. Live and catch-up `thread.activity-appended` events
   remain projection-only.

The server-local predicate deliberately mirrors only the concrete nullish
fallback behavior. Do not import `@t3tools/client-runtime` into the server and
do not generalize this into a reusable deep-subset framework.

Interleaved parallel calls may produce fewer snapshot rows than full live
history, but only when the predicate proves that the retained completions
preserve presentation. Document that semantic tradeoff without upstream
deployment measurements.

### Major Phase 2 regressions

Extend the single root server test with:

- Codex, Claude, and current OpenCode-relevant MCP shapes;
- textual and non-textual results, errors, file references, retained outer
  agent metadata, and source immutability;
- a large synthetic sentinel proving result bulk is absent without asserting a
  deployment-specific byte percentage;
- same-turn, cross-turn, identity-less, mismatched-ID, completion-before-update,
  and repeated-identity ordering;
- an update-only command/file/detail counterexample that must survive;
- an interleaved A/B case that intentionally reduces rows only when both
  completions cover their updates;
- unchanged live-event row delivery;
- parity through the actual shared web/mobile normalizer for retained display
  fields.

### Focused Phase 2 gates

```sh
(cd apps/server && pnpm exec vp test run orchestration/ActivityPayloadProjection.test.ts)
pnpm exec vp run --filter 456code typecheck
```

Run targeted format/comment/lint checks on the projector and its root test.

### Operational acceptance

With separate deployment authorization, canary one disposable or non-critical
environment. Compare cold HTTP/WebSocket snapshot bytes and row counts for the
same synthetic MCP-heavy fixture, then exercise warm resume, live completion,
reconnect, and revert. Observe decode/cache warnings, expanded MCP/error rows,
server latency, and process memory. Do not use real sensitive tool output in
evidence.

### Rollback and stop conditions

Rollback is server-only and migration-free because persistence remains full.
A later cold snapshot restores the previous row view. Stop if any client-visible
field disappears, a revert leaves a call unrepresented, live rows are filtered,
snapshot sequence changes, client decode/cache warnings rise, or safe collapse
requires changing shared client semantics or persistence.

## Phase 3 — grouped physical workspaces (`47dfc6526`)

### Current failure

Mobile `groupProjectsByRepository` groups multiple physical workspaces under a
logical repository, but both `NewTaskRouteScreen` and `NewTaskFlowProvider`
reduce that group to `group.projects[0]`. If clone A is activity-ranked first,
clones B and C cannot be chosen even though task creation requires a physical
`(environmentId, projectId)` destination.

### Phase 3G0 — canonical shared builder

Owner:

- `packages/client-runtime/src/state/projects/projectGrouping.ts`
- new root test
  `tests/packages/client-runtime/state/projects/projectGrouping.test.ts`

Add concrete `ProjectGroup`, `ProjectGroupMember`, and `buildProjectGroups`
APIs alongside existing key/mode/label helpers. The builder must:

1. Deduplicate stale registrations by normalized physical key
   `(environmentId, workspaceRoot)`.
2. Preserve the current winner policy: prefer the configured primary
   environment for duplicate physical registrations, then freshness
   (`updatedAt`, `createdAt`), then stable project ID.
3. Use an identity-bearing duplicate as the logical identity source when the
   physical winner temporarily lacks repository identity.
4. Resolve `repository`, `repository_path`, and `separate`, including current
   per-physical overrides.
5. Keep one winner per physical workspace in `members` and every original
   scoped project reference in `memberProjectRefs` for stale-thread routing.
6. Emit groups by first logical-key occurrence in caller input so current web
   manual ordering is preserved.
7. Prefer a requested environment only for the representative, never by
   deleting other members.
8. Keep singleton labels as the physical project title and use shared
   repository labeling only for multi-member groups.

This abstraction is justified by three current duplicate constructors: web
sidebar snapshots, mobile home scopes, and mobile repository groups. It owns
group construction only; client-specific ordering and presentation stay local.

### Phase 3Gweb — behavior-preserving web delegation

Owners:

- `apps/web/src/lib/logicalProject.ts`
- `apps/web/src/lib/sidebarProjectGrouping.ts`
- `tests/apps/web/environmentGrouping.test.ts`

Replace duplicated physical-winner/group construction with shared builder
results. Preserve web-only policy:

- manual project order;
- primary-environment representative preference;
- environment labels and local/remote/mixed presence;
- `allRemoteMembersAreDesktopLocal`;
- preferred physical picker target;
- stable logical keys and every stale project ref.

The root `apps/web/src/logicalProject.ts` and
`apps/web/src/sidebarProjectGrouping.ts` are forwarding facades; edit the
nested owners only unless an export must be forwarded.

### Phase 3Gmobile — atomic mobile cutover

The following changes form one merge unit, though implementation may be
checkpointed locally:

- `apps/mobile/src/features/home/home-list-options.ts`
- `apps/mobile/src/features/home/homeThreadList.ts`
- `apps/mobile/src/features/layout/AdaptiveWorkspaceLayout.tsx`
- `apps/mobile/src/persistence/mobile-preferences.ts`
- `apps/mobile/src/state/project-grouping.logic.ts` (new)
- `apps/mobile/src/state/project-grouping.ts` (new)
- Settings route, stack, target, and Android header wiring for the three-mode
  grouping control
- nested `apps/mobile/src/features/threads/new-task/` provider, route, draft,
  and new `new-task-project-selection.ts`
- deletion of `apps/mobile/src/lib/repositoryGroups.ts` only after both home and
  new-task consumers migrate

Rules:

- Persist `projectGroupingMode?: SidebarProjectGroupingMode` only.
- Ignore and stop writing `projectGroupingEnabled`; do not translate, dual-write,
  or migrate it. Missing/invalid mode uses the contracts default `repository`.
- Logical keys identify group rows, filters, and collapsed state.
- Scoped physical project keys identify selectable workspaces and draft state.
- A multi-member group expands to explicit physical children; it never starts a
  task by choosing a representative.
- A singleton group may select its sole physical member directly.
- A deleted/invalid explicit selection returns to the picker; it never falls
  through to another group member or global `projects[0]`.
- Rename changes labels, reorder changes presentation only, and catalog reload
  retains a selection only while its scoped ref exists.
- Valid deep links keep physical environment/project params. Invalid links
  replace the draft route with the picker while retaining an incoming-share ID.
- Back from a selected draft returns to the still-expanded picker.
- Grouping mode persists; last task destination does not.
- Stale collapsed logical keys remain inert and need no cleanup migration.

The research reviewer proposed a one-way legacy boolean translation. This plan
rejects it to honor the repository’s explicit pre-1.0 no-compatibility policy.
The accepted consequence is that an old `false` value no longer preserves
“separate” after upgrade. Changing that policy requires a new approval gate.

### Major Phase 3 regressions

- Shared builder: one scenario covers physical clones, a stale duplicate,
  preferred representative, override, all retained refs, and input ordering.
- Existing web grouping suite: preserve count, labels, manual order,
  environment presence, and preferred physical target.
- Mobile home suite: all grouping modes retain every physical scope.
- New task selection: a multi-workspace group requires explicit selection and
  routes to the chosen non-representative workspace.
- Mobile preference/state test: valid mode/default/sanitization and explicit
  absence of legacy boolean compatibility.
- Delete the obsolete repository-group test with its source owner.

### Focused Phase 3 gates

```sh
(cd packages/client-runtime && pnpm exec vp test run state/projects/projectGrouping.test.ts)
(cd apps/web && pnpm exec vp test run --project unit environmentGrouping.test.ts)
(cd apps/mobile && pnpm exec vp test run features/home/homeThreadList.test.ts features/threads/new-task/new-task-project-selection.test.ts state/project-grouping.test.ts)
pnpm exec vp run --filter @t3tools/client-runtime --filter @t3tools/web --filter @t3tools/mobile typecheck
```

Run targeted format/comment/lint checks per internal commit.

### Mobile acceptance

Use the consolidated Phase 3/6 `test-t3-mobile` campaign below. The decisive
case is selecting physical workspace B while A is the group representative and
then proving the draft and terminal cwd belong to B.

### Rollback and stop conditions

Roll back Gmobile as one unit, then Gweb, then G0. No server/database schema is
involved. The new mode field becomes inert under older code; the old boolean is
intentionally not recoverable. Stop if any physical workspace or stale scoped
ref disappears, web order/labels/targeting change, group identity becomes a
task destination, or rollback compatibility becomes a new requirement.

## Phase 4 — independent web interaction fixes

These five commits share one integrated browser campaign but retain independent
source ownership and rollback.

### Phase 4A — command-menu anchoring (`9235c83eb`)

Owner: `apps/web/src/components/chat/composer/ComposerCommandMenuLayer.tsx`.

- Add a typed position value and equality guard.
- Observe the anchor plus every `parentElement` with one `ResizeObserver`.
- Keep window resize, capture-phase scroll, initial synchronous measurement,
  fixed portal coordinates, 96px minimum height, and cleanup.
- Do not edit sidebar animations, `ChatView`, or the `ChatComposer` facade.

Ancestor observation is the minimum sufficient design because capped composer
width can stay constant while animated side panels translate it. The equality
guard prevents duplicate ancestor callbacks from causing needless state work.

### Phase 4B — model shortcut invalidation (`37d3667de`)

Owner: `apps/web/src/components/chat/model-picker/ModelPickerContent.tsx`.

- Memoize `{ favoritesSet, modelJumpLabelByKey }`.
- Pass that object as `LegendList.extraData`.
- Keep row keys, data ordering, highlighted index, scroll position, and
  `ModelListRow` memoization. Do not remount the virtualized list.

### Phase 4C — project name truncation (`3c5bdb84a`)

Owner: `apps/web/src/components/chat/DraftHeroHeadline.tsx`.

- Add an inline-block maximum width, truncation, and bottom alignment to the
  current trigger classes without reverting newer border/focus styling.
- Put the complete active display name in the trigger title.
- Make each menu label a block truncation box with the complete group display
  name as title.
- Keep full DOM text, generic action aria-label, group key, and preferred
  physical target.

### Phase 4D — Auto fallback copy (`ab3b55e29`)

Owner:
`apps/web/src/components/chat/composer/ComposerFooterModeControls.tsx`.

Change only Auto’s description to:

> Supported providers approve routine actions; others still ask.

Do not hard-code provider names or add a client capability registry. The copy
describes current Codex/Claude support and Cursor/Grok/OpenCode fallback without
claiming universal AI review.

### Phase 4E — inline chip alignment (`aa16c180e`)

Owners:

- `apps/web/src/components/ComposerPromptEditor.tsx`
- `apps/web/src/components/composerInlineChip.ts`

- Apply `align-[-0.125em]` only to mention, skill, and terminal-context Lexical
  decorator wrappers.
- Add a separate composer skill-label class using
  `relative top-[0.15em]` and use it only in the editor skill decorator.
- Preserve fixed local 12px chip metrics, `leading-none`, serialization,
  content-editable boundaries, selection overlay, caret movement, and deletion.
- Do not alter rendered chat chips or import upstream configurable-font work.

The numeric offsets are provisional until the integrated browser matrix proves
them at current local metrics. If they change line height or selection coverage,
revert both offsets and recalibrate within these two files only.

### Focused Phase 4 gates

No new class-string, copy-string, or virtualizer-mock tests are required. Run
the existing editor and grouping regressions plus targeted static/type gates:

```sh
(cd apps/web && pnpm exec vp test run --project unit components/ComposerPromptEditor.test.ts environmentGrouping.test.ts)
pnpm exec vp run --filter @t3tools/web typecheck
```

The integrated browser campaign is the behavioral gate for animation,
virtualized row refresh, truncation/accessibility, exact visible copy, and chip
geometry.

### Rollback and stop conditions

Each dossier reverts independently. Stop rather than broaden scope if ancestor
observation misses transform-only motion, `LegendList` ignores `extraData`, the
full grouped label is not the desired accessible text, provider semantics have
changed, or chip offsets alter editor line boxes, selection, or caret behavior.

## Phase 5 — plan, snooze, and Woke state

### Phase 5A — plan-sidebar dismissal (`1ffba7093`)

Owners:

- new `apps/web/src/planSidebarDismissal.ts`
- `apps/web/src/session/timeline.ts`
- `apps/web/src/components/ChatView.tsx`
- existing `apps/web/src/components/chat/useChatRightPanelController.ts`

Use a module-level session map keyed by scoped thread key and a stable plan
subject key. It stores auto-open suppression, not panel visibility; actual
surfaces remain entirely in `rightPanelStore` and the controller.

Subject identity priority:

1. `turn:<turnId>` when a plan-producing turn is known.
2. `proposed:<proposedPlanId>` for a null-turn proposed plan.
3. `activity:<sourcePlanActivityId>` for a null-turn activity plan.

Extend `ActivePlanState`/`deriveActivePlanState` to expose the source activity
ID. Do not use the upstream `__dismissed__` sentinel because unrelated null-turn
plans would collide.

Transitions:

- Dismiss/toggle away records the active thread and subject.
- A -> B -> A navigation retains the entry in the current JavaScript session.
- More streamed steps for the same subject remain dismissed.
- A new subject may auto-open.
- Explicit plan activation/reopen clears only the active thread entry.
- Implement-in-current/new-thread clears only the destination entry when it
  intentionally opens plan.
- Full reload resets the module map. Do not add localStorage, cross-tab, or
  server persistence in this port.
- Never mutate or remove Workers, diff, files, preview, terminal, or explorer
  surfaces as part of dismissal tracking.

Major tests:

- New focused helper test for thread isolation, same-subject persistence,
  turn/proposed/activity identity, explicit clear, and module-reset lifetime.
- Extend existing session logic only as needed to prove the source activity ID
  is stable; do not duplicate right-panel-store coverage.

### Phase 5B — snooze timestamp format (`a483337a0`)

Owners:

- `apps/web/src/components/Sidebar.snooze.ts`
- `apps/web/src/components/SidebarV2.tsx`
- `tests/apps/web/components/Sidebar.snooze.test.ts`

- Accept `TimestampFormat` in preset and wake-description helpers.
- Use current `formatShortTimestamp`; keep snooze date math web-owned.
- Thread the preference through popover rows, both context-menu builders, and
  success toasts.
- Keep relative `snoozeWakeLabel` unchanged.
- Compare local calendar dates rather than fixed milliseconds for
  today/tomorrow/weekday classification across DST transitions.
- Keep locale tokens localized; do not assert English `AM`, `PM`, or weekday
  strings in unit tests.

Extend the existing test for format-option behavior, midnight/noon boundaries,
same-day/tomorrow/week classification, malformed input, and a DST-safe calendar
case. Avoid exact locale-output snapshots.

### Phase 5C — explicit Woke acknowledgement (`4f5834ba7`)

Owners:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/SidebarV2.tsx`
- `apps/web/src/hooks/useThreadActions.ts`
- existing `apps/web/src/stores/uiStateStore.ts` remains the watermark owner

State contract:

- Server shell `threadWokeAt` is the wake identity.
- `threadLastVisitedAtById` is the persisted local acknowledgement watermark.
- Remove the passive effect that advances the watermark merely because an open
  thread receives an update.
- Capture and write exactly the relevant wake token, never current time or
  general `thread.updatedAt`.
- A direct Woke button dismiss may acknowledge immediately.
- Normal send/start-turn and plan implementation acknowledge only after the
  start succeeds.
- Archive and settle acknowledge only after their mutations succeed.
- Failure, cancellation, interrupt, navigation, rename, un-settle, and passive
  viewing do not acknowledge.
- A callback for wake W1 may write only W1. If W2 arrives in flight, the
  monotonic watermark leaves W2 visible.
- Callbacks retain the target scoped thread key, so an action for A cannot clear
  B.
- Make Woke an accessible button while preserving neighboring hover/focus
  actions and the existing Workers/right-panel layout.

Do not create a second persisted wake map or storage migration. Existing
`markThreadVisited` is sufficient when passed the exact token.

### Focused Phase 5 gates

```sh
(cd apps/web && pnpm exec vp test run --project unit planSidebarDismissal.test.ts session-logic.test.ts components/Sidebar.snooze.test.ts uiStateStore.test.ts)
pnpm exec vp run --filter @t3tools/web typecheck
```

Run only the listed test files that actually change or cover a new invariant.
Successful-action sequencing remains an integrated browser gate unless a
small existing hook harness can cover it without introducing test-only
architecture.

### Rollback and stop conditions

No protocol or storage migration is required. Revert P5C, then P5B, then P5A.
Stop if dismissal must survive reload, null-turn plans lack stable proposed or
activity identity, Woke must sync across devices/tabs, the explicit action set
must expand, or any acknowledgement can occur before mutation success.

## Phase 6 — mobile visual fixes

### Phase 6A — opaque pending cards (`470d4eb99`)

Real owners:

- `apps/mobile/src/features/threads/activity/PendingApprovalCard.tsx`
- `apps/mobile/src/features/threads/activity/PendingUserInputCard.tsx`

Remove `/80` from the matching light and dark background tokens and add one
short reason comment to each owner. Do not edit compatibility re-exports,
extract a shared component/token, redesign response controls, or change feed
scroll behavior.

The cards are floating sticky surfaces, not modal backdrops. Whole-card fade-out
can still produce brief transition transparency; that pre-existing animation is
outside this patch unless integrated acceptance makes controls unreadable.

### Phase 6B — mobile terminal preview (`de592a00e`)

Owners:

- `apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx`
- `scripts/mobile-showcase-environment.ts`

- Enrich the terminal sample with a colored prompt, Vite readiness, URL, test
  summary, READY badge, and cursor using current mobile palette tokens.
- Reapply the terminal line style to every nested `AppText`, because `AppText`
  reapplies the sans family rather than inheriting the outer terminal style.
- Use current `456code` branding, `pnpm dev`, and version-neutral copy.
- Keep the existing terminal-size preference and platform-native terminal
  ownership. Do not add font-family selection, assets, contracts, or native
  props.
- Adapt the deterministic showcase transcript to the same semantic content and
  current 612-test fixture.
- Reject the upstream web hunk completely: no web settings preview, Ghostty
  import, xterm height change, or configurable-font persistence.

No new unit test should assert opaque classes or transcript literals. Re-run
existing appearance, terminal, and showcase tests; visual behavior is the
decisive gate.

### Focused Phase 6 gates

```sh
(cd apps/mobile && pnpm exec vp test run lib/appearancePreferences.test.ts features/terminal/terminalPreferences.test.ts features/terminal/terminalBufferReplay.test.ts features/terminal/terminalTheme.test.ts)
(cd scripts && pnpm exec vp test run mobile-showcase.test.ts)
pnpm exec vp run --filter @t3tools/mobile --filter @t3tools/scripts typecheck
```

If a listed unchanged test is not present on the implementation base, remove
it rather than creating a test merely to satisfy this plan.

### Rollback and stop conditions

Both commits are migration-free and independently revertible. Stop if a card’s
controls become unreachable at maximum text scale, Android preview text becomes
proportional, exact native family parity would require assets/native changes,
or the showcase loses essential content at the smallest supported viewport.

## Phase 7 — release token isolation (`9697b765e`)

Owners:

- `.github/workflows/release.yml`
- `docs/operations/release.md`

Exact workflow boundary:

1. Add job-level `permissions: contents: write` to `release`; keep global
   `contents: read` and `id-token: none` unchanged.
2. Delete only the release job’s `actions/create-github-app-token@v2` step and
   its Release App secret references.
3. Upgrade both mutually exclusive GitHub Release actions from
   `softprops/action-gh-release@v2` to `@v3`.
4. Pass `${{ github.token }}` to both previous-release and first-release paths.
5. Keep release asset selection, tag target, notes, and job ordering unchanged.
6. Keep the stable `finalize` job’s App-token mint, checkout token, persisted
   credential, `GH_TOKEN`, App slug/author identity, version commit, and push to
   `main` unchanged.
7. Do not restore relay deployment or import unrelated upstream workflow
   context.

The repository token isolates release creation/uploads from the custom App’s
installation quota. The App remains necessary for the intended finalize actor,
branch authorization, and downstream push behavior.

The release job receives write authority for its full lifetime. Splitting a new
publisher-only job would be a broader workflow redesign and is not part of this
port. Record it as a separate hardening candidate rather than smuggling it into
this change. Set `persist-credentials: false` on the release checkout only if
focused inspection confirms no later release step relies on Git credentials;
otherwise leave it as an explicitly documented residual risk.

Documentation must:

- state that stable finalize alone requires `RELEASE_APP_ID` and
  `RELEASE_APP_PRIVATE_KEY`;
- state that GitHub Release publication uses the repository-scoped workflow
  token and an independent quota;
- replace the unsafe “dry-run release” language: test tags and manual stable
  dispatches publish real npm versions, releases, stable aliases, and possibly
  a finalize commit;
- state that manual nightly is lower stable-channel risk but still publishes
  real external artifacts.

### Static Phase 7 gates

```sh
node scripts/format-repository.ts --check --staged .github/workflows/release.yml docs/operations/release.md
git diff --check -- .github/workflows/release.yml docs/operations/release.md
```

Additionally inspect the parsed job blocks or a focused diff and prove:

- `release` has one `contents: write`, two `action-gh-release@v3` consumers,
  two `github.token` inputs, and no App-token step or Release App secrets;
- `finalize` still has one App-token mint, both secrets, App identity lookup,
  App-authenticated checkout/push, and unchanged stable-only conditions;
- `publish_cli -> release -> deploy_web/finalize -> announcement` ordering is
  unchanged.

`actionlint` is not installed in the current repository. Do not introduce a
new toolchain dependency casually; use it only if the implementation plan is
separately amended or CI already provides it.

### External acceptance and failure boundaries

There is no safe non-publishing end-to-end release test. Do not dispatch the
workflow or push a synthetic tag for this phase.

With separate release authorization, use the next legitimate nightly to check
GitHub Release publication without an App-token mint. Use the next legitimate
stable release to separately verify that publication actor changes to GitHub
Actions while finalize commit/push actor remains the Release App and downstream
CI still triggers.

Publication may succeed before missing App credentials or branch authorization
fail in stable finalize. npm versions, tags, releases, assets, aliases, and
commits have no atomic rollback. Inspect external state before any rerun.

### Rollback and stop conditions

Before a real release, revert this workflow/docs commit normally. After
publication begins, code rollback does not undo external state. Stop if org
policy forbids `contents: write`, `@v3` inputs differ, finalize secrets or App
ruleset authority are missing, another release is running, token consumers
appear outside their intended jobs, or validation would require an unauthorized
publication.

## Integrated web acceptance campaign

After PRs 1, 4, and 5 are integrated, the primary agent must use the
`test-t3-app` skill once against one isolated environment. Do not run multiple
competing dev servers.

Setup:

1. Create disposable app state and two disposable clones sharing one repository
   identity, including one long logical project label.
2. Launch the isolated environment and authenticate through its printed pairing
   URL.
3. Use only synthetic, non-sensitive tool payloads and provider requests.
4. Seed data only through the skill-supported disposable path; never alter the
   user’s normal app state.

Acceptance matrix:

| Surface | Actions | Required evidence |
| --- | --- | --- |
| Preview/provider | Register preview tools; open/navigate; exercise unfamiliar ACP kind when providers exist | Tool registration, valid execution, actionable approval, provider limitations recorded |
| Command menu | Keep slash menu open while toggling/dragging left sidebar, opening/resizing right panel, resizing window, and scrolling | Menu remains directly above and width-matched to composer throughout animation |
| Model picker | Change relevant shortcut context/keybinding while rows remain recycled; invoke shortcuts | Visible labels refresh and activate the matching model without remount/focus loss |
| Project switcher | Use long grouped local/remote names by keyboard and pointer | Visual truncation, complete accessible text/title, correct preferred physical target |
| Auto copy | Inspect mode description with supported and fallback providers | Exact intended claim without universal reviewer promise |
| Inline chips | File, skill, and terminal chips over wrapping lines at 80/100/125/200% zoom in both themes | Stable baseline/line height, complete selection highlight, caret and deletion correctness |
| Plan dismissal | Dismiss plan A, navigate A -> B -> A, stream same subject, create new subject, explicitly reopen; repeat with Workers surface present | Same subject stays closed, new subject opens, reload follows documented reset, Workers untouched |
| Snooze | Switch locale/12/24-hour while popover opens; use context menu and toast | All surfaces agree with preference across boundary times |
| Woke | Passive visit/update, direct dismiss, failed and successful send/plan/settle/archive, later wake during an action | Passive/failure retain Woke; only exact successful token clears; later wake survives |

Capture screenshots/semantic labels for static UI, a short recording for menu
motion and chip selection, and sanitized protocol evidence only where needed.
Stop the owned server and remove only disposable state after verification.

## Integrated mobile acceptance campaign

After PRs 3 and 6 are integrated, the primary agent must use
`test-t3-mobile`. Prefer one compatible iOS Simulator on macOS; use Android when
iOS is unavailable or when verifying Android-specific font fallback. Do not
rebuild a native client merely to satisfy this plan without separate approval.

Setup:

1. Create one disposable backend plus clones A, B, and C sharing a repository
   identity, and one unrelated repository.
2. Make A the activity-ranked representative.
3. Pair one representative simulator through a fresh token.
4. Seed only disposable pending approval/input states and message-heavy content.

Acceptance matrix:

| Surface | Actions | Required evidence |
| --- | --- | --- |
| Group modes | Switch repository, repository-path, and separate; relaunch | Correct groups and persisted new mode; no dependence on legacy boolean |
| Physical selection | Expand A/B/C group, choose B, enter draft, open terminal | Draft environment/project and terminal cwd are B, never A by representative fallback |
| Lifecycle | Rename/reorder, reload catalog, delete selected B, use valid/invalid deep links, navigate Back | Stable explicit selection while valid; picker fallback when invalid; no silent retarget |
| Accessibility | Inspect parent and child rows plus three mode controls | Expanded/radio/disabled semantics, distinct physical labels, >=44pt targets |
| Pending cards | Approval and user-input cards over dense feed, light/dark, keyboard open, responding, simultaneous, resolving | No static text bleed; controls remain reachable; transition limitation recorded |
| Terminal preview | Automatic/min/default/max size, light/dark, Dynamic Type, relaunch, real terminal | Five-line sample readable; size persists; native terminal reflects it |
| Showcase | Compact iOS plus Android when available | Prompt/READY/status visible without composition-breaking wrap |

Because Android uses different native font assets and scaling, a targeted Android
visual check is required for a complete cross-platform claim. If unavailable,
report the limitation rather than treating iOS as proof of Android rendering.
Stop only owned backend, Metro, simulator stream, and serve-sim processes; delete
only disposable state.

## Per-phase static gate template

For each TypeScript implementation commit, substitute only its explicit changed
files:

```sh
node scripts/format-repository.ts --check --staged <changed-files>
node scripts/check-js-comments.ts <changed-files>
pnpm exec vp lint <changed-files>
```

Then run the phase’s package-scoped typecheck and smallest named test files.
Do not run repo-wide `vp check`, typecheck, build, or test locally. CI owns full
workspace coverage.

## Risk and rollback matrix

| Risk | Prevention | Rollback |
| --- | --- | --- |
| Unknown ACP request remains stranded | Opened/resolved table plus live provider cell | Revert ACP mapping only |
| Preview schemas register but runtime validation weakens | Generated-schema and existing decode gates | Revert contracts annotation move |
| MCP projection loses display/debug fields | Provider-shape, outer-metadata, parity, sentinel tests | Revert Phase 2A; persistence remains full |
| Lifecycle collision drops a live/incomplete call | Nearest-later, same-turn, conservative subsumption | Revert Phase 2B only |
| Grouping hides or misroutes a workspace | Shared clone scenario plus explicit B selection | Revert atomic mobile cutover, then web/G0 |
| Plan dismissal collides for null-turn plans | proposed/activity subject fallback tests | Revert session helper/controller wiring |
| Woke clears newer activity | Exact captured token after success only | Revert P5C; stored timestamps remain valid |
| UI offset/animation differs by environment | Controlled browser matrix at zoom/theme/layout states | Revert individual Phase 4 dossier |
| Mobile preview claims native parity | Describe approximation and test actual terminal separately | Revert Phase 6B only |
| Release publishes but finalize fails | Static actor boundary plus legitimate staged acceptance | Code revert cannot undo publication; inspect external state |

## Stop-the-line conditions

Stop the current phase and update this plan if any of the following occurs:

- A selected behavior now has a different local owner or is already present.
- Implementing a fix requires an excluded cloud/relay/launcher or Ghostty-font
  dependency.
- A server completion cannot prove it covers an update’s projected
  client-visible contribution.
- A logical project key must be accepted as a task destination.
- Preserving old `projectGroupingEnabled` becomes a requirement.
- Plan dismissal must survive reload or synchronize across devices.
- Woke acknowledgement must cover more actions than this plan names.
- Mobile verification requires an unapproved native rebuild.
- Release validation requires a tag, dispatch, publish, deploy, or push without
  explicit authority.
- Unrelated dirty work overlaps a planned owner and cannot be safely isolated.

## Reviewer reconciliation

The two adversarial reviews were not accepted mechanically:

- The architecture review covered the correct 17 commits and supplied the
  projection-before-collapse, physical-selection, and null-turn plan identity
  corrections adopted above.
- The validation review supplied useful package-local command, test-restraint,
  release-warning, and integrated-campaign guidance, but its final coverage
  audit substituted out-of-scope `7537adc30` and `7251f1a1f` for selected
  `9235c83eb` and `de592a00e`. Those substitutions and its Ghostty/xterm flash
  proposal were rejected.
- Its recommendation to store dismissal in the persisted right-panel store was
  rejected because the selected lifetime is session-only and dismissal is an
  auto-open policy, not a second surface owner.
- Its recommendation to dual-write the legacy mobile boolean was rejected by
  the pre-1.0 compatibility policy.
- Its publisher-job split remains an optional security hardening proposal, not
  part of this selected upstream port.

## Completion definition

This plan is complete only when:

- all 17 ledger rows are implemented or have their explicitly rejected subhunks
  recorded;
- every phase’s named focused gates pass;
- the integrated web and mobile campaigns pass or each unavailable provider or
  platform is recorded as a concrete residual limit;
- release static gates pass and external release acceptance remains clearly
  approval-gated;
- final diff review proves no excluded upstream architecture, user-owned dirty
  work, colocated tests, or broad compatibility path was introduced;
- the plan is updated with commit SHAs, exact evidence, deviations, and rollback
  status before its status changes from Proposed.

## Document control

- Owner: primary implementation agent; cross-cutting architecture and final
  integration may not be delegated.
- Review source: upstream commits through `4f5834ba7`, current local base
  `40a2b1026`, and broker run `t3code-port-plan-17-v8m4`.
- Approval boundary: this document authorizes no implementation, commit, push,
  deployment, provider mutation, or release.
