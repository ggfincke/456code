<!-- .plans/24-layout-execution-designs.md -->
<!-- phase 3b design packs for plan 23, Group N, D5, and Group K -->

# Plan: Layout Execution Designs (Phase 3b)

## Status

**Campaign execution complete and committed for implementable items.** Phase 3b
designs below remain the ownership record. The Phase 3c bodies landed as
`e8d528caae0069978a3abdc96bb179e2a4b50d81` (§1 and F-D8),
`03a379c013597bc945dbe9b19f78d4b0ab3306f6` (Group N and D5), and
`53e11fcaa9301f0652ca5a931942ee847c4d2304` (Group K), all reachable through
merge commit `40a2b10267bf9df970eadc45d69f14e6b45229aa`. **HOLDs remain:** ws assembly,
Claude session/finalizer (and standing holds outside these designs: contracts
soft-split, Migrations, Layers/Services pairs, UI primitives, routes, scripts
CLIs, decider/projector, GitVcsDriver façade).

Historical 2026-08-06 closeout census (review master tables): **60** ≥1000 /
**41** 800–999 (was **73** / **35**). Integrated `test-t3-app` /
`test-t3-mobile` remain deferred; commit history does not replace those
runtime-acceptance gates.

**Sources of truth**

- Architecture review:
  `dev-docs/architecture-reviews/2026-08-06-source-layout-and-large-file-boundaries.md`
  (Campaign Closeout section)
- Plan 23: `.plans/23-high-risk-large-file-boundaries.md`
- Locked decisions D5 / D7 / D8 in the architecture review

**Current line counts** (filesystem census at `756068c1e`, 2026-08-08):

| Surface | Path | Lines |
| --- | --- | ---: |
| ChatView shell | `apps/web/src/components/ChatView.tsx` | **6008** |
| Dispatch controller | `apps/web/src/components/chat/useChatDispatchController.ts` | **1507** |
| Right-panel controller | `apps/web/src/components/chat/useChatRightPanelController.ts` | **607** |
| WS assembly | `apps/server/src/ws.ts` | **1431** (HOLD) |
| Claude adapter | `apps/server/src/provider/Layers/ClaudeAdapter.ts` | **4149** (HOLD) |
| GitVcsDriverCore | `apps/server/src/vcs/GitVcsDriverCore.ts` | **2871** (N done) |
| ExactGitSnapshot | `apps/server/src/vcs/ExactGitSnapshot.ts` | **1619** (N done) |
| GitManager | `apps/server/src/git/GitManager.ts` | **1985** (N done) |
| Terminal Manager | `apps/server/src/terminal/Manager.ts` | **2463** (N done) |
| ProjectionSnapshotQuery | `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` | **2613** (N done) |
| ProjectionPipeline | `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` | **2645** (N done) |
| ProviderCommandReactor | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` | **2972** (N done) |
| CheckpointReactor | `apps/server/src/orchestration/Layers/CheckpointReactor.ts` | **2609** (N done) |
| ProviderRuntimeIngestion | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` | **1397** (N done) |
| orchestrationHandlers | `apps/server/src/ws/handlers/orchestrationHandlers.ts` | **594** (exited ≥1000) |
| GitVcsDriver façade | `apps/server/src/vcs/GitVcsDriver.ts` | **1348** (HOLD) |
| gitRefParse / GitStatusReader (D5 leaves) | `apps/server/src/vcs/{gitRefParse,GitStatusReader}.ts` | **88** / **33** |
| GitWorkflowService | `apps/server/src/git/GitWorkflowService.ts` | **252** |
| VcsStatusBroadcaster | `apps/server/src/vcs/VcsStatusBroadcaster.ts` | **608** |
| decider / projector | `orchestration/decider.ts` / `projector.ts` | **1952** / **1342** (HOLD) |

Plan 23 planning baselines were ChatView ~7280 / ws ~3280 / Claude ~4590.
Remaining gates bind on ownership, not line count.

### Verdict matrix (campaign closeout)

| Design | Recommendation | Status |
| --- | --- | --- |
| 1. ChatView send/retry | **Done (`e8d528caa`)** | `ChatSendPorts` + `runSend`; integrated web deferred |
| 2a. ws further units | **Hold** | Do not move `WsRpcGroup.of` |
| 2b. ClaudeAdapter further | **Hold** | Session Map + sole `Effect.addFinalizer` stay |
| 3. Group N (listed files) | **Done (`03a379c01`)** | Designed clusters split; hold decider/projector + GitVcsDriver façade |
| 4. D5 git↔vcs | **Done leaf (`03a379c01`)** | `gitRefParse` + `GitStatusReader`; one-way workflow→driver |
| 5. Group K | **Done (`53e11fcaa`)** | Nested behind export façades; 25 `./state/*` keys stable |
| 6. Group F chat (D8) | **Done (`e8d528caa`)** | `composer/` `model-picker/` `messages-timeline/` `orchestrate-plan/` nests |

---

## 1. Plan 23 ChatView — resume send/retry → `useChatDispatchController`

### Recommendation

**Done (Phase 3c, committed as `e8d528caa`, 2026-08-06).** Missing half of plan
23 approval unit 2 closed via explicit `ChatSendPorts` — no context bag. The
integrated web pass remains deferred.

### Current ownership

| Concern | Owner after Phase 3c |
| --- | --- |
| Route / thread / draft promotion identity | `ChatViewContent` in `ChatView.tsx` |
| Composer content | `composerDraftStore` (not React state) |
| Terminal layout | `terminalUiStateStore` + `PersistentThreadTerminals.tsx` |
| Right panel | `rightPanelStore` + `useChatRightPanelController` |
| Draft-error promotion, interrupt, provider-switch, **send/retry** | `useChatDispatchController` (**1507** lines) via `ChatSendPorts` |
| Timeline scroll-follow / anchoring refs | Stored in `ChatView.tsx`; mutated by controller `runSend` |
| Optimistic user rows + blob preview handoff | Setters/refs owned in `ChatView.tsx`; send mutations via ports |
| Local dispatch busy/worktree chrome | `beginLocalDispatch` / `resetLocalDispatch` in `ChatView.tsx` (ported) |

`runSend` is one ordered interaction that:

1. Guards busy/connect/detail/import/pending-progress/`sendInFlightRef`
2. Reads `composerRef.getSendContext()` + draft/prompt refs
3. Handles plan follow-up + standalone slash + empty/expired terminal toasts
4. Optionally docks draft-hero (`flushSync` + mobile transition)
5. Snapshots images/contexts; builds outgoing text (append order inverse of TimelineRows peel)
6. Forces live-edge scroll mode via timeline refs; sets optimistic row + clears draft
7. Sequences metadata → settings → attachments → `startThreadTurn` (with draft/worktree bootstrap)
8. On failure: restores draft/images/contexts/cursor **only when** retry draft is empty and owner key still matches; revokes optimistic preview URLs; sets thread error unless interrupted
9. Clears `sendInFlightRef`; undocks / resets local dispatch if turn did not start

### Proposed seams

Extend the existing vertical slice — do **not** create `useChatView` or a
React context bag.

**Target:** `apps/web/src/components/chat/useChatDispatchController.ts`

Add `runSend` / `dispatchSend` / `onSend` to the controller return value.
`ChatView.tsx` keeps the default export, `DiffWorkerPoolProvider`, route
identity, JSX shell, and owns the *storage* of refs that other ChatView
effects still need (timeline scroll, optimistic rows, draft-hero rect).

### Files / symbols

| Symbol | Action |
| --- | --- |
| `runSend` | Move body into controller |
| `dispatchSend` / `onSend` | Move; ChatView wires composer `onSend={onSend}` |
| `runSendRef` | Move with controller (stable callback pattern stays) |
| `useChatDispatchController` input | Grow a typed `ChatSendPorts` (or equivalent) of **explicit** refs/setters/commands — not a context |
| `ChatView.tsx` | Call site shrinks; still constructs ports from local refs |
| `ChatView.logic.ts` | Hold — pure sink; no ownership steal |
| Default `ChatView` export path | Unchanged |

**Required ports (minimum explicit inputs — expand only with named fields):**

- Identities: `activeThread`, `activeThreadKey`, `composerDraftTarget`,
  `composerDraftOwnerKey`, `environmentId`, `isLocalDraftThread`,
  `isServerThread`, `isDraftHeroState`, `sendEnvMode`, branches/settings used
  by bootstrap
- Guards / busy: `isSendBusy`, `isConnecting`, `threadDetailLoading`,
  `activeEnvironmentUnavailable`, `importContinuationSendBlocked`,
  `activePendingProgress`, `showPlanFollowUpPrompt`, `activeProposedPlan`
- Refs: `sendInFlightRef`, `promptRef`, `composerImagesRef`,
  `composerTerminalContextsRef`, `composerElementContextsRef`,
  `composerDraftOwnerKeyRef`, `composerRef`, timeline refs mutated on send
  (`isAtEndRef`, `timelineScrollModeRef`,
  `liveFollowUserScrollGenerationRef`, `pendingTimelineAnchorRef`,
  `activeTimelineAnchorIndexRef`, `anchorUserScrollGenerationRef`),
  `showScrollDebouncer`
- Setters / commands: `setOptimisticUserMessages`, `setTimelineAnchor`,
  `setShowScrollToBottom`, `setDockedDraftHeroThreadKey`,
  `setThreadError`, `beginLocalDispatch`, `resetLocalDispatch`,
  `startThreadTurn`, `updateThreadMetadata`,
  `persistThreadSettingsForNextTurn`, draft-store mutators,
  `captureDraftHeroComposerRect`, `runMobileComposerTransition`,
  `onSubmitPlanFollowUp`, `onAdvanceActivePendingUserInput`,
  `handleInteractionModeChange`, `focusImportContinuationBanner`
- Pure helpers stay imported from `ChatView.logic` /
  composer-draft modules (no duplication)

### Migration steps

1. Introduce `ChatSendPorts` (or fields on the existing input type) with every
   ref/setter `runSend` touches — compile-time exhaustive at the ChatView call
   site.
2. Move `runSend` + `runSendRef` + `dispatchSend` + `onSend` into
   `useChatDispatchController` without changing control-flow order.
3. Return `onSend` / `dispatchSend` from the controller; ChatView deletes the
   inline definitions.
4. Do **not** move timeline scroll *effects* or optimistic-preview *promotion*
   effects in the same PR — only the mutations `runSend` already performs.
5. Focused tests + one integrated web send/retry/interrupt pass (plan 23 list).
6. Stop if any stop condition below triggers; re-plan rather than widen ports
   into a context.

### Validation gates

- `tests/apps/web/components/ChatView.logic.test.ts`
- Existing composer-draft, session-logic, timeline, right-panel, terminal,
  provider-selection focused suites touched by the PR
- Targeted format / comment-style / lint on `ChatView.tsx` +
  `useChatDispatchController.ts`
- `@t3tools/web` production build for the touched graph
- **One** `test-t3-app` integrated pass: draft send/promotion, streaming
  follow after send, interrupt, retry restoration after failed send, provider
  switch (if env has ≥2 providers; else rely on focused suites as in the
  2026-08-02 checkpoint)

### Stop conditions (unchanged from plan 23)

Stop and re-plan if the extraction:

- Requires a second source of thread identity
- Changes draft promotion timing
- Changes focus / scroll / live-follow behavior
- Adds a broad React context solely to avoid explicit inputs
- Steals send ownership into `ChatComposer` (Group L must not absorb this)

### Risks

| Risk | Mitigation |
| --- | --- |
| Port list becomes a disguised context | Keep a named interface; refuse `deps: any` / catch-all bags |
| Scroll-mode timing drift | Move statements in order; no “cleanup” refactors in the same PR |
| Retry restore races with draft owner key | Preserve exact owner-key / empty-draft predicates |
| Dual `onSend` during migration | Single return path from controller; ChatView only forwards |

---

## 2. Plan 23 — further `ws.ts` / ClaudeAdapter units

### 2a. `ws.ts` assembly

#### Recommendation

**Hold** moving authentication, upgrade handling, service acquisition, or
`WsRpcGroup.of` / `WsRpcGroup.toLayer` out of `apps/server/src/ws.ts`.

**Optional later thinning (not required for Phase 3c gate):** extract
`terminalHandlers` and `workersHandlers` only — both already satisfy plan 23’s
“≥3 methods, shared service owner” rule (live method tags in assembly: ~14
terminal, ~14 workers). Mixed `server*` / `auth*` / `cloud*` /
`cartographer*` / `review*` / `subscribe*` / `sourceControl*` stay inline until
each cluster independently clears that bar without a service bag.

#### Current ownership (evidence)

- Approval unit 3 complete: `ws/rpcAuthorization.ts` (**245**) + five
  aggregates under `ws/handlers/` (workspace **365**, proposal **373**, VCS
  **155**, preview **132**, orchestration **594**).
- `ws.ts` (**1431** at the refreshed baseline; **1208** at Phase 3c closeout,
  was ~3280 at the Plan 23 planning baseline) still owns:
  - `makeWsRpcLayer` service yields
  - handler factory wiring
  - remaining inline RPC methods
  - `websocketRpcRouteLayer` upgrade / auth / `RpcServer.toHttpEffectWebsocket`
- Plan 23 stop conditions still bind: no registry, no universal dependency
  bag, no duplicate authorization owner.

#### Why further body moves are not proven (beyond optional terminal/workers)

| Candidate | Shared owner? | Verdict |
| --- | --- | --- |
| Terminal RPCs | Yes — `TerminalManager` | Optional extract |
| Workers RPCs | Yes — `WorkerBrokerStore` (+ status broadcaster) | Optional extract |
| Server probe/config/diagnostics/process | Mixed services | **Hold** |
| Auth / cloud / cartographer / review | Thin or mixed | **Hold** |
| Moving `WsRpcGroup.of` itself | Assembly façade by design | **Hold** |

Group N owns further splits **inside** `orchestrationHandlers.ts`; that does
not reopen `ws.ts` assembly.

#### Stop conditions

Same as plan 23 WebSocket section: stop if fragment combine weakens
`WsRpcGroup` inference, duplicates authorization, changes stream lifetime, or
needs a generic DI container.

### 2b. ClaudeAdapter session / finalizer

#### Recommendation

**Hold.** No further session-coordinator or finalizer extraction in Phase 3c.

#### Current ownership (evidence)

Already extracted under `apps/server/src/provider/claude/`:

| Module | Lines | Owns |
| --- | ---: | --- |
| `ClaudeTokenUsage.ts` | 327 | Pure token/context normalization |
| `ClaudeToolProjection.ts` | 427 | Pure tool/task/plan projection |
| `ClaudeSdkMessages.ts` | 324 | Pure SDK decode/diagnostics |
| `ClaudePrompt.ts` | 100 | Pure prompt/image construction |
| `ClaudeSessionRuntime.ts` | 128 | Bounded query resource helper only |

`ClaudeAdapter.ts` (**4149** at the refreshed baseline; **3923** at Phase 3c
closeout) still owns:

- `sessions: Map<ThreadId, ClaudeSessionContext>` (constructed in
  `makeClaudeAdapter`)
- Session registration / deletion / resume / turn mutation
- Pending approvals & user-input `Deferred`s
- Canonical event ordering + runtime queue
- Stream launch / exit handling
- **Sole** `Effect.addFinalizer` (live ~line 3886)

Approval unit 5’s current-state review already rejected a broad session
coordinator move. Cursor/Grok’s shared `AcpAdapterSessionLifecycle` is a
different adapter family and does **not** license Claude session Map splits.

#### Stop conditions

Same as plan 23 Claude section: stop if a pure module needs the sessions map
or event queue, if SDK query creation timing changes, or if finalizers become
distributed.

---

## 3. Group N — server design-gated megafile splits

### Recommendation

**Implemented** behind stable Layer/Context/handler façades in `03a379c01`.
**Exclude** Claude session/finalizer and `ws.ts` assembly.
**Hold** `orchestration/decider.ts` and `orchestration/projector.ts`
(intentional tables). **Hold** `GitVcsDriver.ts` façade merge/split (keep as
façade over Core). Coordinate ExactGitSnapshot / GitManager / Core work with
D5 so cycle edges are not churned twice.

Shared invariants for every N cluster:

- Preserve Effect `Context.Service` / `Layer` export paths and names
- No handler registries or universal service bags
- Move existing tests only when source paths move; no suite expansion without
  a focused test plan
- Comment-style headers on every new/moved file
- Stop if ordering, cancellation, cleanup, or projection correctness would
  change

### 3.1 `GitVcsDriverCore.ts` (**3123** design baseline) — Implemented

| | |
| --- | --- |
| **Current ownership** | `makeGitVcsDriverCore` implements driver operations; porcelain/numstat parsers; status upstream refresh caches; list-refs snapshot cache; worktree branch path parsing; commit/push/pull/diff/review patch builders. Imports `git/remoteRefs` (cycle leaf). |
| **Proposed seams** | (1) `GitVcsPorcelainParse.ts` — parse helpers; (2) `GitVcsRefsCache.ts` — list-refs + repository-path caches/coalesce; (3) `GitVcsStatusUpstream.ts` — upstream refresh cooldown/cache; (4) keep command orchestration in Core façade. |
| **Files/symbols** | Keep `makeGitVcsDriverCore` + types used by `GitVcsDriver.ts`. New siblings under `apps/server/src/vcs/`. |
| **Migration** | Extract pure parsers first → caches → leave Effectful git invocations in Core. |
| **Validation** | Focused VCS / git driver tests under `tests/apps/server/**` that already cover status/refs/worktree. |
| **Stop** | If cache TTL/coalesce semantics must change to split; if Core must import workflow. |
| **Risks** | Cache key drift; interaction with D5 remoteRefs move. Prefer D5 leaf extract before or with Core refs work. |

### 3.2 `ExactGitSnapshot.ts` (**2049** design baseline, under `vcs/`) — Implemented

| | |
| --- | --- |
| **Current ownership** | Capture / materialize / verify / preflight exact trees; git subprocess runners; index/tree parsers; fast-import builders. Consumers: cartographer, proposal\*, checkpointing. |
| **Proposed seams** | (1) `ExactGitSnapshotGit.ts` — `runGit` / env / cancellation; (2) `ExactGitSnapshotParse.ts` — tree/index/path decode; (3) `ExactGitSnapshotBuild.ts` — fast-import + index input builders; (4) keep `captureExactGitSnapshot`, `verifyExactGitTreeMaterialization`, `preflightExactGitTreeRestore`, `ExactGitSnapshotError` on façade file. |
| **Migration** | Pure parse/build first; keep capture orchestration + limits assertions on façade. |
| **Validation** | Checkpoint / proposal / cartographer focused tests that call capture/verify. |
| **Stop** | If AbortSignal/timeout behavior would diverge across helpers. |
| **Risks** | Byte-limit and path-validation order is security-adjacent — preserve call order. |

### 3.3 `GitManager.ts` (**2449** design baseline) — Implemented

| | |
| --- | --- |
| **Current ownership** | Effect `GitManager` service: status cache, PR identity/resolution, stacked toast progress, commit message sanitization, actions that call `GitVcsDriver`. |
| **Proposed seams** | (1) `GitManagerPullRequest.ts` — PR URL/identity/match helpers; (2) `GitManagerStatusCache.ts` — status/PR lookup caches; (3) `GitManagerActionPresentation.ts` — toast/progress/commit message sanitize; (4) keep Layer/`GitManager` service methods on façade. |
| **Migration** | Pure identity/presentation first; then cache helpers; leave workflow calls on façade. |
| **Validation** | `tests/apps/server/git/**` (incl. known-flaky PR metadata test — do not “fix” flakes in this PR). |
| **Stop** | If split requires new public Context tags; if D5 cycle break is in-flight on same files. |
| **Risks** | Cycle with `vcs/GitVcsDriver` — sequence after or with D5 leaf step. |

### 3.4 `terminal/Manager.ts` (**2852** design baseline) — Implemented

| | |
| --- | --- |
| **Current ownership** | `TerminalManager` service: session lifecycle, PTY spawn/retry, shell candidate resolution, history/event sequencing, attach stream mapping, process snapshot parse. |
| **Proposed seams** | (1) `terminal/shellResolve.ts` — candidates / platform paths / retryable spawn errors; (2) `terminal/sessionSnapshot.ts` — snapshot/summary/label/event sequence helpers; (3) `terminal/processParse.ts` — process snapshot parsing; (4) keep open/attach/write/resize/kill on `Manager.ts` façade. |
| **Migration** | Pure shell + parse modules first; session map + PTY ownership stay on façade. |
| **Validation** | Terminal manager / attach / RPC-focused server tests. |
| **Stop** | If session map or event sequence ownership would split across layers. |
| **Risks** | Attach snapshot dedupe and sequence counters are easy to break — keep on façade. |

### 3.5 `ProjectionSnapshotQuery.ts` (**2914** design baseline) — Implemented

| | |
| --- | --- |
| **Current ownership** | Effect service: SQL strings, Db row schemas, mappers, snapshot assembly for clients. |
| **Proposed seams** | (1) `ProjectionSnapshotSql.ts` — SQL constants/lists; (2) `ProjectionSnapshotMappers.ts` — row→domain mappers; (3) keep query methods + `REQUIRED_SNAPSHOT_PROJECTORS` orchestration on Layer façade. |
| **Migration** | Schemas/mappers/SQL out first; preserve service export path. |
| **Validation** | Projection snapshot / orchestration query focused tests. |
| **Stop** | If split forces duplicate schema copies that can drift. |
| **Risks** | SQL/projector name coupling — keep projector name list with assembly. |

### 3.6 `ProjectionPipeline.ts` (**2823** design baseline) — Implemented

| | |
| --- | --- |
| **Current ownership** | `OrchestrationProjectionPipelineLive`: event→projection apply, revert retention helpers, derived pending counts / proposed-plan flags, attachment path collection. |
| **Proposed seams** | (1) `ProjectionRevertRetention.ts` — retain-after-revert helpers; (2) `ProjectionDerivedState.ts` — pending user-input / proposed-plan / session-status derives; (3) keep pipeline Layer + per-event apply on façade. |
| **Migration** | Pure retain/derive first; do not per-aggregate-split the whole apply table in v1. |
| **Validation** | Projection pipeline / revert / activity focused tests. |
| **Stop** | If retain helpers need live DB transactions (must stay with pipeline). |
| **Risks** | Revert retention order bugs → silent history loss. |

### 3.7 `ProviderCommandReactor.ts` (**2984** design baseline) — Implemented

| | |
| --- | --- |
| **Current ownership** | `ProviderCommandReactorLive`: intent handling, handoff envelope/prep (already has exported pure helpers), worktree branch naming, error labeling, reactor loop. |
| **Proposed seams** | (1) Expand pure module for `prepareProviderInputWithHandoff` /
  `buildOrchestratePlanResponseEnvelope` / error labels (file already exports
  some); (2) `ProviderCommandWorktree.ts` — generated branch naming + prepare;
  (3) keep reactor subscription/lifecycle on Layer façade. |
| **Migration** | Move pure prep first (low risk); lifecycle last or never. |
| **Validation** | Provider command / handoff / orchestration reactor tests. |
| **Stop** | If prep needs reactor-internal mutable maps. |
| **Risks** | Handoff delivery markers and stale pending-request classification. |

### 3.8 `CheckpointReactor.ts` (**2012** design baseline) — Implemented

| | |
| --- | --- |
| **Current ownership** | Checkpoint domain reactor: capture triggers, revert execute, provider rollback journal encode/decode, baseline message classify. |
| **Proposed seams** | (1) `CheckpointRollbackJournal.ts` — encode/decode journal detail; (2) `CheckpointRevertExecute.ts` — revert stage directory / operation id helpers; (3) keep reactor Layer loop + capability checks on façade. |
| **Migration** | Journal + classify pure code first; revert execute only with dedicated tests. |
| **Validation** | Checkpoint reactor / revert / journal focused tests. |
| **Stop** | If revert execute splits without preserving operation id prefix semantics. |
| **Risks** | Rollback journal detail drift across provider adapters. |

### 3.9 `ProviderRuntimeIngestion.ts` (**1646** design baseline) — Implemented

| | |
| --- | --- |
| **Current ownership** | Runtime event→orchestration ingestion: buffered assistant text, proposed-plan buffers, task title/tool maps, turn message-id caches, lifecycle guards. |
| **Proposed seams** | (1) `ProviderRuntimeIngestionBuffers.ts` — cache capacities/TTL + buffer lookup helpers; (2) `ProviderRuntimeIngestionMap.ts` — pure event→message/plan/task mapping; (3) keep Layer ingestion loop + strict lifecycle guard on façade. |
| **Migration** | Pure mappers/buffers first; do not split the ordered ingest switch casually. |
| **Validation** | Provider runtime ingestion / turn buffer focused tests. |
| **Stop** | If buffer eviction policy would change; if strict lifecycle guard location moves. |
| **Risks** | Assistant segment message ids / proposed plan ids must stay deterministic. |

### 3.10 `orchestrationHandlers.ts` (**1304** design baseline) — Implemented

| | |
| --- | --- |
| **Current ownership** | `makeOrchestrationRpcHandlers`: import RPCs, thread detail streams, subscriptions, shell/thread snapshot wiring. Assembled by `ws.ts` (assembly stays). |
| **Proposed seams** | (1) `orchestrationImportHandlers.ts` — import session RPCs + envelope deadline helpers; (2) `orchestrationThreadStreamHandlers.ts` — thread detail/stream/resume gap; (3) keep `makeOrchestrationRpcHandlers` as composing façade exported to `ws.ts`. |
| **Migration** | Import cluster first (clearest boundary); streams second; preserve observeRpc\* wrappers and scope names. |
| **Validation** | Orchestration RPC / import / stream focused tests; contract audit that method↔scope count stays 1:1. |
| **Stop** | If composition weakens `WsRpcGroup` inference; if authorization wrappers duplicate. |
| **Risks** | Resume gap (`RESUME_MAX_EVENT_GAP`) and import deadline coupling. |

### Explicit Group N holds

| File | Reason |
| --- | --- |
| `orchestration/decider.ts` | Intentional command table |
| `orchestration/projector.ts` | Intentional event table |
| `vcs/GitVcsDriver.ts` | Intentional façade over Core |
| `provider/Layers/ClaudeAdapter.ts` | Plan 23 session/finalizer hold (§2b) |
| `ws.ts` assembly | Plan 23 assembly hold (§2a) |

---

## 4. D5 leaf plan — `remoteRefs` / DTOs → one-way workflow→driver

### Recommendation

**Implemented** in `03a379c01` before the large GitManager/GitVcsDriverCore
moves that touched the same edges. The landed order matches locked D5: leaf
extract first, then one-way `workflow → driver`.

### Pre-implementation cycle (historical edges)

```text
git/GitManager.ts          → vcs/GitVcsDriver
git/GitWorkflowService.ts  → vcs/GitVcsDriver
vcs/VcsStatusBroadcaster.ts → git/GitWorkflowService
vcs/GitVcsDriverCore.ts    → git/remoteRefs
```

`remoteRefs.ts` (**88** lines) is already a pure parse leaf under `git/`, but
lives on the `git` side of the cycle while Core (vcs) imports it.

### Proposed seams

1. **Leaf module** (new): e.g. `apps/server/src/vcs/gitRefParse.ts` **or**
   `apps/server/src/git/refParse.ts` re-exported from a path both sides may
   import without pulling workflow/driver services.
   - Preferred: move pure ref parsers to `apps/server/src/vcs/gitRefParse.ts`
     (vcs owns ref vocabulary for the driver) and leave
     `git/remoteRefs.ts` as a **one-line re-export façade** for existing
     `GitManager` imports — then delete the façade once GitManager is updated.
2. **DTO leaf** (only if needed for the next edge): any shared status/PR
   detail types that both workflow and driver need should move next to the
   driver façade (`GitVcsDriver.ts` types already exist — prefer importing
   those over inventing a third package).
3. **Direction fix:** keep `GitWorkflowService` → `GitVcsDriver` as the only
   service edge. Invert `VcsStatusBroadcaster` → `GitWorkflowService` by
   having the broadcaster depend on driver/status APIs (or a narrow
   `GitStatusReader` surface owned by vcs) instead of the git workflow
   service.

### Files / symbols

| Symbol / file | Action |
| --- | --- |
| `parseRemoteNames*`, `parseRemoteRefWithRemoteNames`, `extractBranchNameFromRemoteRef` | Move to leaf; re-export during migration |
| `GitVcsDriverCore` import of `../git/remoteRefs` | Point at leaf |
| `GitManager` import of `./remoteRefs` | Point at leaf or temporary façade |
| `VcsStatusBroadcaster` → `GitWorkflowService` | Replace with driver/status port (second step) |
| `GitManager` → `GitVcsDriver` | Keep (workflow/actions above driver) |

### Migration steps

1. Move pure ref parsers to leaf; dual-path re-export; focused parse tests if
   present (else exercise via existing driver/manager tests).
2. Retarget Core + GitManager imports; delete temporary façade.
3. Redesign `VcsStatusBroadcaster` dependency to vcs-owned status/read API
   (no import of `GitWorkflowService`).
4. Confirm `git/*` may import `vcs/GitVcsDriver` but `vcs/*` must not import
   `git/GitWorkflowService` or `git/GitManager`.
5. Optional madge/dependency-cruiser spot check on `apps/server/src/{git,vcs}`.

### Validation gates

- Focused git + vcs + status broadcaster tests
- Static import check: no `vcs` → `git/GitWorkflowService` / `GitManager`
- No behavior change to fetch interval / status stream events

### Stop conditions

- If plans 19/20 end-state would place workflow *under* driver (contradicts
  D5 lock) — escalate; do not invent a third topology in the leaf PR
- If broadcaster inversion requires public WS contract changes
- If “DTO extract” starts pulling Effect services into the leaf

### Risks

| Risk | Mitigation |
| --- | --- |
| Double-move with Group N Core/GitManager | Do D5 leaf **first** |
| Hidden cycle via `Utils` or relative re-exports | Grep both dirs after each step |
| Over-extracting types into contracts | Keep leaf server-internal |

---

## 5. Group K — client-runtime `state/<owner>/` + export matrix

### Recommendation

**Done (Phase 3c, committed as `53e11fcaa`).** Nested **internally** only; every
`@t3tools/client-runtime/state/*` subpath preserved via re-export façades at
the current `package.json` targets (old paths are thin re-exports). Live
package has **25** `./state/*` export keys (design draft said 26).

### Current ownership (post-nest)

- `packages/client-runtime/src/state/` — **48** modules under 8 owners + flat
  `runtime.ts` + root façades for every moved module
- **25** public export subpaths in `packages/client-runtime/package.json`
  (unchanged keys)
- Internals remain non-public (no new deep export keys)

### Proposed `state/<owner>/` tree

```text
packages/client-runtime/src/state/
  runtime/
    runtime.ts                 # Atom command/query helpers (export target)
  threads/
    threads.ts                 # export target
    threadReducer.ts
    threadDetail.ts
    threadCommands.ts
    threadShell.ts
    threadSnapshotHttp.ts
    threadState.ts
    threadRetention.ts
    threadSettled.ts           # export target (or re-export from threads/)
    threadSort.ts              # export target
    archivedThreads.ts
  shell/
    shell.ts                   # export target
    shellReducer.ts
    shellCommands.ts
    shellSnapshotHttp.ts
  vcs/
    vcs.ts                     # export target
    vcsAction.ts
    vcsCommandScheduler.ts
    vcsRef.ts
    vcsRefInvalidation.ts
    vcsStatus.ts
    git.ts                     # export target (git atoms; scheduler shared)
    gitActions.ts
  projects/
    projects.ts                # export target
    projectCommands.ts
    projectEntities.ts
    projectGrouping.ts         # export target state/project-grouping
  terminal/
    terminal.ts                # export target
    terminalSession.ts
  session/                     # thin domain cluster
    session.ts
    orchestration.ts
    models.ts
    presentation.ts
  connection-state/            # avoid clashing with package /connection
    connections.ts
    server.ts
    auth.ts
    environmentHttpAuth.ts
    relayDiscovery.ts          # export target state/relay
  workspace/
    entities.ts
    filesystem.ts
    assets.ts
    snapshots.ts
    preview.ts
    review.ts
    sourceControl.ts
    workers.ts
    composerPathSearch.ts
    checkpointDiff.ts
```

Notes:

- Owner folders require ≥3 modules (plan 21). `session/` above is borderline —
  if under three after inventory, keep those files flat at `state/` root.
- `runtime.ts` may stay at `state/runtime.ts` (single high-fan-in hub) instead
  of a one-file folder — preferred **hold flat** unless more runtime siblings
  appear.
- No new public deep exports (`state/threads/threadReducer` must not become
  public).

### Export compatibility matrix

Every public subpath must keep resolving. After nest, `package.json` `default`
/`types` either still point at a façade file at the old path or at the nested
file **without changing the export key**.

| Export subpath | Current target file | Nested home (proposed) | Compatibility mechanism |
| --- | --- | --- | --- |
| `@t3tools/client-runtime/state/auth` | `state/auth.ts` | `state/connection-state/auth.ts` | façade re-export at old path **or** retarget package.json only |
| `…/state/assets` | `state/assets.ts` | `state/workspace/assets.ts` | same |
| `…/state/connections` | `state/connections.ts` | `state/connection-state/connections.ts` | same |
| `…/state/entities` | `state/entities.ts` | `state/workspace/entities.ts` | same |
| `…/state/filesystem` | `state/filesystem.ts` | `state/workspace/filesystem.ts` | same |
| `…/state/git` | `state/git.ts` | `state/vcs/git.ts` | same |
| `…/state/models` | `state/models.ts` | `state/session/models.ts` or flat | same |
| `…/state/orchestration` | `state/orchestration.ts` | `state/session/orchestration.ts` or flat | same |
| `…/state/presentation` | `state/presentation.ts` | `state/session/presentation.ts` or flat | same |
| `…/state/preview` | `state/preview.ts` | `state/workspace/preview.ts` | same |
| `…/state/projects` | `state/projects.ts` | `state/projects/projects.ts` | same |
| `…/state/project-grouping` | `state/projectGrouping.ts` | `state/projects/projectGrouping.ts` | **keep export key** `project-grouping` |
| `…/state/relay` | `state/relayDiscovery.ts` | `state/connection-state/relayDiscovery.ts` | **keep export key** `relay` |
| `…/state/review` | `state/review.ts` | `state/workspace/review.ts` | same |
| `…/state/runtime` | `state/runtime.ts` | prefer stay flat / `runtime/runtime.ts` | same |
| `…/state/server` | `state/server.ts` | `state/connection-state/server.ts` | same |
| `…/state/session` | `state/session.ts` | `state/session/session.ts` | same |
| `…/state/shell` | `state/shell.ts` | `state/shell/shell.ts` | same |
| `…/state/source-control` | `state/sourceControl.ts` | `state/workspace/sourceControl.ts` | **keep export key** `source-control` |
| `…/state/terminal` | `state/terminal.ts` | `state/terminal/terminal.ts` | same |
| `…/state/threads` | `state/threads.ts` | `state/threads/threads.ts` | same |
| `…/state/thread-sort` | `state/threadSort.ts` | `state/threads/threadSort.ts` | **keep export key** |
| `…/state/thread-settled` | `state/threadSettled.ts` | `state/threads/threadSettled.ts` | **keep export key** |
| `…/state/vcs` | `state/vcs.ts` | `state/vcs/vcs.ts` | same |
| `…/state/workers` | `state/workers.ts` | `state/workspace/workers.ts` | same |

**Internal-only modules** (no package export today — must remain non-public
after nest):

`archivedThreads`, `checkpointDiff`, `composerPathSearch`,
`environmentHttpAuth`, `gitActions`, `projectCommands`, `projectEntities`,
`shellCommands`, `shellReducer`, `shellSnapshotHttp`, `snapshots`,
`terminalSession`, `threadCommands`, `threadDetail`, `threadReducer`,
`threadRetention`, `threadShell`, `threadSnapshotHttp`, `threadState`,
`vcsAction`, `vcsCommandScheduler`, `vcsRef`, `vcsRefInvalidation`,
`vcsStatus`.

### Migration steps

1. Land app-local dumps (Groups J/P and remaining web root) first — D7.
2. Create owner folders; git-move internals; update relative imports inside
   `packages/client-runtime`.
3. Prefer **old-path façades** (`state/threads.ts` re-exports
   `./threads/threads.ts`) so `package.json` keys need zero churn.
4. Smoke-resolve every export key from web + mobile + `tests/package.json`
   mocks.
5. No new deep public subpaths.

### Validation gates

- client-runtime package tests
- Focused web + mobile state/connection suites
- `node`/`vp` resolve smoke for all 26 export keys
- Confirm `tests/package.json` `vi.mock` ids still resolve

### Stop conditions

- Any export key rename
- Need to change web/mobile import strings beyond accidental deep imports
- Nesting that forces barrels across unrelated owners

### Risks

| Risk | Mitigation |
| --- | --- |
| Dual-client churn | Façades at old file paths |
| Accidental public deep imports | Do not add package export keys |
| `runtime.ts` fan-in | Leave flat unless siblings exist |

---

## Phase 3c execution order and remaining holds

1. ChatView send/retry and Group F chat regrouping landed in `e8d528caa`; the
   integrated web pass remains deferred.
2. D5 leaf extraction, broadcaster inversion, and Group N clusters landed in
   `03a379c01` in the required dependency order.
3. Group K landed behind stable export façades in `53e11fcaa`.
4. Optional ws terminal/workers handler aggregates remain on hold unless a new
   current-state design shows that they are still valuable.

---

## Blockers / prerequisites

| Blocker | Blocks | Resolution |
| --- | --- | --- |
| Design approval + Phase 3b go-ahead | All 3c body work | Resolved; committed implementation is recorded above |
| Plan 23 stop conditions | ChatView / ws / Claude | Still binding; §1 shows explicit-port path |
| D5 vs Group N Git\* overlap | GitManager / Core PRs | Resolved in `03a379c01`; D5 landed first within the change |
| D7 “later” | Group K | Resolved before `53e11fcaa` landed |
| Integrated web env for send/retry | §1 verification | Still deferred; run `test-t3-app` before claiming runtime acceptance |

---

## Document control

- Written: 2026-08-06 (Phase 3b)
- Refreshed: 2026-08-08 after the Phase 3c commits and merge were verified in
  the current history
- Plan 23 remains the historical checkpoint log; this file is the execution
  design and committed execution record. Its explicit HOLDs and deferred
  integrated client passes remain open.
