# Mega Review Core (456code — combined audit)

**Last Updated:** 2026-07-31
**Audit File:** `dev-docs/mega-review-core-2026-07-31.md`
**Lifecycle Status:** Proposed (review complete; remediation awaiting approval)
**Combined Scope:** Two complementary reviews: the whole codebase at `main@8d7d65dfa`, followed by the uncommitted working-tree diff against that baseline. Security remained out of scope in both reviews.

## How to Read This Combined Report

- **Part I** is authoritative for the committed whole-codebase baseline. It preserves the exhaustive finder and verifier record from that snapshot.
- **Part II** is authoritative for the later uncommitted changes that Part I explicitly excluded. It preserves the diff-specific finding index, worker digest, verification, and implementation sequence.
- Finding IDs and action-group letters are local to their part. Do not combine counts or treat identically lettered groups as the same work item without re-tracing current code.
- Where a Part II finding touches an area already discussed in Part I, use Part II for the changed implementation and Part I for unaffected surrounding architecture.

## Part I — Whole-codebase baseline audit

**Last Updated:** 2026-07-31
**Audit File:** `dev-docs/mega-review-core-2026-07-31.md`
**Lifecycle Status:** Proposed
**Scope:** Whole codebase at `main@8d7d65dfa` ("feat: orchestrate as a core workflow (#22)") — the orchestrate branch merged mid-run, so the review base includes it. ~590k TS lines: server 135k, web 108k, mobile 57k, desktop 20k, packages ~122k, tests 187k (excluded from bug-hunt, used as reference by the test-gaps lens). Generated protocol bindings received a drift pass, not line-by-line review. The user's uncommitted working-tree changes (composer-trigger work, ~22 files) were NOT reviewed — worktrees were cut from the committed base only.
**Codebase Size:** ~2,000 TS/TSX files. Prior whole-repo audit: `dev-docs/mega-review-core-2026-07-27.md` (overlaps tagged [known-0727], re-verified live rather than suppressed).
**Lenses run:** bug-hunt, simplification, consolidation, test-gaps, performance
**Security:** Out of scope by design; use a separate security-remediation pass when needed.
**Mode:** Read-only review — nothing committed, no files modified outside this document.
**Effort:** Exhaustive — orchestrate run `megacore-orchbranch-t6k9` via worker-broker: 32 codex fanout workers (effort high; 18 region-owned bug-hunt + 14 lens workers) + 8 claude-opus-5 (high) refute-first verifiers. 40/40 completed, 0 failed/rejected/cancelled, 0 scope violations. Full finder/verifier artifacts persist in `~/.local/state/worker-broker/jobs/<job-id>/`.

### Executive Summary

- **~152 candidate findings** from 32 finders; after adversarial verification: **~135 CONFIRMED** (many with severity recalibrated against traced blast radius), **5 REFUTED**, **1 unverifiable**, **4 resurrected** from finder-rejected lists, **1 new escalation** found during verification. ~75 additional candidates were self-refuted by finders and recorded below so they don't resurface; verifiers spot-checked ~40 of those rejections and overturned 4.
- **Top issues to address first:** (1) the orchestrate plan card ships two approval-blocking identity bugs (mount-order supersession inversion `orchestratePlanStore.ts:103`, revision state keyed by bare runId `OrchestratePlanCard.tsx:719`) — the documented re-emit-after-gate-edit flow dead-ends the newest plan; (2) pending-input exit leaves `promptRef` pointing at the answer, so the next Send transmits the wrong text (`ChatComposer.tsx:1474`, raised to high by verification); (3) orchestration reactors consume hot streams with no replay — a routine server restart permanently drops committed user turns (`OrchestrationEngine.ts:53`); (4) cross-fork PR preparation can hijack any same-named local worktree (`GitManager.ts:1810`); (5) mobile silently submits wrong multi-select answers (`use-selected-thread-requests.ts:29`) and can discard project-script terminal input (`ThreadTerminalRouteScreen.tsx:607`).
- **Biggest risks:** durability/atomicity gaps in the server core (reactor replay, checkpoint revert saga, settings/secrets ordering) need design passes, not point fixes; the workers read model multiplies full directory scans per subscriber (4–8 scans/3s with the panel open; ~205 job records already on this host) and should be consolidated behind one broadcaster with the new test suites as the regression net.
- **Clean areas checked (verified, not assumed):** ws.ts RPC/scope table 1:1; tests/ tree conventions fully reconciled; syntax-theme hook adoption complete; VCS status broadcaster ownership (ref-counted, cached, deduped); thread-cache persistence off the streaming path; sidebar V1/V2 intentionally distinct; file-preview classifier and HTTP readiness already consolidated.
- **Recommended next move:** approve Action Group A (orchestrate-surface correctness — the just-merged feature's own bugs plus its missing tests), then B (workers read-model transport, tests first).

### Approach

- Orchestrate run `megacore-orchbranch-t6k9` (workflow `review`, approved plan: fanout=codex:high ×32, verify=claude-opus-5:high ×8 — verify stage user-edited from cursor via gate grammar).
- 18 bug-hunt workers with region-exclusive ownership (server ×6, web ×5, mobile ×3, desktop ×1, packages ×3), each reading every file in its region; 14 lens workers (simplification ×4, consolidation ×4, test-gaps ×3, performance ×3) overlaying the same areas. All pre-read `AGENTS.md`, the 07-27 audit, and `.plans/orchestrate-core-workflow-review.md`.
- 8 refute-first verifiers (batched by subsystem) re-traced every finding against live code at HEAD, refusing the finders' quotes, recalibrating severity, spot-checking rejected claims, and resurrecting wrongly-dismissed ones.
- Cross-lens dedupe by root cause performed at synthesis (lead session). Read-only throughout; no security analysis.

### Refuted / Downgraded-to-policy (do not re-report)

1. **Malformed worker timestamps invalidate the workers response** — refuted: `IsoDateTime` (`contracts/baseSchemas.ts:20`) is an unvalidated `Schema.String` alias; nothing fails to encode. (Residual nit: timestamps are never validated at all.)
2. **`normalizeGitRemoteUrl` conflates endpoints** — refuted: port/case collapsing is the documented, tested purpose (`tests/packages/shared/git.test.ts:34-41`); consumers want that equivalence. Design note only.
3. **Impossible worker budgets remain approvable** — refuted: capping `max-workers` below the plan is a supported user action; the orchestrator must re-gate before exceeding it (`model-plan.md:113`). A non-blocking warning is optional UX.
4. **ServerUpdateAction pending state leaks across environments** — refuted: the banner item is keyed by `environmentId:clientVersion:serverVersion`, so the action remounts on identity change.
5. **Mobile drops free-form `options: []` questions** — refuted as a mobile bug: web has the byte-identical drop policy and no server producer emits empty options; cross-platform feature request.
6. **Early PTY output/exit loss** (`terminal/Manager.ts:1893`) — unverifiable statically; needs a synchronous fake-PTY harness.
7. **Updater progress overtaking completion** — plausible-but-unproven (needs Effect op-budget preemption); left unpromoted.

### Resurrected by verification

1. **CLI clears server runtime state without ownership verification** — `cli/project.ts:370` + `serverRuntimeState.ts:78` (low/high): unconditional delete after a failed probe races a restarting server → duplicate server against the same SQLite state.
2. **Settled-turn mapping consolidation** — wrongly rejected by the simplification finder as out-of-scope; three byte-identical owners; destination `packages/shared/src/orchestrationTiming.ts`.
3. **Out-of-range numeric HTML entities throw RangeError in mobile Markdown render** — `nativeMarkdownText.ts:79` (low/med): render-phase `String.fromCodePoint` with no bounds check, reachable from any assistant text node; one-line guard.
4. **Stale `projects.list/add/remove` RPC constants** — `contracts/src/rpc.ts:195-197`: zero-consumer surface the dead-export sweep missed; add to the deletion set.

New escalation found during verification: **native+canonical NDJSON loggers open two independent `RotatingFileSink`s against the same file** (`EventNdjsonLogger.ts:214`, `ProviderEventLoggers.ts:74-78`) — racing rotations can truncate/clobber backups. Correctness item, separate from the logging performance work.

### Integrated Action Groups

| Group | Theme                                       | Key findings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Lenses                                          | Risk     | Order      | Status   |
| ----- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | -------- | ---------- | -------- |
| A     | Orchestrate surface correctness + its tests | plan-card supersession & revision identity; workers deep-link thread scoping; unknown-status lifecycle unification (4 disagreeing sites); error-suppression & exit-code styling in panel; duplicate-stage-id rejection; card grammar/store/panel-logic/fallback tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | bug-hunt, consolidation, test-gaps              | Low–Med  | 1          | Proposed |
| B     | Workers read-model transport                | one server-owned watcher+index+PubSub (copy VCS _ownership_, not code); single-scan snapshots; `stateDir` accessor for readiness; polling-fallback retry; one client snapshot atom family; `WorkerBrokerStore`/`WorkersStatusBroadcaster`/`WorkersReadiness` suites FIRST as regression net                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | consolidation, performance, bug-hunt, test-gaps | Med      | 2          | Proposed |
| C     | Composer & send path                        | promptRef restore on pending-input exit (HIGH); auto-advance timer binding; plan-follow-up draft restore; `onSend` identity stabilization (kills per-delta re-parse of every mounted assistant row); thread-deletion phase tracking (navigate-failure path); orchestrate-approval × plan-follow-up interception check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | bug-hunt, performance                           | Low–Med  | 1 (with A) | Proposed |
| D     | Server durability & atomicity               | reactor outbox/durable cursor (design pass; subsumes cleanup-replay); settings secret ordering + its red test; checkpoint-restore staging + revert saga; approval-response pending restore; archive-vs-stop policy decision (leak bounded ≤30min by reaper); shared settled-turn mapping; canonical activity comparator; text-gen fallback vs disabled providers; snapshot-first stream ordering (`ws.ts:2928` — adopt the `ws.ts:1920` pattern)                                                                                                                                                                                                                                                                                                                                                                                     | bug-hunt, consolidation                         | Med–High | 3          | Proposed |
| E     | Provider adapters & protocol packages       | send-path prep hoist + keyed lock (Cursor+Claude, Grok as reference); OpenCode dual terminal events; registry build→swap→close; session-generation token (fixes `ProviderService.ts:793` + `ProviderRuntimeIngestion.ts:1338` together); protocol reader forking ([known-0727], codex + ACP-ext); post-termination request rejection; ACP stderr drain; RotatingFileSink file separation + async batched logging                                                                                                                                                                                                                                                                                                                                                                                                                     | bug-hunt, performance                           | Med–High | 3          | Proposed |
| F     | Mobile correctness                          | multi-select answers via client-runtime consolidation (HIGH, misfiled as consolidation); terminal script-input running-gate; `use-composer-drafts` single persistence owner + attachment payload externalization + P1 test (one work item, three lenses); branch-creation abort; Live Activity toggle unit; paste MIME/slots; entity RangeError guard; iOS-only native contract convention decision                                                                                                                                                                                                                                                                                                                                                                                                                                  | bug-hunt, consolidation, performance, test-gaps | Med      | 2–3        | Proposed |
| G     | Desktop lifecycle & preview                 | readiness-timeout restart path; update-teardown recovery; relaunch-before-shutdown; recording latch ([known-0727], unrecoverable without reload); duplicate-main-window serialization; picker session IDs; config-failure restart routing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | bug-hunt                                        | Med      | 3          | Proposed |
| H     | Auth, git, ssh, infra hygiene               | GitManager cross-fork worktree guard (HIGH — held); DPoP replay expiry (unbounded growth); pairing consume-after-validate (product decision); cookie-precedence hardening (decision); CLI runtime-state conditional clear; ssh tunnel creator cancellation + alias runtime ownership ([known-0727]) + askpass leak; primary-remote name threading; import budget scope decision (+ test naming conflict) + discovery `resumable` flag (breaks fixture at `discovery.test.ts:277` — intent decision needed); pending-input repair migration                                                                                                                                                                                                                                                                                           | bug-hunt                                        | Med      | 3–4        | Proposed |
| I     | Consolidation batch (behavior-preserving)   | work-log extraction → `@t3tools/shared/toolActivity` (3 owners); import parser policy (3 parsers, untrusted input — raised to med); identity stamping ×5; SQL/decode classifier ×8 (not 7); desktop atomic-write helper (desktop-local, NOT server reuse); home expansion ×5 (keep `Path.Path` seam); text-gen assembly ×5 (designed change — span names are telemetry); review-comment wire codec ×2; threadListV2 ordering drift; web/mobile adapter extraction (drop the "demote single-client families" half); contracts policy relocation (AGENTS.md:21 violation — start with `PROVIDER_DISPLAY_NAMES` + HTTP renderers); `errorMessageOr` sweep (standalone commit); dead-code deletions (confirm UI-primitives shelf + relay `typ` constants externally before deleting; add `projects.*` constants; mobile `vite-plus` dep) | simplification, consolidation                   | Low      | 5          | Proposed |
| J     | Performance measurement queue               | 9 needs-measurement items, each with an exact recipe: per-event SQLite reads; unbounded queue depth telemetry; unpaginated thread snapshots; MCP payload pruning; worker history virtualization (measure at 100/500/2000 jobs); Explorer polling consolidation; mobile feed/Markdown coalescing; composer bridge deltas; Shiki lazy-mount. **No code before baselines.**                                                                                                                                                                                                                                                                                                                                                                                                                                                             | performance                                     | N/A      | ongoing    | Proposed |

### Recommended Implementation Sequence

1. **Phase 1 (low risk, branch-critical):** Groups A + C. The just-merged orchestrate feature's own defects and the send-path bugs, with the four new web/client-runtime test suites (client-runtime fallback test before any workers refactor; orchestratePlanStore test only AFTER the supersession redesign, else it cements the bug). Gate: focused `vp test run` on the new suites + affected existing suites.
2. **Phase 2:** Groups B + F. Workers transport consolidation behind its new server test net; mobile correctness cluster. Gate: new `tests/apps/server/workers/` suites green; mobile focused suites green.
3. **Phase 3:** Groups D (point fixes) + E + G + H highs (GitManager guard, DPoP expiry, tunnel cancellation). Gate: focused server/provider suites; fault-injection tests specified per finding.
4. **Phase 4:** D's design-pass items (reactor outbox, revert saga) + product decisions (archive policy, pairing consumption, import budget scope, cookie precedence, iOS-only contracts).
5. **Phase 5:** Group I consolidation batch as separate low-risk commits; J measurements run whenever bandwidth allows, before any of their optimizations.

### Verification Performed

- 32/32 fanout + 8/8 verify workers completed with zero scope violations; every finding above carries a refute-first verification with live `file:line` evidence traced independently of the finder (verifier reports: jobs `…24f998de`, `…f2909f5a`, `…24af50a2`, `…0498d392`, `…f391368a`, `…68ab3987`, `…816f707a`, `…46040355`).
- Lead session independently deep-read the orchestrate-surface diff (server workers read model, contracts, client-runtime workers state, plan store, panel logic, composer/ChatView wiring) before fan-out.
- Verifiers corrected finder artifacts in four places (preview-handlers path, SQL-classifier count 8 not 7, one stale line anchor, one wrong-mechanism trigger) — **re-resolve all anchors by symbol before patching**, especially since the working tree already carries new uncommitted edits to several cited files.

### Not Run / Limitations

- Entirely static: no tests, typechecks, dev servers, profilers, devices, or simulators were run (read-only constraint). All perf magnitudes are code-derived or inherited from the 07-27 probes.
- The user's uncommitted working-tree changes (~22 files, composer-trigger work) were not reviewed and may already overlap Group C files.
- Not settled statically: PTY startup race; updater interleaving; `@pierre/diffs` cacheKey semantics (determines the diff-draft-lock blast radius); Electron DevTools focus behavior; Azure DevOps cross-repo response shape; `expo-file-system` `content://` semantics; relay `typ` constants' external consumer.
- Incidental out-of-scope note (not analyzed, per the security boundary): auth-adjacent findings here are correctness-only; a separate security-remediation pass would be needed for any security assessment.

_Remaining sections populated at synthesis._

### Worker Reports Digest (candidates, pre-verification)

Run `megacore-orchbranch-t6k9`, base `8d7d65dfac` (temp base commit of branch tip `1c9a466b7` + audit skeleton). 32 fanout workers (codex, effort high) all completed with zero failures and zero scope violations. Verification wave: 8 claude-opus-5 (high) workers, refute-first. Full finder reports live in the broker job records (`~/.local/state/worker-broker/jobs/<job-id>/`).

#### S1 bug-hunt: apps/server/src/provider (job …5433bf1f) — 6 findings, 5 rejected

1. [known-0727] Pending user decisions block protocol response routing — `CodexSessionRuntime.ts:986` — high/high
2. Provider lifecycle side effects not compensated when binding persistence fails — `ProviderService.ts:768` — high/high
3. Cursor/Claude can open two logical turns for concurrent sends — `CursorAdapter.ts:926` — high/high
4. Fallible attachment prep after `turn.started` published — `ClaudeAdapter.ts:3890` — med/high
5. OpenCode interruption emits conflicting terminal events — `OpenCodeAdapter.ts:1604` — med/high
6. Registry reconciliation exposes instance after scope closed — `ProviderInstanceRegistryLive.ts:241` — med/high

#### S2 bug-hunt: apps/server/src root files (job …c38c7e3e) — 5 findings, 5 rejected

1. [known-0727] Rejected settings updates can still mutate/delete provider secrets — `serverSettings.ts:337` — high/high
2. Snapshot-first RPC streams can permanently miss intervening changes (config/lifecycle/auth-access) — `ws.ts:2928` — med/high
3. Text-generation fallback can select an explicitly disabled provider — `serverSettings.ts:163` — med/high
4. Post-readiness command can overtake commands queued before readiness — `serverRuntimeStartup.ts:101` — med/high
5. Omitting stdin leaves child pipe open until timeout — `processRunner.ts:329` — med/high

#### S3 bug-hunt: apps/server/src/orchestration (job …400d3295) — 9 findings, 5 rejected

1. Persisted intents lost across reactor downtime (hot stream, no replay) — `OrchestrationEngine.ts:53` — high/high
2. Archiving hides a thread before its session can be stopped — `ProjectionSnapshotQuery.ts:955` — high/high
3. Checkpoint revert can leave fs/provider/projection at different turns — `CheckpointReactor.ts:842` — high/high
4. Transient approval-response failure permanently hides pending approval — `ProjectionPipeline.ts:1582` — high/high
5. Delayed exit from old provider instance stops replacement session — `ProviderRuntimeIngestion.ts:1333` — high/med
6. Attachment files orphaned before command acceptance — `Normalizer.ts:116` — med/high
7. Failed attachment cleanup never retried (cursor advances first) — `ProjectionPipeline.ts:1655` — med/high
8. `missing` checkpoints produce divergent latest-turn states — `ProjectionPipeline.ts:1408` — med/high
9. Equal timestamps can resurrect resolved user-input requests — `ProjectionPipeline.ts:140` — med/high

#### S4 bug-hunt: apps/server/src/import (job …212db6fc) — 2 findings, 5 rejected

1. File imports reset request-wide resource budgets for every item — `importService.ts:687` — high/high
2. Discovery labels sessions with no usable workspace as resumable — `discovery.ts:668` — med/high

#### S5 bug-hunt: persistence+git+auth (job …701d6a22) — 5 findings, 5 rejected

1. Cross-fork PR preparation can reuse an unrelated worktree — `GitManager.ts:1798` — high/high
2. Stale pending-input counts never repaired for newer provider error variants — `Migrations/024_…:227` — med/high
3. Session cookies shadow explicit Authorization credentials — `EnvironmentAuth.ts:501` — med/high
4. Failed exchanges permanently burn one-time pairing credentials — `EnvironmentAuth.ts:600` — med/high
5. DPoP replay records grow without bound — `auth/dpop.ts:69` — med/high

#### S6 bug-hunt: remaining server subdirs (job …c247484f) — 8 findings, 7 rejected

1. Failed checkpoint restoration can destroy the current worktree — `vcs/ExactGitSnapshot.ts:1359` — high/high
2. Malformed worker timestamps can invalidate the entire workers response — `workers/WorkerBrokerStore.ts:104` — med/high
3. Claude/Cursor/Grok text-generation never receive attached image content — `textGeneration/ClaudeTextGeneration.ts:315` — med/high
4. Early PTY output and exit events can be permanently lost — `terminal/Manager.ts:1892` — med/med
5. Workers snapshot can combine two filesystem revisions (list vs listRuns double-scan) — `workers/WorkersStatusBroadcaster.ts:48` — low/high
6. Failed service-install rollback changes prior lifecycle state — `service/bootService.ts:324` — med/high
7. Non-positive telemetry batch size silently disables delivery — `telemetry/AnalyticsService.ts:31` — low/high
8. Repos without an `origin` remote misclassified — `vcs/GitVcsDriverCore.ts:1463` — med/high

#### W1 bug-hunt: components/chat + diffs + sidebar (job …c7b917b8) — 12 findings, 6 rejected

1. [known-0727] Composer import can crash before storage fallback — `ChatComposer.tsx:52` / `composerDraftStore.ts:71` — high/high
2. Virtualized mount order inverts plan supersession — `orchestratePlanStore.ts:103` — high/high
3. Revised plans inherit stale lifecycle and picker state (draftKey = runId) — `OrchestratePlanCard.tsx:719` — high/high
4. Pending-input exit leaves prompt ref pointing at the answer — `ChatComposer.tsx:1474` — high/high
5. Single-select timer can skip the following question — `ComposerPendingUserInputPanel.tsx:94` — high/high
6. [known-orch-review] Duplicate stage IDs still produce ambiguous approvals — `OrchestratePlanCard.tsx:168` — med/high
7. Impossible worker budgets remain approvable (total > maxWorkers) — `OrchestratePlanCard.tsx:178` — med/high
8. [known-0727] Non-durable stash still duplicates the prompt — `ChatComposer.tsx:2252` — med/high
9. Failed proposal generation permanently marked attempted — `ProposedPlanCard.tsx:114` — med/high
10. Attachment persistence reorders files by read completion — `ChatComposer.tsx:1589` — med/high
11. Filename-prefix/index matching loses or misassigns annotation images — `MessagesTimeline.tsx:897` — med/high
12. Live diff changes can hide a draft comment and lock selection — `AnnotatableCodeView.tsx:121` — med/high

#### W2 bug-hunt: components root A–L incl. ChatView (job …167e721a) — 4 findings, 5 rejected

1. Started implementation work deleted after client-side observation/navigation failure — `ChatView.tsx:5591` — high/high
2. Failed plan follow-ups permanently discard the user's draft — `ChatView.tsx:4715` — med/high
3. Stale repository lookup can resurrect a clone flow after Back — `CommandPalette.tsx:1509` — med/high
4. Publish completion can display under a different repository scope — `GitActionsControl.tsx:482` — low/med
   Notable rejections: double-approve of orchestrate plans (guarded by `sendInFlightRef`), orchestrate prompt-rewrite duplication.

#### W3 bug-hunt: components root M–Z (job …0e41356f) — 8 findings, 5 rejected

1. Concurrent project-script imports can overwrite each other — `ProjectScriptsControl.tsx:278` — med/high
2. Interrupted provider updates reported as failures — `ProviderUpdateLaunchNotification.logic.ts:368` — med/high
3. Server-update pending state leaks across environment changes — `ServerUpdateAction.tsx:49` — med/high
4. Folded sidebar previews hide the active thread — `Sidebar.tsx:1273` — med/high
5. Cancelled project drag consumes the next click — `Sidebar.tsx:3227` — low/high
6. Settle controls offer actions guaranteed to fail — `SidebarV2.tsx:1045` — med/high
7. Hidden rows can pin reopened PRs in the settled shelf — `SidebarV2.tsx:1290` — med/high
8. Terminal selection-menu rejection becomes unhandled — `ThreadTerminalDrawer.tsx:500` — low/med

#### W4 bug-hunt: settings/ui/preview/files/explorer (job …9490c046) — 5 findings, 5 rejected

1. [known-0727] Preview close bypasses active-recording cleanup — `preview/closePreviewSession.ts:25` — high/high
2. [known-0727] Disposing a clean editor replays an already-confirmed revision — `files/fileSaveCoordinator.ts:61` — high/high
3. Rapid provider edits overwrite the first change (snapshot-based patches) — `settings/ProviderInstanceCard.tsx:455` — med/high
4. Env-var drafts don't follow external/reset updates — `settings/ProviderInstanceCard.tsx:160` — med/high
5. Pointer-up can discard the final sidebar resize — `ui/sidebar.tsx:388` — low/high

#### W5 bug-hunt: web non-component src (job …ac5b79d7) — 9 findings, 6 rejected

1. [known-0727] Closing a preview bypasses recording cleanup — `previewStateStore.ts:345` — high/high
2. Draft hydration discards preview annotations and orchestrateMode — `composerDraftStore.ts:1630` — med/high
3. Workers deep links select a run from the wrong thread — `workers/WorkersPanel.tsx:87` — med/high
4. Late settings hydration can overwrite an optimistic user update — `hooks/useSettings.ts:92` — med/high
5. [known-0727] Rotated secondary bearer tokens leave HTTP snapshots stale — `connection/platform.ts:530` — med/high
6. [known-0727] Throwing localStorage access crashes module init — `composerDraftStore.ts:71` — med/high
7. Empty worker results suppress their accompanying read error — `workers/WorkersPanel.tsx:851` — low/high
8. Missing verification exit codes styled as successful — `workers/WorkersPanel.tsx:568` — low/high
9. [known-0727] Non-durable stash fallback duplicates the live prompt — `promptStashStore.ts:104` — low/high

#### M1 bug-hunt: mobile features A–L (job …b7138e9a) — 5 findings, 5 rejected

1. Live Activity toggles can commit an older intent after a newer one — `liveActivityPreferences.ts:69` — med/high
2. Asset URL failures render as permanent preview loading — `workspaceFileAssetUrl.ts:21` — med/high
3. Blurred native-stack screens retain active keyboard shortcuts — `hardwareKeyboardCommands.ts:27` — med/high
4. Failed notification navigation recorded as successfully handled — `notificationPayload.ts:99` — med/med
5. Created-at sorting sends quick tasks to the wrong machine — `homeThreadList.ts:364` — med/high

#### M2 bug-hunt: mobile features M–Z (job …ea46a325) — 5 findings, 5 rejected

1. Project-script input can be discarded while a cached terminal restarts — `ThreadTerminalRouteScreen.tsx:607` — high/high
2. Review comments can push a thread draft beyond the 8-attachment contract — `ReviewCommentComposerSheet.tsx:139` — med/high
3. Failed Live Activity disablement leaves the switch lying — `SettingsRouteScreen.tsx:371` — med/high
4. Pending inline comments silently re-anchor to unrelated lines — `nativeReviewDiffAdapter.ts:372` — med/high
5. Pull-to-refresh reports completion before refresh completes — `useReviewSections.ts:154` — low/high

#### M3 bug-hunt: mobile non-features + modules (job …30e89ad1) — 11 findings, 7 rejected

1. [known-0727] Draft persistence races can lose or resurrect drafts — `use-composer-drafts.ts:214` — high/high
2. Branch creation failure does not stop the pending Git action — `use-selected-thread-git-actions.ts:229` — high/high
3. Awaited branch refresh returns the pre-refresh cache — `use-selected-thread-git-actions.ts:167` — med/high
4. Multi-select input collapsed to one string — `use-selected-thread-requests.ts:29` — med/high
5. Valid free-form input questions (options: []) discarded — `lib/threadActivity.ts:173` — med/high
6. Android pasted images can carry wrong MIME type — `lib/composerImages.ts:208` — med/high
7. Failed pasted images consume attachment slots — `lib/composerImages.ts:250` — low/high
8. Environment removal can succeed while owned outbox data remains — `connection/platform.ts:214` — med/high
9. Concurrent first-use identity loads can mint different device IDs — `persistence/mobile-storage.ts:191` — med/med
10. Android drops the composer submit-key contract — `Code456ComposerEditorModule.kt:55` — low/high
11. Android review refresh props are inert — `Code456ReviewDiffModule.kt:51` — low/high

#### D1 bug-hunt: apps/desktop (job …72845906) — 10 findings, 5 rejected

1. Readiness timeout permanently parks a live backend — `DesktopBackendManager.ts:371` — high/high
2. Failed update installation leaves destructive teardown unrecovered — `DesktopUpdates.ts:475` — high/high
3. Relaunch failure swallowed after application shutdown — `DesktopLifecycle.ts:149` — high/high
4. [known-0727] Recording ownership neither lifecycle-owned nor atomically claimed — `preview/Manager.ts:1308` — high/high
5. Concurrent readiness and activation can create duplicate main windows — `DesktopWindow.ts:662` — med/high
6. Configuration resolution failure silently abandons startup — `DesktopBackendManager.ts:456` — med/high
7. Cancelled picker can complete into a later picker session — `preview/PickPreload.ts:1185` — med/high
8. `returnByValue: false` contradicts the automation contract — `preview/Manager.ts:972` — med/high
9. Annotation drawings use stale SVG coordinates after resize — `preview/PickPreload.ts:379` — low/high
10. Backend log chunks corrupt split UTF-8 characters — `DesktopObservability.ts:62` — low/high

#### P1 bug-hunt: contracts + shared + client-runtime (job …f35d95a8) — 8 findings, 5 rejected

1. Remote normalization conflates distinct repository endpoints (ports/case dropped) — `shared/src/git.ts:114` — high/high
2. Workers polling fallback dies after its first transient failure — `client-runtime/src/state/workers.ts:20` — med/high
3. Worker projections use independent, non-atomic snapshots; getRun masks runs-side error — `client-runtime/src/state/workers.ts:46` — med/high
4. `unknown` jobs disappear from run rollups (total > sum of buckets) — `contracts/src/workers.ts:121` — med/high
5. Mobile attributes new active work to the preceding turn (shared timing ignores activeTurnId) — `shared/src/orchestrationTiming.ts:34` — med/high
6. [known-0727] Rotated bearer credentials don't reach retained HTTP snapshot clients — `client-runtime/src/connection/registry.ts:363` — med/high
7. [known-0727] SemVer parsing loses precedence information — `shared/src/semver.ts:10` — med/high
8. Contracts contains executable consumer policy (schema-only boundary breach) — `contracts/src/providerRuntime.ts:117` — info/high

#### P2 bug-hunt/drift: effect-acp + effect-codex-app-server (job …c976cf10) — 4 findings, 5 rejected

1. [known-0727] Inbound request handlers block response routing (both protocol readers) — `effect-codex-app-server/src/protocol.ts:272` — high/high
2. Requests started after protocol termination can wait forever — `effect-codex-app-server/src/protocol.ts:176` — high/high
3. ACP child-process client leaves stderr undrained (pipe-full hang) — `effect-acp/src/client.ts:618` — high/high
4. Generated `turn/start` codec drops `collaborationMode` (server works around via raw.request) — `_generated/schema.gen.ts:42565` — med/high

#### P3 bug-hunt: ssh + tailscale + scripts + oxlint-plugin (job …a68abcb6) — 7 findings, 5 rejected

1. [known-0727] Disconnect does not cancel an in-flight tunnel creator — `ssh/src/tunnel.ts:1146` — high/high
2. [known-0727] SSH aliases disagree about ownership of one remote runtime — `ssh/src/tunnel.ts:1360` — high/high
3. Reconnect kills the managed remote it just discovered — `ssh/src/tunnel.ts:518` — med/high
4. Metro readiness accepts an unrelated listener — `scripts/mobile-showcase.ts:482` — med/high
5. Stale lint-debt ceilings permit new manual Effect runtimes — `oxlint-plugin…/no-manual-effect-runtime-in-tests.ts:24` — med/high
6. Interactive SSH commands leak temporary askpass directories — `ssh/src/auth.ts:102` — low/high
7. Capture leaves borrowed simulators globally modified — `scripts/mobile-showcase.ts:758` — low/high

#### Simplification lens (4 workers: server …51aa126d, web …f0398769, mobile+desktop …93aea679, packages …0a5687a7) — 20 findings total, all low/info by design

Server: [known-0727] consolidate parser-normalization policy (`claudeSessionParser.ts:81` + codex/openCode twins); [known-0727] one `stampProviderInstanceIdentity` helper replaces 5 driver copies (`ClaudeDriver.ts:92` …); consolidate repeated proposal-environment guard (`ws.ts:2335/2353/2371`); reuse `Predicate.isObject` (13 local copies) + one diagnostic encoder (4 copies); remove verified dead leaves (`continuationContract.ts:43`, `ProviderInstanceRegistryLive.ts:414`, `ProviderSessionDirectory.ts:213`, `preview/handlers.ts:89`, `CodexHomeLayout.ts:416`, `providerSnapshot.ts:100`, + text-gen/keybinding types).
Web: derive stage model context once in plan card (`OrchestratePlanCard.tsx:602` vs `:882`); shared `useSidebarThreadNavigation` (4 copies); shared project preference-ordering helper (4 copies); `errorMessageOr` helper replaces 56 identical ternaries across 13 files; [known-0727] delete six unreachable UI modules (SplashScreen, AuthSurfaceShell, ui/card|field|fieldset|form — 351 lines).
Mobile/desktop: extract duplicated Thread List v2 state hook (`HomeScreen.tsx:426` = `ThreadNavigationSidebar.tsx:361`, ~130 lines); [known-0727] centralize work-log extraction (mobile `threadActivity.ts:621` = web `session-logic.ts:906`; changed-files also in server `ActivityPayloadProjection.ts:23` — S-01/C-02 from 07-27); consolidate four desktop atomic-write sequences; `firstRouteParam` helper (6 copies); remove unreachable leaves (`diffParser.ts`, `GlassSafeAreaView.tsx`, `ThreadTerminalPanel.tsx` [known-0727], `normalizeAgentAwarenessRelayBaseUrl`).
Packages/scripts: remove zero-consumer contract surface (`ipc.ts:200` … 10 identifiers incl. 119-line `EnvironmentApi`); delete unused stream-command chain (`client-runtime/state/runtime.ts:352`, ~60 lines); delete verified zero-consumer leaves across shared/client-runtime/tailscale/scripts (~25 identifiers); consolidate four identical script stream collectors; reuse AST string reader in oxlint plugin.
Notable rejections recorded: no generic provider factory; no WorkersPanel row merge; no card-vs-panel status-derivation merge (states intentionally differ); no Sidebar V1/V2 unification; no generic storage layer; no cross-package stdio helper coupling.

#### Consolidation lens (4 workers: server …2643fb7c, web …1d1dcd11, mobile+desktop …308b319f, workspace …161fc402) — 28 findings

Server: workers snapshot streaming multiplies watchers/scans — copied VCS's stream interface but not its singleton broadcaster ownership (`WorkersStatusBroadcaster.ts:48`, med); [known-0727] parser policy partially consolidated (`parserSupport.ts:24`, med); [known-0727] settled-turn mapping has three exact owners (`projector.ts:58` + `ProjectionPipeline.ts:80` + `client-runtime/threadReducer.ts:532`, med); text-gen service assembly repeated ×5 (`ClaudeTextGeneration.ts:262`, med); [known-0727] home expansion ×5 (`pathExpansion.ts:17`, low); [known-0727] identity stamping ×5 drivers (low); [known-0727] SQL-vs-schema error classification ×7 (`persistence/Errors.ts:75`, low); ACP tool-kind mapping ×3 (low); descendant path checks ×3 (low); `git remote -v` parsing ×3 (low).
Web: workers read model lacks one canonical owner — 3 independent atom families + per-card subscription; panel 4 scans/refresh, open run 6; unknown-status jobs settled-vs-active disagreement between panel and card (`client-runtime/state/workers.ts:20`, med); run deep links discard thread-scoped owner (`WorkersPanel.tsx:78`, med — same root cause as W5 bug 3); plan supersession from virtualized mount order + raw-runId keying + no eviction (`orchestratePlanStore.ts:34`, med — same root cause as W1 bugs 2/3); [known-0727] work-activity invariants copied web/mobile/server (med); ChatMarkdown reimplements `useCopyToClipboard` twice (low). Confirmed clean: `useSyntaxThemeName` adoption complete.
Mobile/desktop: mobile drops multi-select answers — web has full policy, consolidate in client-runtime (`threadActivity.ts:30`, HIGH — same root cause as M3 bug 4); mobile threadListV2 port already drifted from web settled ordering (`threadListV2.ts:96`, med); [known-0727] composer persistence bypasses `SerializedAsyncQueue`; outbox reimplements it (`use-composer-drafts.ts:104`, high — same root cause as M3 bug 1); [known-0727] work-log extraction ×3 (med); review-comment wire codec ×2 (`reviewCommentSelection.ts:40` = web `reviewCommentContext.ts:48`, med); cloud modules bypass MobileSecureStorage (low); desktop atomic-write ×4 + server `atomicWrite.ts` at wrong boundary — move to shared (med); desktop release identity copied across runtime/build/launcher (low).
Workspace: [known-0727] work-log normalization (dedupe with above); [known-0727] settlement policy triplication (dedupe); client-sharing ownership inverted at both edges — generic hooks duplicated in apps while single-client feature families (preview/workers/relayDiscovery) sit in client-runtime (`use-atom-command.ts:1`, med); contracts owns runtime policy — 12 HttpServerRespondable error classes + model preference/alias/label maps (`environmentHttp.ts:100`, `model.ts:145`, med); [known-0727] mobile vite.config relies on undeclared `vite-plus` dep (low). Confirmed clean: tests/ tree conventions fully reconciled; dependency direction app→packages holds.

#### Test-gaps lens (3 workers: server …0d7a3bad, web+client-runtime …703b2542, mobile …b82d7e88) — 13 proposals, each with exact path + assertion

Server (197 existing test files inventoried; no `tests/apps/server/workers/` suite exists): `serverSettings.test.ts` rollback-after-rejection regression (HIGH — pairs with S2 bug 1); `workers/WorkerBrokerStore.test.ts` disk decode + aggregateRuns rollups + malformed-record degradation (HIGH); `workers/WorkersStatusBroadcaster.test.ts` initial snapshot + TestClock fallback liveness (HIGH); `workers/WorkersReadiness.test.ts` bad-Claude-config → Codex fallback (MED).
Web/client-runtime (no suite covers workersPanel.logic, orchestratePlanStore, OrchestratePlanCard, or client-runtime state/workers): `OrchestratePlanCard.test.ts` plan parsing + exact approval-reply grammar incl. `run=` correlation (HIGH; needs small pure export of the reply builder); `orchestratePlanStore.test.ts` supersession epochs + recoverable card state (HIGH); `client-runtime state/workers.test.ts` subscribe-failure → filtered polling fallback (HIGH); `workersPanel.logic.test.ts` stage grouping + patch-file reconciliation (MED); `composerDraftStore.test.ts` orchestrateMode persistence round-trip (MED — pairs with W5 bug 2).
Mobile: `use-composer-drafts.persistence.test.ts` hydration/clear races (P0 — pairs with M3 bug 1); `mobile-database.migration.test.ts` destructive migration commit boundary (P1); `threadActivity.test.ts` approval/user-input lifecycle reducers (P1); `connection/pairing.test.ts` manual pairing URL round-trip (P2).
All three returned Deliberately-Not-Testing lists (UI markup, framework glue, exhaustive permutation matrices) and explicitly honored the 07-29 pruning audit.

#### Performance lens (3 workers: server …aef0bd9e, web …907f6d72, mobile …f1ec3b2d) — 9 confirmed, 9 needs-measurement

Server confirmed: workers subscriptions rescan+retransmit all historical jobs — 2 streams×(list+listRuns→2×list) = 4 full scans/3s idle panel, 6 with run open, +readiness scans all jobs for `stateDir` (`WorkersStatusBroadcaster.ts:48`, med — same root cause as consolidation finding); always-on provider NDJSON logging double-serializes every streaming delta with sync appendFileSync (`EventNdjsonLogger.ts:136`, med); [known-0727] idle diagnostics full process-table scan/5s (~57.5ms CPU/tick); [known-0727] per-terminal process scans/1s (~28ms/terminal); [known-0727] opt-in assistant streaming projects every delta (13 SQLite changes/delta when enabled). Needs-measurement: 4 SQLite reads per provider event; unbounded queue chain w/o depth telemetry; unpaginated thread snapshots; MCP tool payloads bypass transport pruning.
Web confirmed: [known-0727] streaming deltas repeat full Markdown parse (23→240ms as size grows) + highlight-cache bypass; one workers panel = 2–4 independent full-snapshot streams (matches server finding); unstable `orchestratePlanActions`/`onSend` identity invalidates EVERY mounted assistant ChatMarkdown row per ChatView render during streaming (`ChatView.tsx:4662`, med/high — new-branch code). Needs-measurement: unvirtualized worker history lists; [known-0727] Explorer's ~50-84 RPCs/min polling.
Mobile confirmed: rolling terminal history recreates + replays native surface after 512KiB cap (~256MiB replayed per 512 events; `NativeTerminalSurface.tsx:225`, high); text edits rewrite every attachment's base64 to one JSON file (up to ~213MiB per debounced edit; `use-composer-drafts.ts:177`, high). Needs-measurement: [known-0727] per-delta feed derivation + full Markdown reparse; composer full-draft bridge round-trips; review highlighter init on image previews.

### Verification Wave Digest (claude-opus-5:high, refute-first)

#### V1 server-core (job …24f998de; verifies S1+S2+S3)

All 20 findings CONFIRMED; severity recalibrated (finder high → verifier medium) on 8 of them with named mitigations: Codex protocol blocking is per-thread-child scoped; lifecycle-compensation findings need storage faults; archived-session leak is bounded ≤~30min by `ProviderSessionReaper`. Held HIGH: persisted intents lost across reactor downtime (`OrchestrationEngine.ts:53` — reactors consume hot streams only, receipts short-circuit retries; routine restarts drop user turns).
RESURRECTED: CLI clears server runtime state without ownership verification (`cli/project.ts:370` + `serverRuntimeState.ts:78` — unconditional `fs.remove` after failed probe races a restarting server; low/high).
Clusters identified: (a) session-binding integrity = `ProviderService.ts:793` + `ProviderRuntimeIngestion.ts:1338` → one session-generation token fixes both; (b) adapter send-path prep = `CursorAdapter.ts:925` + `ClaudeAdapter.ts:3890` → hoist fallible prep above classify→publish, hold keyed lock (Grok shape); (c) missing-outbox pattern = `OrchestrationEngine.ts:53` + `ProjectionPipeline.ts:1655`.
Also: attachment-prep finding is worse than filed — stranded `turnState` makes the NEXT send steer into the dead turn.

#### V2 server-rest+perf (job …f2909f5a; verifies S4+S5+S6+perf-server)

CONFIRMED 19, REFUTED 1, UNVERIFIABLE 1. Refuted: malformed worker timestamps invalidating workers response — `IsoDateTime` (`contracts/baseSchemas.ts:20`) is `Schema.String` with no validation, so nothing fails to encode. Unverifiable: early-PTY event loss (needs runtime harness). Severity recalibrations: import budget reset high→low-med (serial loop bounds memory; tests call the limits "per-session" — product decision needed); checkpoint-restore destruction high→med (deleting uncommitted state is restore's intended semantics; defect is non-atomicity); cookie-shadows-Authorization med→low (no live client sends both). Held HIGH: cross-fork PR worktree reuse (`GitManager.ts:1810` — trigger broader than filed: ANY same-named local branch worktree gets hijacked). DPoP replay growth held MEDIUM.
ESCALATION (new finding): native+canonical loggers open two independent `RotatingFileSink`s against the SAME file (`EventNdjsonLogger.ts:214`, `ProviderEventLoggers.ts:74-78`) — racing rotations can truncate/clobber backups; correctness item, separate from the logging perf work.
All 4 needs-measurement perf items confirmed as correctly labeled (no LIMIT on thread-activity query confirmed at `ProjectionSnapshotQuery.ts:1056`; 31 unbounded queue sites counted). Spot-checked rejections: all 10 sound.

#### V3 server-lenses (job …24af50a2; verifies simp-server + cons-server + tg-server)

All findings CONFIRMED. Corrections: preview handlers path is `mcp/toolkits/preview/handlers.ts:89`; SQL/decode classifier count is EIGHT not seven (adds `ProjectionSnapshotQuery.ts:411`); home-expansion consolidation must keep the injected `Path.Path` seam; parser-policy consolidation raised low→med (untrusted-input resource policy ×3 files); workers-stream consolidation raised med→med-high (~205 job records live on this host). Text-gen ×5 consolidation confirmed but costed up (span names are observable telemetry; runJson hook is load-bearing). RESURRECTED: settled-turn mapping consolidation (simp-server wrongly rejected it as out-of-scope; shared/orchestrationTiming.ts is the destination). Settings-rollback test RECLASSIFIED: red against HEAD — must ship with the `serverSettings.ts:537-551` ordering fix, not as test-only. Test proposals otherwise confirmed incl. exact fixture math for aggregateRuns; both workers test setups must inject `HostProcessEnvironment` (modules don't read process.env). WorkersStatusBroadcaster test flagged flake-risk (real fs.watch + TestClock mix).

#### V4 web-feature/non-component/perf (job …f391368a; verifies W4+W5+perf-web)

19 findings: 17 CONFIRMED (5 severities lowered, none raised), 0 refuted, 2 needs-measurement upheld with exact cadence math (Explorer 50→84 RPCs/min reproduced from live constants; workers panel 2–4 streams ×2 scans confirmed; 209 job dirs on this host, no retention). Preview-close recording latch = ONE defect double-reported (W4+W5) — unrecoverable without reload; med-high. fileSaveCoordinator dispose-replay confirmed — fires on ordinary file/thread switches, `dispose()` untested. composerDraftStore normalizer drops `previewAnnotations`+`orchestrateMode` confirmed (zero test hits). Workers deep-link cross-thread bug confirmed (persisted insertion order decides; null case doesn't reset nav). Unstable `onSend` → `orchestratePlanActions` identity confirmed as the cheapest high-leverage perf fix. Blocked-storage pair (composerDraftStore:71 + promptStash) downgraded to low — no demonstrated throwing deployment target; fix together with `useLocalStorage.ts:18` if at all. All 7 spot-checked rejections sound. Out-of-lens: `orchestrationRecovery.ts` is dead production code.

#### V6 web+workspace lenses (job …68ab3987; verifies simp-web + cons-web + cons-workspace + tg-web)

20 findings verified, 0 refuted; 18 at stated severity. Key structural calls: split the workers finding in two — unknown-status lifecycle divergence (4 sites disagree; LOW-RISK fix, do first) vs stream consolidation (bigger refactor); write the client-runtime workers fallback test BEFORE the stream refactor (regression net; "highest-value item in the batch"); land supersession redesign BEFORE the orchestratePlanStore test (as proposed it would cement the mount-order bug — V4.2 high→med with assertion rewrite). Contracts policy leak confirmed as a documented-invariant violation (AGENTS.md:21 "schema-only"); start with `PROVIDER_DISPLAY_NAMES`. Client-sharing finding downgraded med→low: extract the 4 byte-identical web/mobile adapters + breadcrumb helper; DROP the "demote single-client families" half. ChatMarkdown clipboard consolidation is NOT behavior-preserving as written (4 behavioral deltas enumerated). errorMessageOr sweep = standalone commit (56 sites, no test cover). Dead-UI-module deletion needs owner confirmation (may be an intentional primitives shelf). All 6 spot-checked rejections upheld (Sidebar V1/V2 both live; syntax-theme extraction verified complete).

#### V7 mobile (job …816f707a; verifies M1+M2+M3+perf-mobile+tg-mobile)

22 findings: 21 CONFIRMED (5 severities lowered: keyboard shortcuts, notification dedup, created-at target, review re-anchor, review-comment cap), 1 REFUTED: free-form `options: []` questions — web has the byte-identical drop policy (`session-logic.ts:450`) and no server producer emits empty options; cross-platform feature request, not a mobile bug. Held HIGH: terminal script-input discard (`ThreadTerminalRouteScreen.tsx:607`; server silently no-ops writes to exited sessions), draft persistence races, branch-creation-failure continuation (`GitConfirmSheet.tsx:90-91` runs the Git action unconditionally). Terminal 512KiB replay + base64 draft rewrite confirmed by mechanism (magnitudes are worst-case arithmetic). RESURRECTED: out-of-range numeric HTML entities throw RangeError in render-phase Markdown decode (`nativeMarkdownText.ts:79` — reachability chain established through every text node; low/med, one-line guard).
Clusters: Live Activity toggle = one defect across `liveActivityPreferences.ts:69` + `SettingsRouteScreen.tsx:371` (fix together); `use-composer-drafts.ts` hit by three lenses (races + write amplification + missing test) → one "single persistence owner + payloads out of document" work item; iOS-only native contracts (composer onSubmit, review pull-to-refresh) = one convention decision. Test proposals confirmed; draft-persistence test lowered P0→P1 (needs a production seam). Stale anchor noted in M3's rejected list (`thread-outbox-manager.ts:319` doesn't exist at HEAD) — re-resolve anchors by symbol before patching.

#### V5 web chat-side (job …0498d392; verifies W1+W2+W3)

15 CONFIRMED, 2 REFUTED (impossible-budgets — supported user cap per model-plan grammar; ServerUpdateAction leak — remounted via banner key). RAISED to high: pending-input `promptRef` divergence — the send path reads `promptRef.current` at `ChatView.tsx:4700`, so the next Send transmits the ANSWER instead of the visible draft. Held high: supersession inversion (superseded card loses Approve/Edit entirely — not cosmetic; trigger is the DOCUMENTED same-runId re-emit flow) and draftKey=runId inheritance (re-gate plans additionally dead-ended by `runStarted` disable — same dead end by a second route). Trigger corrections: thread-deletion fires on navigate rejection only (the wait resolves false, never rejects); publish-dialog leak needs a mid-flight dismissal (close resets state). Severity drops: composer-crash + stash-duplicate (disjoint localStorage preconditions — fix together), duplicate-stage-ids (contract already forbids input), attachment reorder (persisted copy only; live send order correct). All 7 spot-checked rejections upheld (incl. double-approve guard and zero-worker stages). New observation (unverified interaction): orchestrate approval routed through `onSend` can be intercepted by the plan-follow-up branch at `ChatView.tsx:4715` when a proposed plan is simultaneously actionable. The orchestrate card surface has ZERO tests.

#### V8 desktop + packages + lens tracks (job …46040355; verifies D1+P1+P2+P3+simp-md+cons-md+simp-pkg)

43 findings: 42 CONFIRMED (many recalibrated: desktop highs → med-high/med; P1 package findings mostly → low-med; codex post-termination hang → med; collaborationMode codec → low), 1 REFUTED (git.ts normalization — documented/tested canonicalization purpose). Held high: protocol reader blocking ([known-0727]), ssh tunnel creator cancellation ([known-0727]), preview recording latch ([known-0727]), mobile multi-select (RE-FILED as correctness bug, "top of the bug queue"). RESURRECTED: stale `projects.list/add/remove` RPC constants → deletion set. Dedupe rulings: work-log extraction (simp-md=cons-md) one item; desktop atomic-write — adopt the desktop-local-helper framing, REJECT reusing server `atomicWrite.ts` (different temp-path shape, no phase-tagged errors); semver = bug fix not simplification. Caveats: relay `typ` constants may be the only in-repo record of the wire protocol — confirm external consumer before deleting; two production files' sole consumers are tests (`PickLabelPosition.ts`, `terminalRouteBootstrap.ts`) — needs an owner decision, not silent deferral.

## Part II — Uncommitted working-tree diff audit

**Last Updated:** 2026-07-31
**Merged From:** `dev-docs/mega-review-core-2026-07-31-diff.md` (removed after consolidation)
**Lifecycle Status:** Proposed (review complete; awaiting action-group approval)
**Scope:** Uncommitted working-tree diff vs `8d7d65dfa` (temp orchestration base `760953e1d`, soft-reset after run). 66 modified + 11 untracked files, ~2,950 insertions / ~453 deletions. Three interleaved workstreams: (a) mid-thread provider switch, (b) provider usage meter, (c) workers panel / run activity. Excluded: `pnpm-lock.yaml`, `dev-docs/mega-review-core-2026-07-31.md`.
**Codebase Size:** diff-scoped review; surrounding live code read for context
**Lenses run:** bug-hunt, simplification, consolidation, test-gaps, performance
**Security:** Out of scope by design; use a separate security-remediation pass when needed.
**Mode:** Read-only review
**Effort:** Thorough — orchestrate run `megacore-diff-r7q2`: 10 fanout workers (codex gpt-5.6-luna:max — 6 region bug-hunt finders + 4 lens readers) + up to 6 verify workers (codex gpt-5.6-sol:high), maxWorkers 18. Synthesis in lead session.

### Executive Summary

- **Confirmed findings:** 13 verified bug/perf findings (1 P1, 7 P2, 5 P3) + 6 consolidation + 5 simplification + 5 proposed tests, across all five lenses. 1 candidate refuted in verification, 4 parked as needs-measurement.
- **Top issues to address first:**
  1. **F2-1 (P1):** a non-timeout send failure after a hidden compaction turn starts leaves the session stranded and blocks all later switches (`HiddenTurnRegistry.ts`).
  2. **O-001 (P2):** `turn.aborted` is not a lifecycle-closing event in `ProviderRuntimeIngestion`; an aborted compaction leaves the thread projected `running` and switch retries are rejected.
  3. **L4-PERF-01 (P2):** the provider-switch path awaits hidden compaction (120s+ worst case) on the single global provider-command worker, stalling approvals/interrupts for every thread.
  4. **F6-MOBILE-1 (P2):** mobile silently sends `orchestrate` mode to non-supporting providers after a cross-client switch; ClaudeAdapter silently downgrades. Root cause: capability is menu presentation, not a domain invariant.
  5. **O-002 (P2):** a second switch before the first post-switch turn silently discards the unconsumed handoff (no decider or UI guard on `pendingHandoff`).
- **Biggest risks:** Group C (reactor concurrency) must preserve per-thread FIFO and three ledger guards; Group B/E fixes touch the same reactor code — sequence them, don't parallelize.
- **Clean areas checked:** no contract/shape drift between server emitters, ws routing, and client reducers (F5); no dangling `ContextWindowMeter` references; changed tests are mostly valid (one suppression-test defect); migration 040 round-trip and replay verified sound; mobile cannot crash on the new events.
- **Recommended next move:** approve Phase 1 (Groups G, H, I — low-risk, independent) and Phase 2 (Group A — the P1 cluster).

### Approach

- Fanout: 6 region bug-hunt finders (server orchestration; server provider layer; persistence/workers/ws; web chat+composer; web workers panel + client-runtime + contracts + shared; mobile + changed-test validity) using finder -> refute -> synthesize; 4 whole-diff lens readers (simplification, consolidation, test-gaps, performance).
- Conventions read first: `AGENTS.md` (tests under repo-root `tests/`, focused verification only, contracts schema-only, shared subpath exports, client-runtime cross-platform role).
- Workers were seeded with the known-settled ledgers so settled claims are not re-reported: the provider-switch review-fix ledger (10 fixed items), its deferred residual risks, and the whole-repo audit's refuted claims.
- Merge: dedupe by root cause across lenses; adversarial refute-first verification (gpt-5.6-sol:high) for high-risk survivors; refuted and unresolved claims preserved below rather than forced to a verdict.

### Architecture Snapshot

- `apps/server/src/orchestration/` — event-sourced thread engine: `decider.ts` (intent -> events, new provider-switch gates), `projector.ts`, reactors under `Layers/` (checkpoint, provider command, runtime ingestion, projection pipeline/snapshot), new `ProviderSwitchPolicy.ts` (cheap-model compaction map).
- `apps/server/src/provider/` — provider drivers (Claude/Codex/Cursor), `ProviderService`, new `HiddenTurnRegistry.ts` (hidden awaited compaction turns), `providerSnapshot.ts` / `providerStatusCache.ts` (usage data).
- `apps/server/src/persistence/` — `Migrations.ts` + new `040_ProjectionThreadsPendingHandoff.ts` (`pending_handoff_json`), `ProjectionThreads` layers/services.
- `apps/server/src/workers/` + `ws.ts` — `WorkerBrokerStore`, `WorkersStatusBroadcaster` (`workers.subscribe` stream), thread-detail event routing.
- `apps/web/src/` — ChatView/ChatComposer + pickers (switch unlock/confirm/pill), new `ComposerUsageMeter.tsx` / `ProviderUsage.tsx` (replace deleted `ContextWindowMeter.tsx`), WorkersPanel + new `workersActivity.logic.ts`.
- `packages/contracts`, `packages/client-runtime` (rpc client, `threadReducer`, workers state), `packages/shared/composerTrigger.ts`; mobile thread composer touched lightly; tests under `tests/` mirroring sources.

### Finding Index

One row per root cause. All bug/perf findings were adversarially verified (verifiers V1–V5, gpt-5.6-sol:high); lens-only findings (consolidation/simplification/test) carry finder confidence.

| ID          | Lens(es)                   | Finding / Recommendation                                                                                                                                  | Severity   | Confidence | Risk | Group     | Status                |
| ----------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | ---- | --------- | --------------------- |
| F2-1        | bug-hunt                   | Hidden turn abandoned on non-timeout send failure -> stranded session, blocked switches                                                                   | P1         | H          | Med  | A         | Verified              |
| O-001       | bug-hunt                   | `turn.aborted` not lifecycle-closing -> stuck `running` projection blocks switch retry                                                                    | P2         | H          | Med  | A         | Verified              |
| MODEL-CACHE | bug-hunt                   | `threadModelSelections` not updated on switch completion -> runtime-mode race reopens old provider                                                        | P2         | M-H        | Low  | A         | Verified              |
| O-002       | bug-hunt                   | Consecutive switch discards unconsumed pendingHandoff (no guard)                                                                                          | P2         | H          | Low  | B         | Verified              |
| L2-02       | consolidation              | Handoff projection implemented 3x (projector, pipeline, reducer) -> extract shared helper                                                                 | P2         | H          | Low  | B         | Finder-verified       |
| L4-PERF-01  | performance, bug-hunt      | Switch awaits compaction on global provider-command worker -> cross-thread stall up to 120s+                                                              | P2         | H          | High | C         | Verified              |
| F4-001      | bug-hunt                   | Projection-follow ref advances before provider-status check -> composer permanently stale                                                                 | P2         | H          | Low  | D         | Verified              |
| F4-002      | bug-hunt                   | Switch token derived from stale session projection -> next switch rejected                                                                                | P3         | H          | Low  | D         | Verified (downgraded) |
| F6-MOBILE-1 | bug-hunt                   | Mobile sends orchestrate to non-supporting provider; silent adapter downgrade                                                                             | P2         | H          | Med  | E         | Verified              |
| F4-004      | bug-hunt                   | Typed `/orchestrate` bypasses capability guard order; draft stuck unsendable                                                                              | P3         | H          | Low  | E         | Verified (downgraded) |
| L1-05       | simplification             | `supportsOrchestrateMode ?? codex` fallback duplicated at 6 sites -> shared helper                                                                        | P3         | H          | Low  | E         | Finder-verified       |
| F4-005      | bug-hunt                   | Context-window activities lose provider identity -> meter mixes A context with B label                                                                    | P3         | H          | Med  | F         | Verified (downgraded) |
| L2-04       | consolidation              | Provider-usage math web-only; move pure derivations to client-runtime                                                                                     | P2         | H          | Low  | F         | Finder-verified       |
| F2-2        | bug-hunt                   | Unbounded rate-limit RPC degrades whole Codex status snapshot                                                                                             | P2         | H          | Low  | G         | Verified              |
| WKR-001     | bug-hunt                   | Unsafe activity sequence passes normalization, kills RPC stream (defect + interrupt)                                                                      | P2         | H          | Low  | H         | Verified              |
| WKR-002     | bug-hunt                   | Tail-read boundary drops a complete activity record                                                                                                       | P3         | H          | Low  | H         | Verified              |
| F5-1        | bug-hunt                   | Live jobs render em dash for elapsed in both tables                                                                                                       | P3         | H          | Low  | H         | Verified (downgraded) |
| F6-TEST-1   | test-gaps                  | Broadcaster suppression test cannot detect suppression regression                                                                                         | P3         | H          | Low  | H         | Verified (downgraded) |
| L1-03       | simplification             | `workerJobElapsedLabel` re-implements settled formatting                                                                                                  | P3         | H          | Low  | H         | Finder-verified       |
| L1-04       | simplification             | Broadcaster re-implements `isSafeJobId` (minus backslash check)                                                                                           | P3         | H          | Low  | H         | Finder-verified       |
| L2-06       | consolidation, performance | ProviderSwitchPolicy aliases don't match standard catalogs (Claude `sonnet`, Grok/Cursor fallback) -> compaction silently runs on current expensive model | P3         | H          | Low  | I         | Verified (narrowed)   |
| L2-01       | consolidation              | Switch dispatch web-local; belongs in client-runtime command layer                                                                                        | P2         | H          | Med  | J         | Finder-verified       |
| L2-03       | consolidation              | `isThreadDetailEvent` list unsynchronized with reducer -> shared predicate                                                                                | P2         | H          | Low  | J         | Finder-verified       |
| L2-05       | consolidation              | Codex/Claude usage-window normalizers duplicated -> server helper                                                                                         | P3         | H          | Low  | J         | Finder-verified       |
| L1-01       | simplification             | `deriveLockedProvider` has 4 dead input fields                                                                                                            | P3         | H          | Low  | J         | Finder-verified       |
| L1-02       | simplification             | No-op `handleProviderModelSelect` wrapper                                                                                                                 | P3         | H          | Low  | J         | Finder-verified       |
| T1–T5       | test-gaps                  | 5 proposed tests (reducer switch events; replay equivalence; handoff-clear ingestion; migration 040; hidden-turn timeout)                                 | High-value | H          | —    | per group | Proposed              |

### Worker Reports Digest (fanout wave)

Raw per-worker candidates, pre-merge and pre-verification. Statuses here are the finders' own claims; the merged Findings section below is authoritative once written.

#### F2 — server provider layer (completed)

- **F2-1 (P1/high):** `HiddenTurnRegistry.ts:184` — started hidden turns abandoned on non-timeout send failure. Only the timeout branch interrupts/stops; `ensuring` just removes waiter maps. Trigger: Cursor ACP `session/prompt` rejects after `turn.started` during a switch -> session can stay running with the failed turn active, blocking later switches. Fix: failure-path teardown (interrupt, await termination, stop if no terminal event). AG hint: hidden-turn cleanup.
- **F2-2 (P2/high):** `CodexProvider.ts:562` — `account/rateLimits/read` has no local timeout inside the concurrent probe `Effect.all`; a stalled usage RPC fails the whole 10s probe and degrades the snapshot to failed/unknown instead of usage-unavailable. Fix: bound the auxiliary RPC or split usage from health probe.
- Refuted: hidden-event projection leak; timeout leaving session running; user turn steering into compaction; stale accountUsage hydration; orchestrate mode sent raw to Codex.

#### F3 — persistence + workers + ws (completed)

- **WKR-001 (P2/high):** `WorkerBrokerStore.ts:445` — activity `sequence` accepted via `Number.isInteger` but contract `PositiveInt` requires safe int; `sequence: 9007199254740992` in activity.jsonl violates the RPC contract and can reject the whole activity stream. Fix: `Number.isSafeInteger` + skip record.
- **WKR-002 (P3/high):** `WorkerBrokerStore.ts:763` — bounded tail read unconditionally drops the first split line; when the offset lands exactly on a record boundary a complete record is discarded and counted as unreadable. Fix: only drop genuine fragments (seek to preceding newline).
- Refuted: migration 040 replay gap; pending-handoff JSON round-trip mismatch; switch detail-event omission; activity stream failure on missing files; unbounded/throwing activity parsing.

#### F5 — web workers panel + client-runtime + contracts (completed)

- **F5-1 (P2/high):** `WorkersPanel.tsx:265` — both job tables use legacy `workerElapsedLabel(job.elapsedMs)`; live queued/running jobs without `elapsedMs` render an em dash while the detail view computes live elapsed via `workerJobElapsedLabel(job, nowMs)`. Fix: pass panel clock into row components.
- Refuted: missing switch-requested reducer handling (intentional no-op; provider-switched does the update); switch payload drift; workers RPC shape drift; activity ordering/keys; shared trigger drift; hidden transport-error swallowing.

#### L1 — simplification (completed)

- **L1-01 (safe):** `ChatView.logic.ts:619-633` — `deriveLockedProvider` reads only `importContinuationGate`; four input fields are dead. Narrow the type + callers.
- **L1-02 (safe):** `ChatComposer.tsx:1014-1019` — no-op `handleProviderModelSelect` wrapper; pass `onProviderModelSelect` directly.
- **L1-03 (safe):** `workersPanel.logic.ts:118-121` — `workerJobElapsedLabel` re-implements `workerElapsedLabel` for its settled branch; reuse it. (Same file family as F5-1 — merge candidates.)
- **L1-04 (safe):** `WorkersStatusBroadcaster.ts:88-97` — re-implements `WorkerBrokerStore.isSafeJobId` (minus backslash check — n.b. slight divergence); export and reuse the store predicate.
- **L1-05 (needs-test):** `supportsOrchestrateMode ?? driverKind === 'codex'` fallback repeated at 6 sites across ChatComposer, ChatView, mobile ThreadComposer, new-task-flow-provider; extract one shared helper.
- Refuted: ComposerUsageMeter vs ProviderUsage overlap (different surfaces); workerJobPresentation vs row helpers; ProviderSwitchPolicy/sendTurnAndAwait as one-caller abstractions; hasRecoverableSession optionality; WorkersActivitySnapshot.readAt as dead field.

#### L2 — consolidation / architecture (completed)

- **L2-01 (P1/high):** switch dispatch is web-local (`apps/web/src/state/threads.ts:30-57`) despite client-runtime command layer (`operations/commands.ts`, `state/threadCommands.ts`). Move input/effect + `switchProvider` atom into client-runtime; mobile reuses it later.
- **L2-02 (P1/high):** pending-handoff projection implemented 3× (`projector.ts:487-495`, `ProjectionPipeline.ts:788-798`, `threadReducer.ts:175-185`) — same trim/null/copy/`occurredAt` logic. Extract one pure helper in `packages/shared` (subpath export).
- **L2-03 (P2/high):** `ws.ts` positive `isThreadDetailEvent` list vs reducer switch — unsynchronized runtime lists; extract shared `THREAD_DETAIL_EVENT_TYPES` predicate.
- **L2-04 (P2/high):** provider-usage math/selection (percent clamp, danger thresholds, tightest-window, duration ranking) web-only in `ProviderUsage.tsx`/`ComposerUsageMeter.tsx`; move pure derivations to client-runtime for mobile reuse.
- **L2-05 (P3/high):** Codex + Claude window normalizers duplicate clamp/assemble logic; server-only helper `provider/providerUsage.ts`.
- **L2-06 (P2/high):** `ProviderSwitchPolicy.ts:6-32` re-declares provider/model identity (hard-coded `sonnet`, `gpt-5.6-luna`, `grok-4.5-fast`; raw `availableModels.includes`) outside existing model tables (`contracts/model.ts`, provider catalogs, e.g. Claude maps `sonnet`->`claude-sonnet-5`) — aliases may not resolve against catalogs; keep only compaction-specific overrides keyed by canonical driver kind, resolve via shared resolver. (Correctness-adjacent — verify wave should check whether the current literals actually match live catalogs.)
- Refuted: workers activity presentation belongs in client-runtime (no mobile panel — intentional); WorkerBrokerStore normalizer as contract dup; one shared usage-extraction table; decider vs reactor validation as duplication; moving ProviderUsage JSX/URL/date handling cross-package.

#### L3 — test gaps (completed)

- **T1 (high/low-cost):** `tests/packages/client-runtime/state/threadReducer.test.ts` — live `thread.provider-switched` sets model + exact pendingHandoff; `thread.handoff-cleared` nulls; whitespace-only clears.
- **T2 (high/high-cost):** ProjectionPipeline incremental vs clean-bootstrap equivalence for switch/handoff sequences.
- **T3 (high/med-cost):** `ProviderRuntimeIngestion` — matching non-hidden completed turn clears pendingHandoff, retains switched model (the production `thread.handoff.clear` dispatch path).
- **T4 (high/med-cost):** migration 040 — legacy-row backfill null, idempotence, non-null round-trip.
- **T5 (high/med-cost):** `HiddenTurnRegistry` timeout path — `HiddenTurnAwaitError`, interrupt by provider turn id, fail-closed stopSession, waiter removal.
- Deliberately not testing: ChatView failure-toast branch (harness cost), broadcaster fs-watch path (brittle; polling fallback covered), display/glue permutations.
- Refuted gaps: decider switch validation, reactor handoff injection, bootstrap/cursor-resume, worker store/broadcaster behaviors, usage decoding/thresholds — all covered by diff's own tests.

#### L4 — performance (completed)

- **L4-PERF-01 (P2/high, confirmed):** `ProviderCommandReactor.ts:1047` — provider switch awaits `sendTurnAndAwait` (up to 120s) on the single global `makeDrainableWorker`; normal turn sends are forked but switches are not -> a switch on one thread blocks all provider commands on every thread. Fix: fork behind per-thread lock / shard by thread.
- **L4-PERF-02 (P3/high, confirmed):** `ProjectionThreads.ts:25` — `pending_handoff_json` decoded + re-encoded on every unrelated row upsert while a handoff is pending. Fix: scalar/field-specific updates or isolate handoff persistence.
- Needs measurement: **M01** activity stream per-tick full-tail reread/reparse/stringify-compare (256 KiB / 200 entries / 3s cadence); **M02** provider-status emissions re-rendering composer/usage components; **M03** `WorkersPanel.tsx:982` `jobs.find` scan per list emission.
- Refuted: full-snapshot broadcast per tick; new unpaginated run lists; CheckpointReactor serialized awaits; unstable activity keys; second thread-detail query on turn completion.

#### F1′ — server orchestration (completed; relaunch after broker restart)

- **O-001 (P2/high):** `ProviderRuntimeIngestion.ts:1366-1373` — lifecycle branch handles started/state-changed/exited/turn.started/turn.completed but not `turn.aborted`. Aborted hidden compaction (provider abort, or 120s interrupt -> turn.aborted) leaves the thread projected `running` with `activeTurnId: null`; reactor treats projected starting/running as active (`ProviderCommandReactor.ts:1089-1099`) and rejects switch retries. Fix: handle turn.aborted under the same correlation guard as turn.completed, or stop the session on this failure path.
- **O-002 (P2/high):** `ProviderCommandReactor.ts:1130-1155` — no-session switch emits `switch.complete` with `handoffText:""` which projects `pendingHandoff:null`. Consecutive switches (A->B producing H1, then B->C before any B turn) discard the unconsumed handoff. Fix: carry existing pendingHandoff through a no-context switch, or block a second switch while one is unconsumed.
- Uncertain: `threadModelSelections` not updated on switch completion — narrow `thread.runtime-mode.set` race could reuse stale selection; needs runtime coverage.
- Refuted: switch-gate bypass; hidden-turn conversation/checkpoint contamination; pending-handoff persistence loss; handoff cleared on failed visible turn; invalid compaction model selection (policy falls back to current model when candidate not in availableModels).

#### F4′ — web chat + composer (completed; relaunch after broker restart)

- **F4-001 (P2/high):** `ChatView.tsx:~5930` — projection-follow effect advances its instance ref before the provider-status lookup; a transiently absent status permanently skips `applyComposerModelSelection` -> composer stuck on old provider, next send hits cross-instance meta.update rejection.
- **F4-002 (P2/high):** `ChatView.tsx:~5696` — `currentProviderInstanceId` prefers session projection when pendingHandoff is null; after an empty-handoff switch the stale session identity feeds `expectedCurrentInstanceId` for the next switch -> server rejects.
- **F4-003 (P2/high):** `ChatView.tsx:~5892` — `switchingProviderThreadKey` cleared at RPC ack (which only queues); overlapping switches possible before `provider-switched` lands.
- **F4-004 (P2/high):** `composer-logic.ts:~260` — manually typed `/orchestrate` bypasses the capability guard order in ChatView and strands unsupported providers in an unsendable orchestrate mode.
- **F4-005 (P2/high):** `ChatComposer.tsx:~1048` — `activeContextWindow` has no provider identity; after A->B switch the meter shows A's context data labeled as B.
- Refuted: dangling ContextWindowMeter imports; empty-window crash; percent overflow; stale closures/effect deps; draft orchestrate-flag migration; composite model-key delimiter; scoped usage filtering as data loss.

#### F6′ — mobile + changed-test coherence (completed; relaunch after broker restart)

- **F6-MOBILE-1 (P2/high):** `ThreadComposer.tsx:399-400, 535-543` + `threadReducer.ts:169-187` + `new-task-flow-provider.tsx:648-652` — reducer preserves `interactionMode` across provider-switched; mobile capability check only gates menus, so a cross-client switch (or stale draft) silently sends orchestrate to a non-supporting provider, which ClaudeAdapter maps to default mode silently.
- **F6-TEST-1 (P2/high):** `tests/apps/server/workers/WorkersStatusBroadcaster.test.ts:17-52` — suppression test never exercises an unchanged consecutive pair; removing `Stream.changesWith` would still pass.
- Refuted: switch-requested crashing mobile reducer (forward-compatible fallback); pendingHandoff dereference; usage snapshot corrupting mobile activity; decider/reactor/usage/cache tests as tautological; client-runtime workers test scope.

### Verification Wave Digest (V1–V5, gpt-5.6-sol:high)

Corrections and enrichments the verifiers added on top of the finder digests above — re-read these before implementing; they change the fixes.

- **F2-1 (V1, CONFIRMED P1):** caller catch (`ProviderCommandReactor.ts:1213-1224`) only logs `provider.switch.failed`; Cursor's `promptsInFlight` finalizer emits no terminal event. Fix must live in `sendTurnAndAwait`: on non-timeout failure with non-null `providerTurnId`, interrupt -> grace wait -> stopSession if no terminal event -> re-fail with original cause; SHARE this cleanup with the timeout path so they cannot drift.
- **O-001 (V1, CONFIRMED P2):** subtlety — `turn.aborted` sets a terminal state in the hidden waiter, so the timeout branch's `terminalState === null` stop-session guard is SKIPPED on abort; only the no-terminal timeout path self-repairs. Concrete abort emitter: OpenCode fresh-prompt failure (`OpenCodeAdapter.ts:1552-1582`) resets its own runtime to ready but the projection stays `running`. Fix: handle `turn.aborted` as lifecycle-closing (same correlation guard as `turn.completed`, project session ready + clear activeTurnId) BEFORE the hidden-event early return. Applies to visible turns too.
- **MODEL-CACHE (V1, promoted to CONFIRMED P2):** concrete trigger found — after A->B completes but before A's `session.exited` projects, `thread.runtime-mode.set` (dispatched by web before attachment prep settles, `ChatView.tsx:3515-3524`) reads cached A selection and reopens A; a failed attachment prevents the correcting turn.start. Fix: update `threadModelSelections[thread.id] = targetModelSelection` on every `switch.complete` dispatch (both branches, one helper). Keep the cache itself.
- **O-002 (V1, CONFIRMED P2):** decider has no `pendingHandoff` gate (`decider.ts:831-851`); UI banner is informational only. Fix shape: in the no-context branch carry forward `thread.pendingHandoff` (text + fromInstanceId + fromModel provenance) instead of `""`.
- **F4-001 (V2, CONFIRMED P2):** the effect DOES re-run on status arrival (`providerStatuses` is a dep) but the equality check on the already-advanced ref neutralizes it; also `composerDraft.activeProvider ?? threadProvider` keeps the stale draft winning. Fix: don't record a changed instance until the provider snapshot exists and `applyComposerModelSelection` ran.
- **F4-002 (V2, CONFIRMED, downgraded P3):** only reproduces with a stale non-null projected session. Fix: derive `expectedCurrentInstanceId` from `modelSelection.instanceId` (the decider's own authority).
- **F4-003 (V2, REFUTED):** decider expected-instance gate + single sequential reactor queue mean overlapping switches cannot corrupt state; second command rejects with toast or error activity. Optional UX only: keep pending indicator until `provider-switched`/`switch.failed` projects.
- **F4-004 (V3, CONFIRMED, downgraded P3):** guard-order confirmed (`ChatView.tsx:4714-4723` mode guard runs before `4759-4772` parse); even `/default` is then blocked (guard precedes parsing). Recoverable via mode control -> P3. Fix: parse standalone mode commands before the current-mode guard; always let `/default`//`/plan` escape.
- **F4-005 (V3, CONFIRMED, downgraded P3):** the runtime event DOES carry `providerInstanceId` (`providerRuntime.ts:248-255`) — ingestion discards it (`ProviderRuntimeIngestion.ts:603-612`). Fix: preserve instance id into `context-window.updated` activities and filter the meter's snapshot by selected instance.
- **F6-MOBILE-1 (V3, CONFIRMED P2):** asymmetry confirmed — web blocks the send, mobile sends silently (outbox snapshots stale mode, reactor forwards unchanged at `ProviderCommandReactor.ts:988-999`, ClaudeAdapter downgrades at `3853-3865`). One correction: mobile's local model-picker DOES reset orchestrate; only cross-client switch + stale draft paths are exposed. Recommended authoritative fix: enforce provider/mode compatibility in `ProviderCommandReactor` before `sendTurn` (visible failure, not silent downgrade) AND have switch completion project `interactionMode: "default"` when the target lacks orchestrate, so all clients converge.
- **WKR-001 (V4, CONFIRMED P2):** verified through the vendored Effect RPC encoder — an encode failure becomes a request defect + interrupt, terminating the activity subscription (not a skipped entry). Fix: `Number.isSafeInteger`.
- **WKR-002 (V4, CONFIRMED P3), F5-1 (V4, CONFIRMED P3):** boundary arithmetic and missing live `elapsedMs` derivation both confirmed against store normalization.
- **F6-TEST-1 (V4, CONFIRMED P3):** fix the fixture so reads 1-2 are identical and read 3 changes, still taking two emissions.
- **L2-06-FACT (V4, CONFIRMED P3, narrowed):** "always falls back" refuted — Codex slugs are runtime-discovered and `gpt-5.6-luna` may match. Confirmed: standard Claude catalog (`claude-sonnet-5`) never matches `sonnet`; standard Grok (`grok-build`) and Cursor fallback never match `grok-4.5-fast`. Capture live snapshots for runtime-discovered catalogs before changing defaults.
- **L4-PERF-01 (V5, CONFIRMED P2):** single worker confirmed at `ProviderCommandReactor.ts:1406-1419` + `DrainableWorker.ts:47-56`; 120s is an understatement (plus two 10s grace waits + unbounded stopSession). Fix must keep per-thread FIFO; do NOT just fork switches.
- **L4-PERF-02 (V5, UNVERIFIABLE):** mechanical round-trip real, materiality unestablished. **Dropped from action groups**; retained under Needs Measurement.
- **F2-2 (V5, CONFIRMED P2):** timeout result replaces the snapshot (`status: "error"`, auth unknown, no usage); registry merge preserves prior models but picker disables non-ready instances; 5-min retry cadence. Fix: short local timeout on `account/rateLimits/read` only, degrade to `accountUsage.status = "unavailable"`.

### Considered and Rejected

Refuted with evidence during fanout or verification (do not re-report):

- **F4-003 — overlapping provider switches corrupt state:** refuted (V2); decider expected-instance gate + sequential reactor queue; residual UX-only.
- **Hidden-event projection/checkpoint contamination; timeout leaving session running; user turn steering into compaction; stale accountUsage hydration; orchestrate mode sent raw to Codex** (F2).
- **Migration 040 replay gap; handoff JSON round-trip mismatch; switch detail-event omission; activity stream failures on missing files; unbounded activity parsing** (F3).
- **Switch-requested reducer omission (intentional no-op); switch payload drift; workers RPC drift; activity ordering/keys; shared trigger drift; transport-error swallowing** (F5).
- **Mobile reducer crash on new events (forward-compatible fallback); pendingHandoff dereference; usage snapshot corrupting mobile activity; changed decider/reactor/usage tests as tautological** (F6).
- **Dangling ContextWindowMeter refs; empty-window crash; percent overflow; stale closures in changed effects; draft orchestrate-flag migration loss; composite model-key delimiter collision** (F4).
- **Full-snapshot broadcast per tick; new unpaginated run lists; CheckpointReactor serialized awaits; unstable activity keys; duplicate thread-detail query on turn completion** (L4).
- **Workers activity presentation belongs in client-runtime (no mobile surface — intentional); broker normalizer as contract dup; merged provider probe tables; decider-vs-reactor validation as duplication** (L2).
- **ComposerUsageMeter vs ProviderUsage overlap; one-caller abstractions (ProviderSwitchPolicy, sendTurnAndAwait); `hasRecoverableSession` optionality; `WorkersActivitySnapshot.readAt` as dead** (L1).
- **L2-06 "always falls back":** narrowed by V4 — Codex/custom catalogs can match; only fixed/fallback catalogs are dead.

### Needs Measurement / Runtime Context

- **L4-PERF-02** — pending-handoff JSON round-trip on unrelated writes. Measure: projection lag correlated with non-null handoff during a streaming post-switch turn. Only then consider narrow SQL patch methods.
- **L4-M01** — activity stream per-tick reread/reparse/compare (256 KiB/200 entries/3s). Measure per-tick bytes, parse+compare wall time, frame bytes at empty/typical/max sizes.
- **L4-M02** — provider-status emissions vs composer/usage React commits (React Profiler correlation).
- **L4-M03** — `WorkersPanel.tsx:982` `jobs.find` per list emission at high job counts.
- **MODEL-CACHE race frequency** — statically concrete but runtime frequency unknown; the Group A fix removes it regardless.

### What's Not Worth Doing

- Deduplicating SQL column aliases / repeated `pendingHandoff: null` assignments (mechanical, per-query shapes).
- Shared helper for the 3-site `skill.name !== 'orchestrate'` presentation filter.
- Inlining `formatProviderUsagePercentLeft` / `tightestAccountWindow` (removes policy names and test seams).
- Merging Claude/Codex raw probe extraction or provider catalogs (intentionally provider-specific; only the normalized-window assembly consolidates — L2-05).
- Testing the ChatView failure-toast branch (whole-component harness cost), the broadcaster fs-watch path (brittle; polling fallback covered), and display/glue permutations.
- Rewriting the pre-existing model registry as part of this diff (do L2-06's narrow fix; contracts-to-shared migration is a separate decision).

### Integrated Action Groups

| Group | Theme                                 | Findings                                        | Risk    | Order | Status   | Key Benefit                                                  |
| ----- | ------------------------------------- | ----------------------------------------------- | ------- | ----- | -------- | ------------------------------------------------------------ |
| G     | Codex probe isolation                 | F2-2                                            | Low     | 1     | Proposed | Usage stall no longer kills provider status                  |
| H     | Workers activity + panel fixes        | WKR-001, WKR-002, F5-1, F6-TEST-1, L1-03, L1-04 | Low     | 1     | Proposed | Stream can't die on bad record; honest UI; valid test        |
| I     | Switch-policy model aliases           | L2-06                                           | Low     | 1     | Proposed | Compaction actually uses cheap models on Claude/Grok         |
| A     | Hidden-turn + lifecycle correctness   | F2-1 (P1), O-001, MODEL-CACHE, T5               | Med     | 2     | Proposed | Switch failure can no longer strand sessions/threads         |
| B     | Handoff preservation                  | O-002, L2-02, T3, T2                            | Low-Med | 3     | Proposed | Handoff survives consecutive switches; one projection helper |
| D     | Web switch-follow UI                  | F4-001, F4-002 (+optional F4-003 UX)            | Low     | 4     | Proposed | Composer reliably follows projection                         |
| E     | Interaction-mode capability invariant | F6-MOBILE-1, F4-004, L1-05, T1                  | Med     | 4     | Proposed | No silent wrong-mode turns on any client                     |
| F     | Usage identity                        | F4-005, L2-04                                   | Med     | 5     | Proposed | Meter never mixes providers; mobile-ready usage logic        |
| C     | Reactor concurrency                   | L4-PERF-01                                      | High    | 6     | Proposed | Switches stop blocking every thread                          |
| J     | Consolidation batch                   | L2-01, L2-03, L2-05, L1-01, L1-02, T4           | Med     | 6     | Proposed | One source of truth for dispatch/events/normalization        |

#### Group G: Codex probe isolation (Low)

**Files:** `apps/server/src/provider/Layers/CodexProvider.ts`. Local timeout on `account/rateLimits/read` only; degrade to `accountUsage.status: "unavailable"`; keep outer probe timeout. **Validation:** focused CodexProvider tests (stalled-usage fixture -> ready snapshot without usage).

#### Group H: Workers activity + panel (Low)

**Files:** `WorkerBrokerStore.ts` (safe-int check; newline-aware tail boundary), `WorkersPanel.tsx` (+`workersPanel.logic.ts` — row clock via `workerJobElapsedLabel`, reuse settled formatter), `WorkersStatusBroadcaster.ts` (reuse exported `isSafeJobId`), fix `WorkersStatusBroadcaster.test.ts` fixture per V4. **Validation:** `vp test run` on workers store/broadcaster/panel-logic tests; add malformed-sequence + boundary regression cases alongside the fixes.

#### Group I: Switch-policy model aliases (Low)

**Files:** `ProviderSwitchPolicy.ts` (+ a focused policy test). Resolve aliases to canonical catalog slugs (`claude-sonnet-5`; pick a real Grok/Cursor cheap model or keep-current explicitly); per V4, capture a live snapshot for runtime-discovered catalogs before pinning Codex/Cursor candidates. **Validation:** policy unit test over each standard/fallback catalog.

#### Group A: Hidden-turn + lifecycle correctness (Med) — contains the P1

**Files:** `HiddenTurnRegistry.ts` (shared failure/timeout cleanup path), `ProviderRuntimeIngestion.ts` (turn.aborted lifecycle-closing before hidden early-return), `ProviderCommandReactor.ts` (switch-complete helper updates `threadModelSelections`). **Must preserve:** queued-turn guard (`decider.ts:840-845`), compaction guard (`ProviderCommandReactor.ts:712-721`), timeout stop-session leak guard (`HiddenTurnRegistry.ts:232-243`). **Tests:** T5 (hidden-turn timeout/failure paths), plus an aborted-compaction lifecycle test. **Validation:** focused orchestration + provider test files.

#### Group B: Handoff preservation (Low-Med)

**Files:** `ProviderCommandReactor.ts` (no-context branch carries `thread.pendingHandoff` forward with provenance), then L2-02 extraction of the pending-handoff constructor into `packages/shared` used by projector, pipeline, reducer. **Tests:** T3 (ingestion clears handoff on visible completed turn), T2 (incremental vs bootstrap equivalence). Land the O-002 fix before the L2-02 refactor so the behavior change and the consolidation are separate diffs.

#### Group D: Web switch-follow UI (Low)

**Files:** `ChatView.tsx` (ref-advance ordering per V2; switch token from `modelSelection.instanceId`; optional pending-state until terminal switch event). Preserve the intentional no-optimistic-flip design. **Validation:** ChatView.logic tests + integrated browser pass (see Sequence).

#### Group E: Interaction-mode capability invariant (Med)

**Files:** `ProviderCommandReactor.ts` (reject incompatible mode before `sendTurn` — visible failure), switch completion projects `interactionMode: "default"` when target lacks orchestrate (contracts + projector + reducer + both clients' expectations), `ChatView.tsx` submit path (parse standalone mode commands before mode guard; `/default`//`/plan` always escape), shared `supportsOrchestrateMode` helper replacing 6 sites (L1-05). **Tests:** T1 (reducer switch events, incl. the new mode projection). Mobile needs no send-guard once the server enforces.

#### Group F: Usage identity (Med)

**Files:** `ProviderRuntimeIngestion.ts` (preserve `providerInstanceId` into `context-window.updated`), contracts activity payload, `ChatComposer.tsx` (filter snapshot by selected instance), then L2-04 move of pure usage derivations into `packages/client-runtime`. **Validation:** ProviderUsage/ComposerUsageMeter tests; note L4-M02 measurement if render cost is suspected.

#### Group C: Reactor concurrency (High — do late, alone)

**Files:** `ProviderCommandReactor.ts`, `packages/shared/DrainableWorker.ts` (or a keyed-worker wrapper). Per-thread keyed workers or forked switch behind a per-thread lock; per V5 do NOT fork without same-thread serialization. **Must preserve:** FIFO per thread, all Group A guard behavior. **Validation:** reactor tests incl. a two-thread interleaving test; consider landing after A/B have soaked.

#### Group J: Consolidation batch (Med)

L2-01 (switch dispatch -> client-runtime command layer), L2-03 (shared thread-detail event predicate), L2-05 (server usage-window normalizer), L1-01, L1-02, T4 (migration 040 test — independent, can also ride any earlier group). Each is independent; propose as separate small diffs.

### Recommended Implementation Sequence

#### Phase 1: Independent low-risk fixes (Low)

**Groups:** G, H, I — no shared files with each other or later phases. **Gate:** focused `vp test run` per group. **Done when:** all three groups' focused tests pass.

#### Phase 2: Server switch lifecycle (Med)

**Groups:** A then B (same reactor file — sequence, don't parallelize). **Gate:** focused orchestration/provider tests incl. T5, T3, T2. **Done when:** aborted/failed compaction leaves session recoverable and handoff survives consecutive switches.

#### Phase 3: Client mode + follow correctness (Med)

**Groups:** E then D (E changes what D's projection carries). **Gate:** T1 + ChatView.logic tests; then ONE integrated browser pass via `test-t3-app` covering: switch A->B mid-thread, composer follows, `/orchestrate` on non-supporting provider, switch-failure toast. Mobile spot-check via `test-t3-mobile` only if the mode-projection change lands (cross-client convergence).

#### Phase 4: Usage identity (Med)

**Group:** F. **Gate:** usage component tests; meter shows no context data until the new provider reports.

#### Phase 5: Concurrency + consolidation (High/Med)

**Groups:** C (alone, after soak), then J piecemeal. **Gate:** reactor interleaving test; repo-focused typecheck.

### Verification Performed

- Orchestrate run `megacore-diff-r7q2`, base `760953e1d` (temp commit of the working tree; soft-reset after run). 18 workers total: 13 fanout (10 planned + 3 relaunches after a broker restart killed F1/F4/F6 mid-run at 20:45:51Z) + 5 verifiers. 15/15 usable completions, 0 scope violations, 0 model failures.
- Fanout: codex `gpt-5.6-luna:max` (user-gated). Verify: codex `gpt-5.6-sol:high` (user-gated). All read-only; no tests or formatters run.
- Every bug/perf candidate received an adversarial refute-first verdict (V1–V5); verdicts and corrections recorded above. Full worker artifacts: `~/.local/state/worker-broker/jobs/<job-id>/`.

### Not Run / Limitations

- Security lens deliberately not run (mega-review-core profile). No incidental security concerns were raised by any worker.
- No test suites, profiling, or browser verification executed (read-only contracts). Perf claims beyond L4-PERF-01/F2-2 remain in Needs Measurement.
- Runtime-discovered provider catalogs (Codex `model/list`, Cursor discovered models) could not be checked statically — capture live snapshots before Group I pins candidates.
- Prior settled ledgers trusted as-is: provider-switch review-fix ledger, deferred residual risks (late-event epoch fencing; hidden-approval auto-deny; in-memory switch dedup), whole-repo refuted claims (`dev-docs/mega-review-core-2026-07-31.md`).
- Deviations from approved plan: 3 fanout workers relaunched after a broker restart (13 fanout launches vs 10 planned); verify stage ran 5 workers (cap was 6) to stay within the 18-worker budget.
- **Unreviewed concurrent edits:** while the run was in flight, a separate workstream edited ~18 files in this checkout (collaboration-mode instructions: new `CollaborationModeInstructions.ts`, trimmed `CodexDeveloperInstructions.ts`, plus `ClaudeProvider`, `ProviderService` (+test), `ChatComposer`, `CompactComposerControlsMenu`, `ClaudeCapabilitiesProbe.test.ts`, `contracts/server.ts`, `index.css`, mobile thread files; mtimes 16:21–17:24 local). This audit reviewed the 20:21Z snapshot (`760953e1d`) and does NOT cover those edits. Re-resolve file:line anchors by symbol before implementing — Groups E and G touch affected files.
