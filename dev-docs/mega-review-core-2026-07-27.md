<!-- dev-docs/mega-review-core-2026-07-27.md -->
<!-- whole-codebase five-lens review ledger and approval-gated action plan -->

# Mega Review Core (456code)

**Last Updated:** 2026-07-27 21:48:55 EDT
**Audit File:** `dev-docs/mega-review-core-2026-07-27.md`
**Lifecycle Status:** Ready for Approval
**Scope:** Entire codebase at `e599e363870fc22fc652c0c12bfc0665ab0b1b80` on `codex/t3-nightly-20260727-sync`, including the tracked/untracked working tree frozen at 2026-07-27 21:48:55 EDT
**Worktree Snapshot:** 42 tracked modifications, 43 untracked files, no staged changes; the audit document is one of the untracked files
**Codebase Size:** 2,175 source/build-script files and 607,966 lines (1,542 non-test files / 425,832 lines; 633 test files / 182,134 lines); generated output, installed dependencies, and read-only vendored repositories are excluded
**Lenses run:** bug-hunt, simplification, consolidation, test-gaps, performance
**Security:** Out of scope by design; use a separate security-remediation pass when needed.
**Mode:** Read-only review and proposed implementation plan
**Effort:** Exhaustive; independent lens tracks, module/domain sweeps, adversarial verification, and a final completeness pass

## Executive Summary

Review and adversarial verification are complete. Fifteen current findings have
concrete interleavings, runtime reproductions, exact input/output counterexamples, or measured
performance evidence. The highest-impact roots are provider response routing and streaming
cadence, settings/secret commit atomicity, SSH creator/shared-runtime ownership, preview recording
cleanup, and editor/mobile-draft persistence ordering. Lower-impact survivors cover rotated HTTP
credentials, restricted browser storage, prompt-stash fallback semantics, SemVer parsing, and
redundant process-table sampling, plus a compressed Cartographer proxy representation mismatch in
the frozen worktree.

The uncommitted MDX / proposal / Cartographer implementation changed during this review.
Frozen-start observations and final-live findings are tracked separately. Proposal type-change,
Cartographer cleanup, proposal RPC/migration wiring, and retained-ref transaction candidates were
repaired during the review and are retained as resolved evidence, not current findings. The
final-live focused server typecheck and the new Cartographer/proposal tests now pass.

## Approach

- Repository conventions, architecture docs, package manifests, the active implementation plan, Git baseline, and complete live working-tree inventory are read before findings are synthesized.
- The five required lenses run independently over the whole codebase; security analysis and external attack/probe activity remain excluded.
- Candidate findings require a concrete trigger or trace and live-code evidence. Every survivor is re-checked against guards, caller invariants, tests, and cross-layer contracts.
- One root cause becomes one finding tagged with every relevant lens. Refuted, stale, unverifiable, and deliberately low-value claims remain recorded rather than disappearing.
- This file is the only review and action-group artifact. No product-code remediation occurs without explicit approval.

## Architecture Snapshot

- `apps/server` owns the Node WebSocket/HTTP server, provider runtimes, orchestration, persistence,
  remote environments, workspace access, and the React web bundle.
- `apps/web`, `apps/mobile`, and `apps/desktop` are the three client surfaces. Web is also embedded
  by desktop; mobile and web share environment/RPC state through `packages/client-runtime`.
- `packages/contracts` is the schema-only protocol boundary. `packages/shared` is cross-runtime
  implementation code with explicit subpath exports. `packages/ssh` and `packages/tailscale` own
  remote connectivity.
- `packages/effect-acp` and `packages/effect-codex-app-server` adapt external provider protocols.
  They feed the server provider layer, which normalizes events into the orchestration read model
  consumed through shared contracts and client-runtime atoms.
- All 633 test files live under the repository-root `tests/` mirror. `.repos/` contains 3,438
  tracked vendored-reference files and is read-only/excluded from review findings except when used
  to validate an upstream contract.

Dependency direction at the main workspace boundary is:

`contracts -> shared -> client-runtime -> web/mobile/desktop`, while `server` depends on
`contracts`, `shared`, `tailscale`, and the web build. `ssh` depends only on `contracts` and
`shared`.

## Finding Index

| ID   | Status                 | Lenses                              | Severity | Likelihood | Confidence | Summary                                                                                                                 |
| ---- | ---------------------- | ----------------------------------- | -------- | ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| F-01 | verified               | bug-hunt, architecture, test-gap    | high     | high       | high       | Pending Codex/ACP inbound handlers block routing of later client responses                                              |
| F-02 | verified               | bug-hunt, test-gap                  | high     | medium     | high       | Disconnect does not cancel the SSH tunnel creator and can publish a late tunnel                                         |
| F-03 | verified               | bug-hunt, consolidation, test-gap   | low      | low        | high       | Non-durable prompt stash writes leave both the composer and an in-memory stash copy                                     |
| F-04 | verified               | bug-hunt, architecture, test-gap    | high     | low        | high       | A rejected settings update can leave provider secrets mutated or deleted                                                |
| F-05 | verified               | bug-hunt, performance, test-gap     | high     | medium     | high       | Closing a preview during recording leaks recorder state and blocks later recordings                                     |
| F-06 | verified (worktree)    | bug-hunt, simplification, test-gap  | high     | medium     | high       | File-editor disposal replays an already successful save and can overwrite newer contents                                |
| F-07 | verified               | bug-hunt, architecture, test-gap    | high     | medium     | high       | Mobile draft persistence can erase hydrated drafts or resurrect cleared ones                                            |
| F-08 | verified               | bug-hunt, architecture, test-gap    | medium   | medium     | high       | Rotated secondary bearer credentials do not reach the retained HTTP snapshot client                                     |
| F-09 | verified               | bug-hunt, consolidation, test-gap   | medium   | low        | high       | Throwing `localStorage` access crashes composer-store initialization                                                    |
| F-10 | verified               | bug-hunt, architecture, test-gap    | high     | low        | high       | SSH aliases can share one remote runtime while only one alias owns its lifetime                                         |
| F-11 | resolved during review | bug-hunt, performance, test-gap     | —        | —          | high       | Cartographer cleanup was repaired; core close-all ownership is regression-tested and other branches are source-verified |
| F-12 | resolved during review | bug-hunt, architecture, test-gap    | —        | —          | high       | Proposal Git type changes now fail explicitly and have a focused regression                                             |
| F-13 | verified               | bug-hunt, simplification, test-gap  | medium   | medium     | high       | Shared SemVer parsing truncates prereleases and mishandles build metadata                                               |
| F-14 | verified               | performance, architecture, test-gap | high     | high       | high       | Each streaming text delta repeats accumulated-message persistence, derivation, and Markdown parsing                     |
| F-15 | verified               | performance, simplification         | medium   | high       | high       | The always-on diagnostics sampler scans the full OS process table every five seconds                                    |
| F-16 | verified               | performance, consolidation          | medium   | high       | high       | Terminal activity discovery launches process-table commands independently per terminal each second                      |
| F-17 | verified (worktree)    | bug-hunt, architecture, test-gap    | medium   | medium     | high       | Cartographer proxies decoded gzip bytes while preserving the upstream gzip content encoding                             |

## Findings

### Bug-hunt

#### F-01 - Provider protocol readers deadlock behind pending server requests

- **Status:** Verified with a minimal in-memory protocol reproduction.
- **Trigger:** A provider sends an approval/user-input request whose handler waits on a
  `Deferred`; before the user answers, 456code sends another client request and the provider
  returns its response.
- **Evidence:** `packages/effect-codex-app-server/src/protocol.ts` runs every decoded line through
  the request/notification handler before it reads and routes the next line. The same sequencing
  appears in `packages/effect-acp/src/protocol.ts` for extension requests. Codex approval/input
  handlers and Cursor/Grok ACP extension-question handlers deliberately wait for user-controlled
  deferreds. The outgoing request also waits on a deferred that only the blocked reader can
  complete.
- **Observed behavior:** Two in-memory stdio reproductions produced the same result. A Codex
  `turn/interrupt` response placed after pending `item/tool/requestUserInput` did not resolve; an
  ACP extension response placed after a blocking extension question did not resolve. In each case,
  releasing the inbound handler emitted its response first and only then resolved the older
  outbound request.
- **Impact:** Stop/interrupt/read operations can hang precisely while an approval or question is
  pending; the response router has a head-of-line dependency on user action.
- **Direction:** Separate frame parsing/response correlation from application callbacks. Route
  responses immediately and run server-request handlers in scoped fibers with explicit
  cancellation; preserve notification ordering deliberately rather than through the reader loop.
- **Regression:** One focused test per distinct reader implementation must feed a blocking inbound
  request followed by a response to an outstanding client request and prove the client response
  resolves before the inbound handler is released.

#### F-02 - SSH disconnect can be undone by an in-flight tunnel creator

- **Status:** Verified by a deterministic end-to-end manager reproduction with fake process,
  HTTP, and network services.
- **Trigger:** `ensureEnvironment` is creating a tunnel while `disconnectEnvironment` targets the
  same resolved connection key.
- **Evidence:** `packages/ssh/src/tunnel.ts` stores only a `Deferred` in
  `pendingTunnelEntries`. Cancellation removes/fails that deferred but does not interrupt the
  creator fiber. The creator can continue through `createTunnelEntry`, insert the completed tunnel
  into `tunnels`, and return after disconnect has already stopped the then-visible remote server.
- **Impact:** A successful disconnect can leave a newly published local tunnel and restarted
  remote server alive, while waiters receive cancellation and UI state says disconnected.
- **Observed behavior:** The reproduction paused remote launch after the pending entry was
  installed. Disconnect returned after issuing one remote stop with no tunnel started. Releasing
  the creator then started and published a tunnel; no tunnel kill occurred and the original
  `ensureEnvironment` succeeded with a live local URL.
- **Direction:** Give the manager ownership of each creation fiber/generation. Disconnect should
  cancel and await the creator, and a late completion must compare its generation before
  publication and close its scope if it lost the race.
- **Regression:** Delay creation after the pending entry is installed, disconnect, release the
  delay, and prove no tunnel is published and all local/remote resources are closed.

#### F-03 - Failed durable stashing leaves a duplicate in the live stash

- **Status:** Verified with an isolated Vite SSR-module reproduction and the caller trace.
- **Trigger:** Browser `localStorage` is unavailable at module initialization, so the stash uses
  its in-memory fallback.
- **Evidence:** `apps/web/src/promptStashStore.ts` reports the fallback write as
  `{ written: true, durable: false }`, commits the queue to Zustand, and returns `durable: false`.
  `apps/web/src/components/chat/ChatComposer.tsx` then reports an error and deliberately retains
  the composer, assuming the store rolled the entry back.
- **Impact:** The same prompt is both editable in the composer and visible in the stash. Repeating
  the shortcut adds more copies; restoring one appends duplicate prompt text.
- **Observed behavior:** With `localStorage` undefined, `stashEntry` returned
  `{ evicted: null, durable: false }` while the unscoped queue contained the new prompt. The caller
  takes its failure branch and does not clear the draft.
- **Direction:** Treat non-durable creation as a rejected stash and do not publish it to the live
  queue, or explicitly support session-only stashing with a distinct success state and composer
  behavior. The current error path should not mutate either side.
- **Regression:** Initialize the module without usable durable storage, invoke the stash path, and
  prove both the composer and stash queue remain unchanged after the failure.

#### F-04 - Settings updates mutate secrets before the configuration commit

- **Status:** Verified with a local fault-injection reproduction.
- **Trigger:** A settings update removes or changes at least one sensitive provider environment
  value, that secret-store mutation succeeds, and a later secret mutation, normalization, or
  atomic settings-file write fails.
- **Evidence:** `apps/server/src/serverSettings.ts` performs every `set`/`remove` in
  `persistProviderEnvironmentSecrets` before `writeSettingsAtomically`. There is no snapshot,
  compensation, or commit boundary across those stores.
- **Observed behavior:** Starting with a persisted `codex_personal` secret, the reproduction made
  the settings directory read-only and removed the provider instance. The update returned
  `ServerSettingsError(operation="write-file")`, but the secret store was empty; cached settings
  still referenced the prior redacted value and subsequently materialized it as an empty string.
- **Impact:** A rejected update can irreversibly delete or overwrite credentials while the UI and
  settings file retain the old configuration. A failure partway through multiple secret
  operations similarly leaves only an arbitrary prefix applied.
- **Direction:** Prevalidate the complete next settings value, snapshot touched secret values,
  compensate mutations when a later step fails, and defer stale deletion until the settings
  commit. This needs a small bounded commit/rollback routine, not a new transaction framework.
- **Regression:** Fault-inject each secret and settings-file boundary after at least one successful
  mutation; assert the rejected update leaves both materialized settings and all prior secret
  values unchanged.

#### F-05 - Preview close bypasses recording cleanup

- **Status:** Verified by the complete web/desktop owner trace; this affects committed code.
- **Trigger:** Start browser recording, then close/remove/reset the active preview rather than
  invoking the explicit stop-recording command.
- **Evidence:** `apps/web/src/previewStateStore.ts:345` removes the session synchronously.
  `apps/web/src/browser/HostedBrowserWebview.tsx:63-72` stops only on a visibility transition while
  mounted; its unmount cleanup releases the desktop-tab lease without stopping the recorder.
  `apps/web/src/browser/browserRecording.ts:114-152,198-209,240-296,390-429` retains one global
  active recorder, frame subscription, canvas, and chunk array until an explicit stop/discard
  path clears them. Independently, `apps/desktop/src/preview/Manager.ts:1308-1335` closes the
  native tab without consulting `recordingTabIdRef`, which is set/cleared only at lines
  1817-1837.
- **Impact:** The invisible recorder remains latched and can continue retaining chunks and its
  frame subscription; subsequent recording attempts fail as conflicts. The desktop manager can
  also retain a recording tab ID whose tab no longer exists.
- **Direction:** Put idempotent recording disposal in the tab/session close owner before the
  webview lease is released. Desktop close must best-effort stop the screencast and clear the
  latch in `finally`; unmount should discard the renderer recording even if native stop fails.
- **Regression:** Start recording, close the session, and prove recorder/subscription/chunks and
  both latches are clear; then start recording in another tab. Existing recording and tab-lifetime
  tests never compose those operations.

#### F-06 - File-editor disposal replays a clean revision

- **Status:** Verified in the uncommitted file-preview work with an isolated coordinator
  reproduction.
- **Trigger:** An edit is saved successfully by the debounce timer, another actor changes the file,
  and the editor unmounts because the file, mode, theme, or preview session changes.
- **Evidence:** `apps/web/src/components/files/fileSaveCoordinator.ts:43-104` tracks the latest
  revision but not the last successfully persisted revision. `dispose()` calls `persistLatest()`
  whenever any edit ever occurred; a successful save clears pending UI state but leaves the same
  revision eligible for the cleanup write. `apps/web/src/components/files/FilePreviewPanel.tsx:
319-356` disposes the coordinator from effect cleanup.
- **Observed behavior:** A single edit produced `["old contents"]` after the debounce and
  `["old contents", "old contents"]` after disposal.
- **Impact:** In addition to redundant RPC/write work, the second write can silently overwrite
  newer external contents with the stale editor buffer after the UI already reported success.
- **Direction:** Track `lastPersistedRevision` (or a dirty flag) and flush on disposal only when a
  newer revision remains. Preserve the current retry behavior after a failed save.
- **Regression:** Cover dispose after successful save, dispose after failed save, and disposal
  with a newer revision arriving during an in-flight save. Current coordinator tests cover
  debounce/in-flight/failure paths but not the clean-dispose boundary.

#### F-07 - Mobile draft persistence is not serialized with hydration and clearing

- **Status:** Verified with a deferred-filesystem reproduction.
- **Trigger:** The user types within the persistence window while initial draft-file loading is
  delayed, or an environment is cleared while a queued full-snapshot save is running.
- **Evidence:** `apps/mobile/src/state/use-composer-drafts.ts:104-259` owns separate hydration,
  timer, and write-queue state. Ordinary setters schedule a full current-memory snapshot before
  `ensureComposerDraftsLoaded` completes; the eventual merge does not schedule a reconciled write.
  Import/restore deliberately await hydration at lines 473-526, showing the missing gate on
  ordinary setters. Environment cleanup at lines 558-575 writes outside `persistenceQueue`.
- **Observed behavior:** With durable `env:old-thread` held behind a deferred read, typing
  `env:new-thread` caused the first durable write to contain only the new thread. Hydration later
  merged both into memory but issued no second write, so the old draft disappeared on restart.
- **Impact:** Editing one thread can delete unrelated persisted drafts. A clear racing an older
  queued save can also resurrect drafts for a removed environment.
- **Direction:** Give hydration, scheduled saves, imports/restores, and environment clear one
  serialization owner. A save must await hydration and snapshot the latest atom state when it
  executes, not when it is scheduled.
- **Regression:** Gate the initial read, mutate immediately, and assert the durable union; also
  prove an in-flight save cannot resurrect data after environment clearing.

#### F-08 - Bearer rotation leaves the prepared HTTP client stale

- **Status:** Verified by tracing the platform refresh through connection registration and both
  HTTP snapshot callers.
- **Trigger:** A desktop-secondary bearer token rotates while its WebSocket/runtime registration
  otherwise remains equivalent.
- **Evidence:** `apps/web/src/connection/platform.ts:302-530` receives and re-registers refreshed
  credentials. `packages/client-runtime/src/connection/registry.ts:363-375,411-463` updates the
  credential store but retains an `Equal` catalog/runtime entry. The catalog entry produced by
  `packages/client-runtime/src/connection/catalog.ts:113-135` contains target/profile but no
  credential. `packages/client-runtime/src/connection/resolver.ts:89-135` reads the token only
  while preparing the runtime, and `state/shellSnapshotHttp.ts:32-44` plus
  `state/threadSnapshotHttp.ts:37-52` continue attaching that captured authorization.
- **Impact:** After the old token expires, HTTP shell/thread snapshots repeatedly fail until a
  WebSocket reconnect happens to rebuild the runtime. WebSocket fallback prevents a total outage,
  but adds failed requests and degrades the normal snapshot path.
- **Direction:** Either include credential revision in runtime equivalence or resolve the current
  authorization at request time. Preserve runtime retention only for truly identical
  registrations.
- **Regression:** Re-register the same target/profile with a new bearer credential and assert the
  next HTTP request uses it; an exactly identical registration should still retain its runtime.

#### F-09 - Composer storage acquisition can throw before fallback exists

- **Status:** Verified with an isolated module import whose `localStorage` getter throws.
- **Trigger:** The chat UI loads in a browser/sandbox context where reading
  `window.localStorage` throws instead of returning a storage object.
- **Evidence:** `apps/web/src/composerDraftStore.ts:71-74` directly evaluates `localStorage` in
  its fallback conditional. By contrast, `apps/web/src/promptStashStore.ts:104-116`,
  `uiStateStore.ts:141`, and `components/settings/SettingsPanels.logic.ts:25` already catch
  storage acquisition failures.
- **Observed behavior:** The throwing-getter import failed at composer-store initialization before
  prompt stash or any memory fallback could initialize.
- **Impact:** The chat composer can fail to load rather than degrade to non-durable storage.
- **Direction:** Reuse one guarded storage acquisition primitive that handles both property access
  and storage-operation failures and carries explicit durability metadata. This should be a small
  shared web helper, not a storage subsystem rewrite.
- **Regression:** Initialize the composer stores with a throwing getter and prove the returned
  in-memory store remains usable.

#### F-10 - SSH connection identity and remote-runtime ownership disagree

- **Status:** Verified with a deterministic two-alias manager reproduction; distinct from F-02.
- **Trigger:** Two SSH aliases resolve to the same user/host and shared `$HOME/.456code` runtime.
  One alias started that runtime; the second connected while it was already alive.
- **Evidence:** `packages/ssh/src/command.ts:72-80` includes the user-supplied alias in local
  connection/state identity. `packages/ssh/src/tunnel.ts:438-576` uses the same remote runtime
  directory and port for both aliases. The second entry records the shared runtime as external,
  while the first entry's finalizer at lines 1360-1399 unconditionally runs the stop script at
  lines 606-623.
- **Observed behavior:** Both aliases reached the same remote port through different local ports.
  Disconnecting alias A stopped the shared remote process and killed only A's tunnel; alias B's
  published entry/tunnel remained but pointed at a dead server.
- **Impact:** Disconnecting one apparently independent environment breaks another live
  environment and leaves its state falsely connected.
- **Direction:** Separate alias-local tunnel identity from resolved remote-runtime identity. Lease
  a managed remote runtime by resolved user/host/runtime path and stop it only after its last user
  releases it.
- **Regression:** Resolve two aliases to one host, connect both, disconnect the managed owner, and
  prove the runtime survives until the second alias releases its lease.

#### F-13 - SemVer normalization drops valid precedence information

- **Status:** Verified with direct helper counterexamples in committed shared code.
- **Trigger:** Provider/update versions contain a prerelease with a hyphen or SemVer build
  metadata.
- **Evidence:** `packages/shared/src/semver.ts:10-29` calls `.split("-", 2)`, which discards
  everything after the second hyphen; it never separates `+build`. Failed parses fall back to
  lexical comparison at lines 92-97. The helper feeds provider version gates and maintenance
  decisions.
- **Observed behavior:** `1.2.3-alpha-beta` normalizes to `1.2.3-alpha`; both
  `alpha-beta` and `alpha-zeta` compare equal to `alpha`; `1.2.3+build.5` fails parsing even though
  build metadata must not affect precedence.
- **Impact:** Version gates can collapse distinct prereleases or order build-only variants
  lexically, choosing the wrong maintenance/update decision.
- **Direction:** Split prerelease at the first `-`, strip/parse `+build`, validate identifiers, and
  compare only SemVer precedence fields. A focused helper correction is enough.
- **Regression:** Add the counterexamples above plus equality for versions differing only in build
  metadata; existing tests cover only a single ordinary prerelease identifier.

#### F-17 - Cartographer proxy preserves stale compression metadata

- **Status:** Verified in the final frozen uncommitted Cartographer HTTP path with a local compressed
  response reproduction.
- **Trigger:** The Cartographer upstream returns a gzip-encoded asset through Node's standards-based
  `fetch`.
- **Evidence:** `apps/server/src/cartographer/CartographerHttp.ts:80-100` forwards the upstream
  `content-encoding` header. Node `fetch` transparently decodes the body before
  `readResponseBodyWithinLimit` and `HttpServerResponse.uint8Array` return it at lines 163-192.
- **Observed behavior:** A 38-byte gzip payload became 18 decoded response bytes while the headers
  still declared `content-encoding: gzip`. Effect corrected `content-length` to the decoded length
  but preserved the stale encoding.
- **Impact:** A downstream browser/client can try to decompress already decoded bytes, failing the
  Cartographer asset request and breaking the embedded view for compressed upstream responses.
- **Direction:** Do not forward `content-encoding` when proxying a body that Node has decoded. Keep
  the existing decoded-body byte bound; no new proxy abstraction is needed.
- **Regression:** Exercise the actual proxy route with a compressed upstream asset and assert that
  downstream bytes and compression headers describe the same representation. The current
  `tests/apps/server/cartographer/CartographerHttp.test.ts:21-45` covers only stream-size bounds.

### Resolved During Review

#### F-11 - Cartographer resource cleanup

The first live snapshot eagerly captured an empty `sessions` map for `closeAll`, skipped
`SIGKILL` after merely sending `SIGTERM`, and did not remove artifact roots. Concurrent worktree
edits replaced that lifecycle before finalization:

- `CartographerEmbedBroker.ts:247-284` now waits for exit, escalates after a bounded delay, and
  still bounds shutdown if the platform never reports exit.
- `CartographerEmbedBroker.ts:294-307` owns one idempotent disposal promise and removes the
  artifact root after child shutdown.
- `CartographerEmbedBroker.ts:319-321` suspends session enumeration until `closeAll` executes;
  spawn/handshake failures clean resources at lines 415-431.
- `tests/apps/server/cartographer/CartographerEmbedBroker.test.ts:216-244` creates a later session,
  invokes `closeAll`, and asserts child/artifact/session cleanup. That focused live test passed;
  TERM escalation and handshake cleanup were source-verified rather than separately exercised.

No current action remains. Separate real-process handshake/TERM variants are deliberately not
requested because the important disposal owner and late-session enumeration are now covered.

#### F-12 - Proposal Git type-change manifest

The first proposal snapshot silently skipped Git `T` records, demonstrated by a disposable
regular-file -> symlink repository. Final-live code now treats `T` as a modified path so the
existing tree-mode validation rejects unsupported entry modes, collects other unknown statuses,
and fails explicitly at `ProposalGitEngine.ts:286-325,776-782,814-824`.
`tests/apps/server/proposal/ProposalService.test.ts:356-384` exercises the retained-tree type
change and expects rejection. The focused live test passed.

#### Other moving-worktree repairs

- The frozen-start server typecheck exposed missing proposal/Cartographer RPC handlers and
  unregistered proposal migrations 038/039. Concurrent edits added the handlers/services and
  registered both migrations; the final focused server typecheck passes.
- The first proposal implementation updated two retained refs sequentially. Final-live
  `ProposalGitEngine.ts:985` uses one `git update-ref --stdin` transaction, eliminating the
  partial-ref candidate.
- A transient MDX syntax error observed during an intermediate typecheck was repaired before the
  final-live gate and is not treated as a defect.
- Later graph-path exact-optional and proposal-service syntax failures were observed while those
  files were actively rewritten. The next stable snapshot passed the focused server typecheck, so
  neither intermediate compiler result is promoted.

### Simplification

Five bounded simplifications survived caller/test/refutation analysis. The first three overlap the
architecture targets below and should be done once, not as separate refactors.

| ID          | Recommendation                           | Evidence and bounded change                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Risk / effort             |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| S-01 / C-02 | Centralize work-log extraction           | Command extraction is behavior-identical in `apps/web/src/session-logic.ts:906-1087` and `apps/mobile/src/lib/threadActivity.ts:621-802`; capped changed-file traversal repeats in server/web/mobile at `ActivityPayloadProjection.ts:23-83`, `session-logic.ts:1244-1305`, and `threadActivity.ts:867-928`. Add two precise exports to `packages/shared/src/toolActivity.ts`; do not merge the surrounding reducers or the semantically different imported-session compactor. | low-medium / medium       |
| S-02 / C-05 | Replace provider-local identity wrappers | The five driver wrappers at `CodexDriver.ts:85-105`, `ClaudeDriver.ts:92-106`, `OpenCodeDriver.ts:93-107`, `CursorDriver.ts:83-99`, and `GrokDriver.ts:66-82` can call one helper in `providerSnapshot.ts`. Do not create a driver factory.                                                                                                                                                                                                                                    | low / small               |
| S-03 / C-01 | Extract import normalization primitives  | The provider-agnostic first 100-ish lines of the Claude/Codex/OpenCode parsers repeat limits, warnings, metadata bounds, timestamp policy, and omission text. Share only exact policy beside `resourceLimits.ts`; whitespace, collection budgets, native formats, tool mapping, and parser algorithms stay local.                                                                                                                                                              | low-medium / medium       |
| S-04        | Use one composer image signature         | `composerDraftStore.ts:630-634` and `ChatComposer.tsx:1993-2007` encode the same `mimeType + NUL + sizeBytes + NUL + name` identity. Export one pure helper and directly filter fallback persisted attachments at `ChatComposer.tsx:1513-1524`; keep the snapshot in-flight key local because it has different semantics.                                                                                                                                                      | low / small               |
| S-05        | Delete exact unused leaves               | Whole-repo references found only definitions for `GlassSafeAreaView.tsx`, one `ComposerToolbarTrigger` constant, `normalizeAgentAwarenessRelayBaseUrl`, and four text-generation/provider-status declarations. Remove only this inert list and newly unused imports. `unregisterAllAgentAwarenessConnections` is also unreferenced but owns subscriptions/retry cleanup; confirm lifecycle intent rather than deleting it.                                                     | low to low-medium / small |

One worthwhile simplification is deliberately deferred: web/mobile breadcrumb building is
identical in `apps/web/src/components/files/filePath.ts:1-17` and
`apps/mobile/src/features/files/filePath.ts:6-10,106-116`, with a natural owner in
`packages/shared/src/filePreview.ts`. That owner is part of the active MDX worktree and the
duplication is only about 16 lines, so combining it with this review would add collision and noise
for little benefit.

Rejected simplification directions:

- Do not unify composer, stash, panel, terminal, and generic local-storage stacks; their durability,
  debounce, fallback, and error contracts materially differ. F-03/F-09 need explicit fixes, not a
  generic persistence layer.
- Do not merge duration formatters, web/mobile connection runtimes, native composer variants, or
  full review-comment/patch flows; small textual overlap hides different semantics.
- Do not extract the repeated React-hook test harnesses; `vi.hoisted` timing and supported hooks
  differ, so the abstraction is more complex than the copies.
- Do not migrate deprecated test aliases or split large cohesive stateful files merely to reduce
  line counts.
- Do not treat proposal scheduling or storage failures as simplification work; those are
  correctness/lifecycle decisions.

### Consolidation / Architecture

The package-level dependency direction is healthy: no application implementation is imported back
into `contracts`, `shared`, or `client-runtime`, and no generic provider/parser framework is
justified. The useful consolidation targets are narrow, pure invariants whose current copies sit
on consistency boundaries.

#### High-value consolidation

| ID   | Current copies                                                                                                                                                                                | Why it matters                                                                                         | Smallest safe owner                                                                                                               | Risk / effort      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| C-01 | Import record/warning/UTF-8/metadata/timestamp invariants in `claudeSessionParser.ts:87-139,512-556`, `codexRolloutParser.ts:81-133,1044-1088`, and `openCodeSessionParser.ts:64-120,431-444` | Resource and normalization fixes require three synchronized changes in untrusted session parsing       | A parser-shared primitive module beside `apps/server/src/import/resourceLimits.ts`; provider decoding and tool mapping stay local | medium / medium    |
| C-02 | Changed-file extraction in `ActivityPayloadProjection.ts:23-64`, `apps/web/src/session-logic.ts:1244`, and `apps/mobile/src/lib/threadActivity.ts:867`                                        | The server and both clients can derive different file sets if traversal keys, depth 4, or cap 12 drift | One pure explicit `@t3tools/shared` subpath                                                                                       | low-medium / small |
| C-03 | Session-status -> settled-turn mapping in `ProjectionPipeline.ts:85`, `projector.ts:54`, and `client-runtime/src/state/threadReducer.ts:537`                                                  | Durable projection, in-memory replay, and live client state must agree exactly                         | One exhaustive pure helper in shared orchestration timing                                                                         | low / small        |

`C-01` must not grow into a parser framework. `C-02` must not absorb
`packages/shared/src/toolActivity.ts:95`, which has intentionally different traversal keys,
path-likeness filtering, and an eight-item cap. `C-03` shares only the pure mapping, not the three
reducers.

#### Opportunistic consolidation

| ID           | Evidence                                                                                                                                                                                | Bounded direction                                                                                                                                    | Risk / effort       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| C-05         | Five provider drivers repeat nullable continuation identity stamping at `ClaudeDriver.ts:92`, `CodexDriver.ts:91`, `OpenCodeDriver.ts:93`, `CursorDriver.ts:83`, and `GrokDriver.ts:66` | One helper beside `providerSnapshot.ts:210`; no generic driver factory                                                                               | low / small         |
| C-06         | Seven persistence repositories repeat SQL-versus-schema error classification; canonical factories already live in `persistence/Errors.ts:75`                                            | Add explicit plain and correlation-aware mappers, preserving their distinct detail fields                                                            | low / small         |
| C-07         | `pathExpansion.ts:17` exists, but `SourceControlRepositoryService.ts:80`, `WorkspaceEntries.ts:100`, `WorkspacePaths.ts:124`, and `os-jank.ts:75` repeat home expansion                 | Extend the existing path primitive; keep explicit-home import variants as thin callers                                                               | low / small         |
| C-08         | ACP tool-kind lifecycle mapping repeats at `acpImport.ts:1563`, `AcpCoreRuntimeEvents.ts:47`, and `AcpRuntimeModel.ts:295`                                                              | Share only the pure mapping; keep approval/status/replay behavior local                                                                              | low / small         |
| C-04 (defer) | Web/mobile cache versions currently align; web uses branded IDs while mobile decodes raw strings                                                                                        | Revisit shared codecs only when the cache format next changes; doing it now would intentionally tighten mobile behavior without a demonstrated drift | low-medium / medium |

These are opportunistic because none has a demonstrated present divergence. Apply them only in
the same change that already touches the relevant invariant; a repository-wide abstraction
campaign would cost more than it saves.

#### Cleanup and boundary maintenance

| Item                                      | Evidence                                                                                                                                                                                                                                                                         | Decision                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Eleven statically unreachable app modules | Entry-point/import/export analysis found 822 lines with no inbound static/dynamic import, route, preload, or package export, including `mobile/.../GlassSafeAreaView.tsx`, `mobile/.../ThreadTerminalPanel.tsx`, `web/.../AuthSurfaceShell.tsx`, and four unused web UI wrappers | Delete only after confirming terminal/auth feature intent; do not wire dead code merely to make it reachable |
| Stale architecture/provider docs          | `docs/architecture/providers.md:8` and `overview.md:8` describe removed `wsTransport`/`NativeApi` ownership and Codex-only support; `builtInDrivers.ts:47` registers five drivers                                                                                                | Refresh as a documentation task, linking authoritative modules instead of duplicating inventories            |
| Undeclared mobile config dependency       | `apps/mobile/vite.config.ts:4` imports `vite-plus`, absent from `apps/mobile/package.json`                                                                                                                                                                                       | Add the direct dev dependency when package manifests next change; root hoisting currently masks it           |

The source-control lane also has four parallel normalized change-request adapters, so one internal
record/converter may be worthwhile. The stronger claim that GitHub currently chooses the wrong
"latest" request was refuted: `GitManager.findLatestPrForHeadContext` asks for `state: "all"`, and
that GitHub path already requests and preserves `updatedAt`. The lighter open-list and detail
summaries intentionally return `Option.none()` and their current callers do not order by it.

### Performance

#### F-14 - Streaming text repeats accumulated-document work on every delta

- **Status:** Verified through the final-live server/client trace, real projection-layer probe, and
  the exact web Markdown parser/plugin stack.
- **Trigger:** A provider streams an assistant response as many small text deltas.
- **Evidence:** `ProviderRuntimeIngestion.ts:1456-1500` dispatches each delta. Each dispatch reads,
  concatenates, and rewrites the full accumulated message at `ProjectionPipeline.ts:946-983` and
  advances nine projector cursors at lines 1607-1706. `client-runtime/src/state/threadReducer.ts:
226-260` maps the full message array and concatenates again, publishing every state at
  `state/threads.ts:182-219`. Web then rebuilds/sorts/passes the timeline
  (`session-logic.ts:1312-1346`, `MessagesTimeline.logic.ts:405-575`) and rescans/reparses the
  complete growing Markdown document (`ChatMarkdown.tsx:1269-1283,1552-1561`).
- **Measured behavior:** Exact-stack Markdown medians were 23.4 ms at 10 KB, 106.2 ms at 50 KB,
  and 239.9 ms at 100 KB. The live standalone projection probe scaled from 130 SQLite row changes
  for ten 32-byte deltas to 13,000 changes for 1,000 deltas / 32 KB final text. Its elapsed
  606.3 ms at 1,000 deltas overstates normal live time because it ran outside the engine's outer
  transaction; the 13 mutations per delta and full-string/document work are unaffected.
- **Impact:** Long streaming answers cause quadratic accumulated string/Markdown work, main-thread
  stalls, avoidable database writes, and projection load proportional to delta count rather than
  useful visible cadence.
- **Direction:** First coalesce streaming updates at a bounded cadence (measure around 50 ms) while
  preserving exact final text/order. Render inexpensive streaming text until settlement, then do
  one full Markdown parse. Only after measuring that change should projector routing be redesigned.
- **Gate:** Stream 100 deltas into a 50 KB response in the controlled web client and record render
  count, long tasks/frame loss, dispatch latency, SQL changes, and exact final-text equality.
  Measure mobile separately before applying the same rendering strategy there.

#### F-15 - Diagnostics history imposes an always-on process-table scan

- **Status:** Verified on the current macOS host with the exact command path.
- **Evidence:** `ProcessResourceMonitor.ts:20-22,281-309` samples forever every five seconds.
  POSIX sampling runs a full `ps -axo ...` at `ProcessDiagnostics.ts:31-33,340-419,476-479`,
  copies/trims history, and is always installed by `server.ts:331-340`. The retained history is
  consumed only through `ws.ts:2116-2123` by `DiagnosticsSettings.tsx:810-855`.
- **Measured behavior:** Twenty exact scans used 1.21 seconds wall / 1.15 seconds CPU total,
  approximately 57.5 ms CPU per five-second tick (1.15% of one core) before JavaScript parsing.
  Each returned roughly 273-281 KB and 1,333-1,338 rows on this host.
- **Impact:** Every idle server continuously spawns and parses a full process-table query for a
  settings panel that may never be opened.
- **Direction:** Keep only a low-resolution/default baseline, or activate five-second history while
  diagnostics is requested. Do not build a new diagnostics subsystem.
- **Gate:** Compare 60-second idle CPU and child-process count with the panel closed/open; preserve
  requested history windows and sampling-failure reporting. Windows is unmeasured and must not be
  claimed worse without a profile.

#### F-16 - Terminal activity polling repeats process snapshots per terminal

- **Status:** Verified on the current macOS host through exact subprocess microbenchmarks.
- **Evidence:** `apps/server/src/terminal/Manager.ts:77-81` polls every second. Each POSIX terminal
  runs `pgrep`, and an active child adds per-child `ps` plus a full `ps -eo pid,ppid` at lines
  697-840. All sessions run independently/unbounded at lines 2019-2115. Windows performs one full
  CIM process query per terminal at lines 623-694.
- **Measured behavior:** On this host, `pgrep` cost about 3.3 ms CPU, the full parent table about
  23 ms, and per-child lookup about 1.6 ms. One active-child terminal therefore costs roughly
  28 ms CPU each second; cost scales linearly with terminal count.
- **Impact:** Five or twenty active terminals spawn redundant OS commands and parse the same
  process table independently each tick.
- **Direction:** Take one platform process snapshot per tick, build the parent/child index once,
  and derive activity/port ownership for every terminal from it.
- **Gate:** Profile 1/5/20 idle and active terminals; require one process-table snapshot per tick,
  bounded concurrency, and unchanged labels/port ownership.

### Test gaps

The independent test audit recommends eleven cases across seven grouped behavior clusters. These are the
few regressions that distinguish the high-impact roots; they are not a general coverage-expansion
plan.

| Rank | Target and exact test                                                                                                                                                                                                                                                                          | Distinguishing assertion                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `tests/packages/effect-codex-app-server/protocol.test.ts` - `routes an outbound response while an earlier inbound request handler is pending`; `tests/packages/effect-acp/protocol.test.ts` - ACP-extension equivalent                                                                         | The unrelated outbound response resolves while the inbound handler is still blocked; release it only after proving liveness                              |
| 2    | `tests/apps/server/serverSettings.test.ts` - `keeps settings and provider secrets unchanged when an update commit fails`                                                                                                                                                                       | In a two-row fault table (second secret mutation; settings rename), raw JSON, materialized settings, and every prior secret remain byte/value equivalent |
| 3    | `tests/packages/ssh/tunnel.test.ts` - `disconnect cancels an in-flight tunnel creator before it can publish`; `keeps a shared remote runtime alive until the last resolved alias disconnects`                                                                                                  | No late tunnel survives the creator race; two aliases stop the shared remote exactly once, after the final lease                                         |
| 4    | New `tests/apps/mobile/state/use-composer-drafts.persistence.test.ts` - `merges a pre-hydration edit into the durable draft snapshot`; `environment clear wins over an older queued save`                                                                                                      | No incomplete pre-hydration snapshot is written, and an older queued save cannot resurrect a cleared environment                                         |
| 5    | `tests/apps/web/components/preview/closePreviewSession.test.ts` - `closing a recording preview discards renderer recording state before removing the session`; `tests/apps/desktop/preview/Manager.test.ts` - `closing the recording tab stops the screencast and releases the recording slot` | Close owns best-effort cleanup through failure, clears both latches/subscription/chunks, and a second tab can record                                     |
| 6    | `tests/apps/web/components/files/fileSaveCoordinator.test.ts` - `flushes only revisions that have not already been confirmed`                                                                                                                                                                  | Confirmed+dispose writes once; unsaved+dispose writes once; failed+dispose remains retryable                                                             |
| 7    | `tests/apps/server/cartographer/CartographerHttp.test.ts` - `does not preserve gzip encoding after decoding an upstream proxy body`                                                                                                                                                            | Proxied bytes are decoded exactly once and downstream compression metadata describes the emitted representation                                          |

The protocol tests should use `Deferred` to prove ordering, settings should use a recording
secret-store and deterministic filesystem fault rather than permissions, and SSH/mobile should
use the existing fake-service/queue patterns. Any new mock/import must be declared in
`tests/package.json`.

#### Deliberately Not Testing

- Cartographer `closeAll` and proposal type-change rejection were removed after final-live fixes
  added their distinguishing tests. Additional real-process handshake/TERM matrices would
  duplicate the now-shared disposal invariant.
- The approved pruning plan already retained major import/continuation, stale interaction,
  checkpoint, resource-limit, migration, schema, and provider-entrypoint coverage; do not recreate
  deleted low-value matrices.
- F-03, F-08, F-09, and F-13 should each receive one narrow assertion in their existing suite if
  that fix is approved, but they rank below the six high-impact clusters above.
- No presentation snapshots, constant maps, trivial wrapper tests, exhaustive provider matrices,
  or generic coverage-percentage work.

## Needs Measurement / Runtime Context

| Candidate                                            | Why it remains unconfirmed                                                                                                                                                  | Required measurement                                                                                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mobile full Markdown/feed derivation per delta       | `ThreadFeed.tsx:859-960` passes the complete growing message; `threadActivity.ts:1350-1413` rebuilds/sorts the feed; the native parser could not run outside React Native   | iOS Simulator at 10/50/100 KB and 100 deltas at 20 Hz; Instruments JS-thread time, commits, frame drops, memory; compare 50 ms coalescing                    |
| Projection lookups/cursor fan-out per provider event | Runtime ingestion resolves shell/pending state before each dispatch and each dispatch advances nine cursors; F-14's standalone timing overstates live transaction time      | 1,000 real engine dispatches on temporary WAL DB with SQL trace, p50/p95, WAL growth, and event-loop delay; compare cached routing only after baseline       |
| Unbounded slow-consumer queues                       | Thread WebSocket delivery, Codex protocol queues, and orchestration commands use unbounded queues; domain events cannot safely be dropped without policy                    | Throttle WebSocket to 64 Kbit/s, inject 10,000 deltas, measure queue depth/RSS/event-loop delay/disconnect recovery; repeat with a stalled provider consumer |
| SSH/WSL complete-output retention                    | SSH string-folds all output and WSL collects both streams; production helpers usually emit little, so impact is unknown                                                     | Local and SSH producers at 5/50/500 MB; peak RSS, timeout cleanup, and diagnostic-tail fidelity                                                              |
| Explorer polling overlap                             | `ConnectedExplorerPanel.tsx:115-155` installs separate proposal/generation/detail polling; query-layer in-flight dedupe was not proven                                      | Add a controlled five-second server delay and record concurrent requests, post-navigation results, and render count; reject if the runner deduplicates       |
| Long-thread snapshot transport                       | `ProjectionSnapshotQuery` selects all persisted activities/messages and clients derive/sort them, but the two available databases peak at only 16 activities and 3 messages | Realistic long threads split by activity type; serialized bytes, SQL/parse time, client derivation, memory, and open-thread latency                          |

## Considered and Rejected

| Hypothesis                                                                    | Disposition                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation feeds render every child on every delta                          | Rejected: both clients virtualize/stabilize rows. That does not remove F-14's full derivation and Markdown work.                                                       |
| Port discovery, VCS status, or workspace search leaks one poller per consumer | Rejected: port ticks are no-ops with zero retainers; VCS polling is keyed/ref-counted with backoff; search indexes have scoped idle TTLs.                              |
| Shell/sidebar projections refetch once per raw delta                          | Rejected: aggregate streams coalesce over 50 ms with bounded refetch concurrency and replace large gaps with a snapshot.                                               |
| Thread cache encoding is part of F-14's streaming path                        | Rejected: persistence is deferred until the thread settles.                                                                                                            |
| ACP queues are unbounded like Codex                                           | Rejected: ACP request/outgoing queues are bounded and notifications use a sliding cap. Codex/orchestration/WebSocket queues remain measurement candidates.             |
| All subprocess helpers retain unlimited output                                | Rejected: core server and Git/VCS runners enforce byte limits. Only SSH/WSL helpers need measurement.                                                                  |
| GitHub drops timestamps and therefore chooses the wrong latest PR             | Rejected for the current call path: `state: "all"` explicitly requests/preserves `updatedAt`; lighter open/detail summaries are not used for ordering.                 |
| More import/continuation coverage is needed                                   | Rejected: the approved pruning audit retained the cross-provider parser, WebSocket/engine, ownership, continuation, migration, and projection regressions that matter. |
| Prompt stash must merge cross-tab writes                                      | Not promoted: last-write-wins is documented product behavior. F-03 is the separate single-tab failure/rollback contradiction.                                          |

## What's Not Worth Doing

- A generic provider driver, import parser, storage engine, client reducer, or source-control
  framework. The surviving commonality is limited to the narrow pure helpers identified above.
- A broad dead-code or export-modifier purge. Delete only proven leaves after confirming feature
  intent; do not wire abandoned code to justify keeping it.
- A new benchmark/dashboard subsystem. Each performance item has one bounded before/after gate
  using current tools.
- Exhaustive platform/provider test matrices, presentation snapshots, or recreating tests removed
  by the approved pruning plan.
- Consolidation mixed into the active MDX/proposal implementation. The breadcrumb move is
  explicitly deferred, and resolved WIP findings need no parallel rewrite.

## Integrated Action Groups

No action group is approved by this review. Each row is deliberately bounded so it can be
approved, rejected, or deferred independently.

| Group                                     | Scope                                                                                                                                                                                              | Required acceptance evidence                                                                                                                      | Risk / effort              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| AG-01 - Protocol liveness                 | F-01: decouple response correlation from blocking inbound handlers in Codex and ACP extension readers; preserve deliberate notification/request ordering and scoped cancellation                   | Two `Deferred` regressions prove an outbound response resolves before the earlier inbound handler; focused protocol suites/typechecks             | medium / medium            |
| AG-02 - SSH lifetime ownership            | F-02 and F-10: manager-owned creator cancellation/generation plus resolved-remote shared-runtime leases                                                                                            | Gate-race and two-alias tests; no late map entries/processes; exactly one final remote stop; focused SSH suite/typecheck                          | medium-high / medium       |
| AG-03 - Settings commit atomicity         | F-04: prevalidation, touched-secret snapshot/compensation, settings commit, deferred stale deletion                                                                                                | Deterministic secret/file fault table proves exact old JSON/materialized values/secrets after every rejection                                     | medium / medium            |
| AG-04 - Client persistence correctness    | F-03, F-06, F-07, F-09 as four package-local changes: reject non-durable stash mutation, track confirmed file revision, serialize mobile hydration/write/clear, guard composer storage acquisition | Existing focused suites plus the clean-dispose and two mobile ordering regressions; throwing-storage and non-durable assertions                   | medium / medium            |
| AG-05 - Client runtime lifecycle          | F-05 and F-08: recording disposal owned by preview close on renderer/desktop; credential rotation invalidates or dynamically refreshes prepared HTTP authorization                                 | Renderer+desktop close tests through failure; next tab records; re-registration sends the new bearer while identical registration retains runtime | medium / medium            |
| AG-06 - SemVer precedence                 | F-13: parse first prerelease separator, ignore build metadata for precedence, validate identifiers                                                                                                 | Focused helper/provider-version tests for hyphenated prereleases and build-only equality                                                          | low / small                |
| AG-07 - Cartographer proxy representation | F-17: stop forwarding gzip metadata after Node fetch has decoded the bounded upstream body                                                                                                         | Compressed-upstream route regression proves downstream bytes/header representation agree                                                          | low / small                |
| AG-08 - Measured performance repairs      | F-14 first: bounded stream coalescing and settlement-only full Markdown; F-15 demand-aware diagnostics history; F-16 one process snapshot per terminal tick                                        | Exact-text/ordering regression plus the before/after gates stated in each finding; no projector redesign until post-coalescing data               | medium-high / medium-large |
| AG-09 - Selected maintenance              | C-01 through C-03 and S-04/S-05 as separate semantic commits; refresh stale docs and declare mobile's direct config dependency. C-04 through C-08 only when their owner is already being touched   | Existing focused parser/activity/provider suites; reference scan plus lifecycle-intent check for deletions; no active MDX owner collision         | low-medium / medium        |

AG-04 and AG-09 are planning umbrellas, not mixed commits. Their subchanges share approval and
verification policy but should remain package/behavior-local in history.

## Recommended Implementation Sequence

1. **Restore liveness first:** AG-01. It can hang stop/read operations while user interaction is
   pending and has deterministic isolated regressions.
2. **Fix resource and durable-state ownership:** AG-02 and AG-03 can proceed independently; both
   prevent a successful/rejected control action from leaving contradictory external state.
3. **Repair client and active worktree correctness:** AG-04, AG-05, AG-07, then AG-06 in
   behavior-local commits. Run one
   integrated web/mobile pass only for the affected user-visible surfaces after integration.
4. **Measure and repair the proven hot paths:** AG-08, starting with stream cadence because it
   compounds server, database, and client work. Re-measure before changing projector architecture.
5. **Take maintenance selectively:** AG-09 after correctness/performance changes stabilize.
   Opportunistic helpers stay deferred until their natural owner changes.

## Verification Performed

### Scope and compile gates

- `git status --short --branch`, porcelain-v2/untracked inventory, diff/cached-diff stats, branch
  ancestry, and final-live modification times - froze the start state and distinguished concurrent
  worktree repairs; no staged changes.
- Repository/skill guidance read - `AGENTS.md`, linked `CLAUDE.md`, root/package manifests,
  architecture/operations/provider/runtime docs, client-runtime boundaries, active MDX/Cartographer
  plan, test-pruning plan, and all mega-review-core lens/template instructions.
- Final-live source inventory - 2,175 source/build-script files / 607,966 lines (1,542 non-test /
  425,832 lines; 633 tests / 182,134 lines). Installed/generated output and 3,438 read-only
  vendored `.repos` files are excluded.
- `npx vp run --filter @t3tools/contracts --filter @t3tools/shared --filter
@t3tools/client-runtime --filter @t3tools/web typecheck` - passed all four affected packages;
  client-runtime emitted one non-blocking suggestion.
- `npx vp run --filter 456code typecheck` - final-live server gate passed with six existing
  non-blocking Effect suggestions. Earlier proposal wiring and transient MDX failures are retained
  under Resolved During Review.

### Focused suites

- Five protocol/SSH/settings/SemVer files - 66 tests passed.
- Four recording/tab-lifetime/desktop-manager/connection-registry files - 45 tests passed.
- Three file-save/prompt-stash/mobile-draft files - 26 tests passed.
- Moving-worktree gates: seven Cartographer/proposal/Explorer files - 12 tests passed; frozen
  late-delta six-file Cartographer/proposal/thread-deletion/Explorer set - 15 tests passed.
- Eleven simplification-baseline parser/activity/composer/provider files - 227 tests passed.

`node scripts/mobile-native-static-check.ts` covered 9 Swift and 12 Kotlin files; SwiftLint,
ktlint, and detekt passed. The focused lint-plugin suite passed 26 tests.

### Runtime reproductions

- In-memory Codex and ACP protocol interleavings confirmed that an outstanding client response is
  not routed until the blocking inbound handler is released.
- Deterministic SSH manager reproductions - confirmed late publication after disconnect and
  confirmed one alias kills a shared remote runtime still leased by another.
- Provider-secret/settings fault injection - confirmed an atomic settings-file failure after a
  stale-secret deletion returns failure but does not restore the credential.
- Isolated module reproductions - confirmed prompt fallback mutation, throwing storage acquisition,
  clean file-save disposal replay, and mobile pre-hydration overwrite.
- Local compressed-response reproduction - confirmed Node decoded gzip bytes while retaining the
  upstream `content-encoding`, producing the F-17 representation mismatch.

### Performance probes

- Performance evidence - exact-stack Markdown parsing at 10/50/100 KB, real standalone projection
  mutation counts through 1,000 deltas, 20 exact diagnostics scans, and terminal process-command
  microbenchmarks on the current macOS host.
- Read-only local SQLite cardinality check - both available app databases peak at 16 activities
  and 3 messages per thread, insufficient to validate the long-thread performance candidate.

## Not Run / Limitations

- No product-code formatting, dependency changes, external probes, full-workspace gates, browser
  client run, simulator, Windows profile, or production-database benchmark was performed.
- Security review is intentionally excluded.
- Performance microbenchmarks are current-host evidence, not universal latency claims; the
  standalone projection elapsed time overstates the normal outer-transaction path as documented
  in F-14.
- The live worktree changed during the review. Only findings surviving the final-live recheck are
  current; repaired candidates and transient compile failures remain in the resolved ledger.
- Security, remediation, staging, committing, pushing, deploying, and release work remain outside
  this review's authorization.
