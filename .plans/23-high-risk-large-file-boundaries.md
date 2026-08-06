<!-- .plans/23-high-risk-large-file-boundaries.md -->
<!-- design approval boundaries for the largest stateful application files -->

# Plan: High-Risk Large-File Boundaries

## Status

Implementation checkpoint. Approval units 1 and 3-5 were completed on
2026-08-02. Approval unit 2 terminal / right-panel / interrupt / provider-switch
seams landed 2026-08-02; send/retry closed in Phase 3c (2026-08-06, uncommitted)
via `ChatSendPorts` on `useChatDispatchController`.

**Phase 3c ChatView send/retry (2026-08-06, uncommitted):** `runSend` /
`dispatchSend` / `onSend` moved into `useChatDispatchController` via typed
`ChatSendPorts` (explicit named fields; no React context). Live sizes:
`ChatView.tsx` **5759**, controller **1430**. Default `ChatView` export and
plan 23 stop conditions for identity / promotion / scroll / context were
honored. Integrated `test-t3-app` send/retry pass **deferred (AFK)**. Further
`ws.ts` assembly and ClaudeAdapter session/finalizer HOLDs remain binding.

This document supplies the dedicated designs required by Wave C of
`.plans/21-style-comments-and-structure-modernization.md`.

Baseline inspected on 2026-08-01:

- `apps/web/src/components/ChatView.tsx`: about 7,280 lines
- `apps/server/src/ws.ts`: about 3,280 lines
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`: about 4,590 lines

Line count only triggered review. Each extraction below is justified by an
existing state, lifecycle, side-effect, or contract boundary.

## Shared Invariants

- Preserve existing public exports and direct import paths through stable
  facades.
- Preserve ordering, cancellation, cleanup, and error behavior before reducing
  file size further.
- Keep Effect service and layer composition explicit. Do not introduce barrels
  or a generic handler framework.
- Move existing tests only when a source path moves. Do not expand the test
  suite without a separately approved focused test plan.
- Apply the repository formatter and comment contract to every new or moved
  file.

## ChatView

### Stable facade

Keep the default `ChatView` export in
`apps/web/src/components/ChatView.tsx`. It remains the route-facing boundary
and continues to install `DiffWorkerPoolProvider`. `ChatViewContent` remains
the active route/thread owner until its individual controllers have been
extracted and verified.

### State ownership

- Route identity, draft promotion, and the selected server thread remain owned
  by `ChatViewContent`.
- Composer content remains in `composerDraftStore`; an extracted controller may
  coordinate it but must not duplicate it in React state.
- Terminal layout remains in `terminalUiStateStore`; persistent terminal
  components consume that store through narrow selectors.
- Right-panel state remains in `rightPanelStore`; extracted panel code must not
  create a parallel open/selection model.
- Local refs that guard send, scroll-follow, blob URLs, and promotion races stay
  with the interaction that mutates them.

### Side-effect ownership

Use three vertical slices instead of one oversized `useChatView` hook:

1. Move `PersistentThreadTerminalDrawer`,
   `PersistentThreadTerminalPanel`, and terminal-id reconciliation helpers to
   `apps/web/src/components/chat/PersistentThreadTerminals.tsx`.
2. Move send, retry, interrupt, provider-switch, and draft-promotion effects to
   `apps/web/src/components/chat/useChatDispatchController.ts`. Its inputs are
   active thread/draft identities and existing atom commands; its output is a
   small set of actions and presentation state.
3. Move right-panel surface creation, activation, and close behavior to
   `apps/web/src/components/chat/useChatRightPanelController.ts`, retaining
   `rightPanelStore` as the only state owner.

Only after those slices settle should the remaining JSX shell move to a
presentational component. Do not replace the current file with a single hook
that merely relocates thousands of lines or pass a monolithic controller prop.

### Regression surface

- `tests/apps/web/components/ChatView.logic.test.ts`
- the existing composer-draft, session-logic, timeline, right-panel, terminal,
  and provider-selection focused suites
- one integrated web pass covering draft send/promotion, streaming follow,
  interrupt/retry, provider switch, terminal persistence, and right-panel
  open/close behavior

### Stop conditions

Stop and re-plan if an extraction requires a second source of thread identity,
changes draft promotion timing, changes focus/scroll behavior, or adds a broad
context solely to avoid explicit inputs.

### 2026-08-02 checkpoint: terminal slice complete

Approval unit 1 moved `PersistentThreadTerminalDrawer`,
`PersistentThreadTerminalPanel`, and their private terminal-id reconciliation
helpers to
`apps/web/src/components/chat/PersistentThreadTerminals.tsx`. `ChatView.tsx`
continues to own the route and thread boundary, while `terminalUiStateStore`
and `rightPanelStore` remain the only layout and panel state owners. The new
module exports only the two persistent terminal components. No tests or public
contracts changed.

The extraction removed about 600 lines from `ChatView.tsx`. A mechanical
comparison of the moved block, ignoring the two new export modifiers and blank
lines, found no implementation drift. Focused verification passed:

- Prettier, the repository comment check, and targeted lint for both touched
  source files
- 92 tests across `ChatView.logic`, `ThreadTerminalDrawer`,
  `rightPanelStore`, and `terminalUiStateStore`
- the `@t3tools/web` production build
- an integrated web pass proving the drawer terminal retained its buffer after
  close/reopen and a distinct right-panel terminal retained its own buffer
  after panel close/reopen

The package-wide web typecheck is not a green gate in the current checkout: it
continues to report unrelated `ImportMeta.env`, CSS/module-resolution,
`ComposerPendingApprovalPanel`, and Effect diagnostics. Neither touched source
file appeared in its diagnostic output. Independent read-only seam and final
patch reviews found no confirmed behavior or ownership regression. The edit
worker's environment-coupled verification failed before it could certify the
patch, so the patch was accepted only after full inspection and successful
central reproduction of the focused gates above.

### 2026-08-02 checkpoint: controller slices stopped at send coordination

Approval unit 2 added two bounded vertical slices without changing route or
store ownership:

- `useChatRightPanelController.ts` now coordinates right-panel surface
  creation, activation, close behavior, and preview/terminal cleanup while
  `rightPanelStore` remains the only panel-state owner.
- `useChatDispatchController.ts` now coordinates draft-error promotion,
  interruption, provider-switch confirmation and outcomes, and projected
  provider rebind synchronization.

`runSend` and its retry restoration path remain in `ChatView.tsx`. They mutate
the component's send, focus, scroll-follow, promotion-anchor, blob-URL,
optimistic-row, image, context, and docked-draft refs as one ordered
interaction. Moving them now would either change focus/scroll/promotion timing
or require a broad controller context, both explicit stop conditions in this
plan. This is a deliberate partial closeout, not a claim that approval unit 2
is fully extracted.

`ChatView.tsx` is about 6,130 lines after the terminal and controller work,
down from the approximately 7,280-line planning baseline. The two controllers
are separate 647-line and 597-line vertical slices. Focused verification
passed 244 existing web tests, targeted formatting/comment/lint checks, and
the `@t3tools/web` production build. An isolated integrated web pass proved
draft promotion through a completed send, right-panel Files open/close, and
terminal drawer open/close. Provider switching was not exercised in the
isolated environment because it exposed only one configured provider; the
existing focused provider-switch suites passed. The package typecheck retains
unrelated checkout-wide diagnostics and reported none in the touched files.

## WebSocket RPC Route

### Stable facade

Keep `websocketRpcRouteLayer` exported from `apps/server/src/ws.ts`. The file
continues to own WebSocket authentication, upgrade handling, and final
`WsRpcGroup` layer assembly.

### State ownership

- `AuthenticatedSession` remains the per-connection authorization identity.
- The RPC contract remains `WsRpcGroup`; handler modules must return typed
  fragments for that contract rather than redefine methods.
- Per-connection stream revisions remain local to the stream that emits them.
- Long-lived domain state stays in the existing services yielded by the layer;
  handler modules do not add caches or registries.

### Side-effect ownership

Extract in this order:

1. Move `RPC_REQUIRED_SCOPE`, authorization helpers, and access-stream event
   conversion to `apps/server/src/ws/rpcAuthorization.ts`.
2. Move handlers into explicit aggregate modules only where at least three
   methods already share the same service owner. Initial candidates are
   `orchestrationHandlers.ts`, `workspaceHandlers.ts`,
   `proposalHandlers.ts`, `vcsHandlers.ts`, and `previewHandlers.ts` under
   `apps/server/src/ws/handlers/`.
3. Keep small server, auth, and cloud handlers in `ws.ts` until their own
   boundary is larger than the assembly cost.

Each handler factory receives the concrete services and authorization wrapper
it uses. Do not pass a bag containing every service yielded by `makeWsRpcLayer`,
and do not introduce a registry that hides method-to-scope coverage.

### Regression surface

- `tests/apps/server/server.test.ts`
- `tests/apps/server/startupAccess.test.ts`
- focused auth, workspace, proposal, VCS, terminal, preview, and worker tests
  for the aggregates moved in a given batch
- a contract audit proving every RPC method still has exactly one declared
  authorization scope

### Stop conditions

Stop and re-plan if combining handler fragments weakens `WsRpcGroup` inference,
duplicates authorization, changes stream subscription lifetime, or requires a
generic dependency container.

### 2026-08-02 checkpoint: authorization and five aggregates complete

Approval unit 3 moved authorization to `ws/rpcAuthorization.ts` and moved the
workspace, proposal, VCS, preview, and orchestration method groups to explicit
handler factories. `ws.ts` remains the authentication, service-acquisition,
and sole `WsRpcGroup.of`/`WsRpcGroup.toLayer` assembly facade. Dependencies are
concrete and one-way; no handler registry, service bag, cache, or duplicate
authorization owner was introduced.

The final contract audit reports exactly 90 declared scopes, 90 RPC methods,
and 90 `observeRpc*` wrappers. Independent source review confirmed the method
sets and the snapshot-before-live, revision, coalescing, completion,
subscription, and finalizer behavior of the extracted streams. Targeted
formatting/comment/lint checks pass. The focused orchestration run has three
`AttachmentLifecycleRepository` fixture failures and 97 passing tests in both
the immutable pre-extraction baseline and the integrated source, so those
three failures are recorded as pre-existing fixture drift rather than an
accepted regression. Package typecheck diagnostics are unrelated to the
touched files.

## Claude Adapter

### Stable facade

Keep `ClaudeAdapterLiveOptions` and `makeClaudeAdapter` exported from
`apps/server/src/provider/Layers/ClaudeAdapter.ts`. The facade continues to
construct one adapter and return the existing `ClaudeAdapterShape` without a
new public package export.

### State ownership

- The `sessions` map and each `ClaudeSessionContext` remain owned by the adapter
  session coordinator.
- The runtime event queue remains the single ordered output channel.
- Pending approvals and user-input requests remain coupled to their existing
  `Deferred` values and cleanup paths.
- Resume cursors, turn state, assistant block state, and SDK query lifetime
  remain updated atomically by the session coordinator.

### Side-effect ownership

Extract pure policy before lifecycle code:

1. Move token/context usage normalization to
   `apps/server/src/provider/claude/ClaudeTokenUsage.ts`.
2. Move tool classification, task projection, plan-step derivation, and tool
   summaries to `apps/server/src/provider/claude/ClaudeToolProjection.ts`.
3. Move SDK content extraction, unknown-message diagnostics, and fingerprints
   to `apps/server/src/provider/claude/ClaudeSdkMessages.ts`.
4. Move prompt and image-content construction to
   `apps/server/src/provider/claude/ClaudePrompt.ts`.

After those pure modules are stable, design a second approval gate for SDK
stream lifecycle. That gate may move query launch/replacement/shutdown into a
session-runtime module, but `makeClaudeAdapter` must retain finalizer ownership
until cancellation and queue-shutdown equivalence are proven.

### Regression surface

- `tests/apps/server/provider/Layers/ClaudeAdapter.test.ts`
- `tests/apps/server/provider/Drivers/ClaudeExecutable.test.ts`
- `tests/apps/server/provider/Drivers/ClaudeHome.test.ts`
- `tests/apps/server/provider/Drivers/ClaudeSkills.test.ts`
- `tests/apps/server/integration/providerService.integration.test.ts` when the
  lifecycle phase begins

The focused adapter suite must preserve event order, runtime IDs, resume and
clear behavior, tool/task projection, approval settlement, interruption, query
replacement, and finalization.

### Stop conditions

Stop and re-plan if a pure module needs access to the sessions map or event
queue, if extraction changes SDK query creation timing, or if finalizers become
distributed across multiple layers.

### 2026-08-02 checkpoint: pure policy and bounded query resources complete

Approval unit 4 moved token normalization, tool projection, SDK-message
decoding, and prompt construction into four direct-import pure modules under
`provider/claude/`. They do not own the sessions map, runtime event queue,
`Deferred` values, SDK stream, or finalizer.

The required current-state review for approval unit 5 rejected a broad session
coordinator move and approved only a bounded `ClaudeSessionRuntime.ts` query
resource helper. `ClaudeAdapter.ts` still owns session registration, canonical
event ordering, stream launch and exit handling, approvals and user input,
resume/turn mutation, map deletion, and the sole `Effect.addFinalizer`.
Independent review found and the integration pass fixed one low-severity drift:
the injected `createQuery` option is captured once at adapter construction, as
it was before extraction, instead of being reread from a caller-mutable options
object. The focused Claude adapter suite passes all 62 tests, and targeted
formatting/comment/lint checks pass.

## Approval Units

1. `ChatView` terminal slice - complete on 2026-08-02
2. `ChatView` dispatch and panel controllers - complete on 2026-08-06
   (send/retry via `ChatSendPorts`; integrated web pass deferred AFK)
3. WebSocket authorization and one handler aggregate at a time - complete on
   2026-08-02
4. Claude pure normalization modules - complete on 2026-08-02
5. Claude SDK session lifecycle, only after a new current-state review -
   complete on 2026-08-02 as the approved bounded query-resource helper

All five units were approved for implementation. Further `ws.ts` / ClaudeAdapter
moves still require new designs under plan 24 HOLDs.

### 2026-08-06 Phase 3b design addendum

See `.plans/24-layout-execution-designs.md`.

### 2026-08-06 Phase 3c checkpoint: ChatView send/retry complete

Approval unit 2 send/retry seam closed by extending
`useChatDispatchController` with `ChatSendPorts` and moving `runSend` /
`dispatchSend` / `onSend` / `runSendRef` there. Pure helpers
`formatOutgoingPrompt`, `IMAGE_ONLY_BOOTSTRAP_PROMPT`, and
`shouldRestoreComposerDraftAfterSendFailure` live in `ChatView.logic`.
Timeline scroll effects and optimistic-preview promotion effects stay in
`ChatView.tsx`. Focused web tests: ChatView.logic + sendPorts + related
composer/session suites (**170** passed). `test-t3-app` integrated pass
deferred (AFK).

1. **ChatView send/retry** — **Done** (uncommitted); shell **5759**,
   controller **1430**.
2. **ws / Claude further units** — **Hold** assembly and session/finalizer
   ownership; optional terminal/workers handler aggregates only if staffing
   justifies thinning (`ws.ts` **1208**, `ClaudeAdapter.ts` **3923**).
