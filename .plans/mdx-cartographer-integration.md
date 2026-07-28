# MDX viewing (mdx-forge) + codebase explorer (cartographer) integration

Status: all five approved phases implemented; final focused gates and integrated acceptance recorded
below
Date: 2026-07-27
Evidence: Codex Desktop synthesis thread `019f9c6c-8525-7662-a47b-b55c74fb9e16` (6 read-only codex
research workers over 456code), plus independent Claude worker-broker reports on cartographer
(`…-resear-9df23312`) and vsc-mdx-preview (`…-resear-efde5395`), plus lead-session verification of
every load-bearing claim against live code (anchors below).

## Approved defaults (decision log)

1. **SafeDocument-only MDX.** `.mdx` renders through mdx-forge `compileSafeDocument()` — versioned
   JSON, closed node vocabulary, schema-declared component props, diagnostics, source ranges; no
   HTML emission, no executable JS. Chat, plans, and `.md` keep the existing `ChatMarkdown` path.
   `compileSafe()` (HTML; not a complete sanitizer — the VS Code reference host re-sanitizes with
   DOMPurify) and `compileTrusted()` (evaluates via `new Function()`) are rejected for v1.
2. **Hosted cartographer sub-app boundary.** A native `ExplorerPanel` right-panel shell embeds a
   supervised Cartographer atlas proxied by the 456code server. No direct import of `src/web` into
   `apps/web` (private app: own React root, history ownership, module-global zustand, global
   Tailwind). The installed Cartographer build is trusted server software; the iframe is lifecycle
   and UI containment, not a hostile-code security boundary.
3. **Standalone immutable proposal domain.** `Proposal` -> `ProposalRevision` (immutable base
   snapshot + typed file ops) -> `ProposalGeneration` (derived diff/MDX/cartographer artifacts) ->
   `ImplementationAttempt`. Plans link to proposals; nothing is stored inside
   `OrchestrationProposedPlan` (prose-only, mutable, pruned on revert, `implementedAt` set at
   turn start — verified in `packages/contracts/src/orchestration.ts`).
4. **Git-only exact first release.** One thread, one worktree, static analysis, no dirty
   submodules. Explicit unsupported results elsewhere; never approximate while claiming exact.

Ruling on trusted MDX (2026-07-26): stays out of scope for the entire 5-phase sequence. Growth path
for interactivity is the closed host component catalog, not MDX-embedded JS. Revisit only with a
concrete use case, and then as a genuinely isolated-origin sandbox with explicit consent. The
phase-3 ticket and message contracts may be reusable, but its same-origin trusted sidecar boundary
is not sufficient. See "Deferred" below.

## Ownership boundaries

| Owner | Responsibility |
|---|---|
| mdx-forge | Safe MDX parsing, diagnostics, source ranges, document schema |
| cartographer | Code graphs, structural comparison, atlas visualization |
| 456code server | Authorization, worktree identity, proposal revisions, jobs, artifacts |
| 456code web | Right-panel composition, native diff, MDX rendering, synchronized selection |

MDX and cartographer meet only through 456code artifact references; neither imports the other.

## Phases

### 1. Safe `.mdx` viewing (3–5 days)

Implemented 2026-07-27. Repository `.mdx` files now render through the safe-document path;
chat/plans/`.md` remain on `ChatMarkdown`. `filePreviewMode.ts` classifies `.md` and `.mdx`
separately, and `FilePreviewPanel.tsx` exposes an explicit source/render toggle for `.mdx`.

Pipeline: workspace-relative path -> path-safe server read -> size/truncation rejection ->
`compileSafeDocument()` -> versioned transport DTO -> exhaustive native React renderer.

Policy: `unknownComponents: "reject"`, `rawHtml: "reject"`, host component schemas, host URL
policy. Initial catalog: `Callout`, `FileReference`, `SymbolReference`, `DiffReference`,
`ArchitectureImpact` — opaque IDs / workspace-relative targets only; no raw payloads, callbacks, or
absolute paths. Renderer: accept only supported SafeDocument version, stop on error diagnostics
(show source + diagnostics), exhaustive node mapping, links/images through the authenticated asset
boundary, no dynamic component lookup / prop spreading / `dangerouslySetInnerHTML`.

#### Phase 1 implementation record

- **Authenticated server boundary.** `projects.readMdxDocument` accepts only an authenticated
  `threadId` plus workspace-relative `.mdx` path. The server derives the authorized thread worktree
  root, advertises the `safeMdxDocument` capability, rejects non-MDX and oversized/truncated input,
  and returns no raw internal error cause.
- **Pinned safe compiler + closed transport.** `apps/server` pins `mdx-forge` `0.9.1`, calls only
  `compileSafeDocument()` with the fixed reject policy, canonicalizes diagnostics to host-controlled
  codes/messages, removes unknown nodes, and decodes the result through the bounded v1 schema in
  `packages/contracts/src/mdx.ts`. Compiler diagnostic data and schema failures cannot serialize
  authored secrets.
- **Race-safe file reads.** `WorkspaceFileSystem` now opens with no-follow/nonblocking flags,
  validates canonical root/target and file identity before and after the exact positional read,
  detects symlink swaps and concurrent mutation, rejects early EOF, and fatally decodes UTF-8 so a
  truncated code point is never returned as valid source.
- **Native client renderer.** `SafeDocumentRenderer.tsx` uses exhaustive switches for the closed
  element/component vocabulary, fixed prop extraction, authenticated workspace assets, and
  workspace-aware file navigation. Error diagnostics block the entire rendered tree and show the
  exact escaped source. Unsupported future versions/nodes fail closed through the render boundary.
- **Save/query coherence.** MDX compilation is refreshed only after the latest source save is
  confirmed; overlapping save owners cannot strand the preview in a permanent pending state or
  let an older confirmation replace newer content.

Phase 1 intentionally leaves workspace-link fragments unsupported (`fragment_not_allowed`) until
fragment-aware file navigation exists. `DiffReference` and `ArchitectureImpact` are inert,
closed-schema references until their owning later phases are implemented. Trusted MDX remains out
of scope.

#### Phase 1 acceptance evidence

| Gate | Result |
|---|---|
| Focused contracts/shared/server/web suite | 8 files, 74 tests passed |
| Authenticated RPC seam | 2 tests passed; 86 unrelated server tests skipped |
| Affected package typechecks | contracts, shared, client-runtime, web, and server passed |
| Targeted lint | no new findings; one pre-existing unused-helper warning in `tests/apps/server/server.test.ts:992` |
| Production server bundle | passed; `dist/bin.mjs` 4.33 MB |
| Integrated authenticated web pass | safe native render, authenticated image, source/render toggle, `.md` isolation, and external source refresh passed; executable MDX, unknown component, raw HTML, and `javascript:` URL produced fixed diagnostics, escaped source, zero authored executable DOM nodes/links, and no sentinel execution |

### 2. Proposal domain + exact code diff (1–2 weeks)

Agents submit an immutable proposed edit set; 456code shows its exact textual diff without touching
the user's worktree.

Revision identity: environment/project/source-thread/producer; canonical repository + worktree
identity; base `HEAD` + exact working-tree tree OID + snapshot policy; typed
add/modify/delete/rename ops with per-file `beforeSha256` + byte/file counts; optional plan ID +
plan-markdown hash. Unified diff accepted as input but normalized before persistence. Large bodies
as content-addressed blobs; manifests carry hashes only. Reuse the Pierre-based patch renderer by
extracting it from `DiffPanel`; proposals become one more typed diff source.

Snapshot capture uses shared raw-byte Git object plumbing plus an isolated temporary index (the
user index and tracked files remain untouched). It does not invoke clean, smudge, EOL, textconv, or
checkout filters. Snapshot policy (visible to the user): tracked content = current filesystem
bytes; untracked+unignored included; ignored omitted; staging boundary not preserved; dirty
submodules unsupported.

#### Phase 2 implementation record

- **Standalone persistence.** Migration 037 adds proposals, immutable revisions, and
  content-addressed blobs without changing `OrchestrationProposedPlan`. Repository decoding
  rechecks every stored manifest hash before returning revision authority.
- **Exact Git engine.** Proposal capture uses direct raw-byte blob insertion plus an isolated
  temporary index, canonical repository and worktree identity, clean-submodule admission, typed
  add/modify/delete/rename operations, before-hash preconditions, bounded binary-safe content,
  exact retained base/proposed tree refs, and a normalized bounded diff. It does not invoke
  repository filters or modify the user's worktree or index.
- **Authorized RPC surface.** Proposal list/get/diff/narrative endpoints verify the authenticated
  environment, project, source thread, and worktree-derived scope. Bodies remain in the blob store;
  manifests and revisions carry hashes and byte counts.
- **Shared native diff.** The existing Pierre-backed renderer was extracted into
  `NativeDiffSurface`; the worktree diff and proposal diff now use the same native presentation
  without conflating their data sources.
- **Fail-closed limits.** Proposal operations are regular-file-only, path-safe, mode-aware, and
  bounded at schema and execution time. Non-Git roots, dirty submodules, repository/worktree
  identity changes, symlink/type-changing operations, stale before hashes, malformed diffs, and
  output overflow return explicit proposal errors.

### 3. Hostable cartographer atlas (1–2 weeks, both repos)

The shared web right panel can explore the current codebase through Cartographer on local, remote,
desktop, and mobile-web hosts that meet the authenticated-cookie policy. Native `ExplorerPanel`
shell (right panel already owns thread-scoped surface persistence:
`apps/web/src/rightPanelStore.ts`). Integrated acceptance for this delivery covers local web;
desktop CSP is covered by focused unit/type gates, while native desktop, remote, and mobile
transport traversal remain unclaimed.

Cartographer needs an embedded distribution: namespaced base URLs, one immutable host-provided
worktree target, embedded URL policy (no parent history ownership), host-provided storage
namespace, versioned origin-checked message protocol, and lifecycle states
(ready/indexing/stale/error/shutdown). A raw iframe at `cartographer serve` is insufficient — the
server is loopback-bound with DNS-rebinding host guards and a project-registry root allowlist
(`src/store/atlasHttp/guard.ts`, `src/cli/commands/serve.ts`).

456code server proxies the embed and binds it to the authenticated thread worktree. Remote/DPoP
clients get a short-lived embed ticket exchanged for a narrow HttpOnly session (iframe navigation
cannot carry auth headers; no credentials in iframe URLs). Host bridge stays small: ready,
selection-changed, open-source, proposal-generation-changed, theme-changed, fatal-error. Graph
bodies stay behind authenticated HTTP.

#### Phase 3 implementation record

- **Cartographer distribution.** Cartographer now provides an `embed-server` command with
  namespaced API/static URLs, fixed host-provided target and storage namespace, exact parent-origin
  bridge validation, theme updates, selection/open-source messages, bounded startup handshake, and
  graceful shutdown. Standalone serving remains unchanged.
- **Read-only embedded runtime.** Embedded mode does not instantiate the GraphPatch proposal hooks
  or proposal rail/editor and does not register patch-list, patch-preview, patch-save, or
  `.cartographer/patches` routes. This prevents a second proposal-authoring authority inside
  Explorer while preserving standalone Cartographer behavior.
- **Authenticated broker.** 456code supervises one sidecar per thread, accepts only the configured
  built CLI and Node runtime, exchanges a short-lived one-use ticket for a path-scoped HttpOnly
  cookie, pins the parent origin and loopback target, and bounds startup, proxy response size, and
  proxy wall time. The proxy strips upstream content encoding and length after fetch decoding, so
  representation metadata cannot describe different wire bytes.
- **Exact session lifecycle.** Replacement closes the prior same-thread sidecar; normal Explorer
  close releases only its exact session ID; thread deletion tombstones the thread before cleanup;
  expiry, child failure, server shutdown, and obsolete issue results also terminate the child.
- **Honest current snapshot.** A current-worktree Explorer is an on-demand capture-only session.
  Its UI says edits are not watched and instructs the user to close/reopen. Inactive Explorer tabs
  stay mounted so switching Narrative/Code/Architecture cannot consume a one-use iframe ticket
  twice. The broker invokes Cartographer with `--scope .` against the immutable captured repository
  root, and a settled negative proposal lookup remains settled across polling so it cannot
  repeatedly replace the same current-worktree session.
- **Truthful coarse lifecycle.** Cartographer reports a usable deferred coarse atlas as ready,
  reserves indexing for active detailed analysis, and continues to expose its 2,000-file automatic
  detail budget inside the embedded app.
- **Trusted boundary.** `sandbox="allow-same-origin allow-scripts"` contains the trusted installed
  sub-app's UI and lifecycle but is not hostile-code isolation. Cartographer already runs as a
  server child with access to the supplied source root; only trusted builds may be configured.

### 4. Exact architecture-impact previews (1–2 weeks, after 2+3)

Explorer shows the exact proposed source diff AND cartographer's analysis of the exact proposed
tree. Cartographer `GraphPatch` (`src/analyze/patch.ts`, `evaluatePatch()`) is structural-only
(add/remove/move file, add/remove import) — never labeled an exact code preview; it may become an
optional "structural estimate" view later.

Exact pipeline: capture exact base tree -> materialize disposable tree -> verify before-hash
preconditions -> apply ops -> run cartographer in a verified static (no-project-code-execution)
mode -> compare base/proposed graphs -> publish authenticated artifacts.

Generation status separates `state` (queued/preparing/analyzing/ready/failed/cancelled/abandoned),
`authority` (authoritative/estimated), and `freshness`
(fresh/base-changed/worktree-changed/analyzer-changed). Ready generations go stale visibly; no
silent rebase. Admission bounded by provider session, thread, environment, global concurrency,
patch size, file count, output size, wall time, temp disk; new generations cancel superseded work.

#### Phase 4 implementation record

- **Bounded generation domain.** Migration 038 records generation lifecycle separately from
  immutable revisions. The server admits at most one active generation per thread and two globally,
  cancels superseded work, abandons interrupted rows at startup, and cleans partial roots for every
  non-ready terminal path.
- **Verified static analyzer.** Cartographer's `analyze-trees` command receives explicit base and
  proposed trees, stages source roots below its caller-owned output directory, never follows
  symlinks, excludes symlink entries, rejects special filesystem entries, and emits deterministic
  base graph, proposed graph, and impact artifacts without executing project code.
- **Sealed artifacts.** 456code validates analyzer manifest shape, exact graph `gitRef` values,
  impact base/head refs, total artifact bounds, and the analyzer-distribution hash. It seals outputs
  under content-addressed names and records a deterministic no-follow digest of the proposed source
  root.
- **Embed-time revalidation.** Before launching the atlas, the server rechecks retained Git refs,
  artifact paths and content hashes, embedded graph/impact refs, total size, and the proposed-root
  digest. Tampering or substitution becomes `generation_not_found`; no approximate live rebuild is
  substituted.
- **Visible authority and uncertainty.** Explorer distinguishes lifecycle, authority, and freshness,
  exposes retry for terminal analysis failures, preserves exact revision/snapshot identity across
  all three views, synchronizes file selection, and explains that missing symbol evidence on
  namespace/star/dynamic imports means conservatively unknown/all impact.

### 5. Plan-mode wiring (~1 week, after 4)

New thread-scoped MCP capability `"proposal"` (separate from browser-preview automation;
`apps/server/src/mcp/McpInvocationContext.ts`). `proposal_preview_upsert` accepts bounded file ops
+ optional Safe MDX narrative; environment/thread/provider/root come from the authenticated
invocation context, never tool args. Rejected derivation channels: plan markdown, assistant code
fences, `turn.diff.updated`, `.cartographer/patches`, `GraphPatch`.

UX: plan card shows "Analyzing revision N against workspace snapshot X"; Explorer shows Narrative /
Code Changes / Architecture views. Proposal graph selection opens the retained proposal path in
Code Changes; current-worktree selection opens the live Files surface. Workspace movement marks
revisions stale; implementation records the consumed revision; afterward the checkpoint diff is
compared to the selected revision (matched / partial / divergent). Copy is "Preview of proposal
revision N against workspace snapshot X", never "changes the agent will make".

#### Phase 5 implementation record

- **Exact live-turn authority.** The proposal capability is separate from browser preview. A call
  must match the authenticated MCP session's active turn, the projected running latest turn, and
  `interactionMode: "plan"`. Default mode, missing/ended/mismatched turns, stale MCP sessions, and
  missing capability fail closed.
- **No plan-row deadlock.** The server derives a deterministic plan ID from the authenticated thread
  and active turn. Proposal submission therefore succeeds before Codex emits the final proposed-plan
  item; the later projected plan uses the same identity. Neither a plan ID nor a markdown hash is
  accepted as tool authority.
- **Provider instruction and honest fallback.** Codex plan-mode instructions require a successful
  proposal call before finalization and tell the provider to retry actionable failures. Final-plan
  ingestion does not enforce that prompt-level behavior: if a provider still omits the call,
  456code displays that no immutable revision is linked and opens a current-worktree snapshot
  rather than silently selecting a different proposal.
- **Exact plan UX.** `ProposedPlanCard` looks up only its linked plan identity, displays revision and
  captured tree OID, automatically starts the exact revision's generation when Cartographer is
  available, and opens Explorer without broad “latest proposal” fallback. Narrative is
  SafeDocument-only; Code Changes is the exact retained diff; Architecture is the exact verified
  generation.
- **Implementation identity.** Migration 039 records the proposal revision consumed by an
  implementation request. The reactor prefers the persisted projected turn's request timestamp and
  source proposal, uses pending in-memory data only while projection catches up, and can recover
  after restart/replay.
- **Baseline-to-actual classification.** Attempt completion reads both the stored baseline and
  actual checkpoint trees and credits only exact manifest transitions performed by that turn.
  Already-satisfied adds/modifies/deletes/renames do not count. Outcomes are `matched`, `partial`, or
  `divergent` with persisted matched/intended operation counts; Explorer includes those counts in
  partial-outcome copy.
- **Cross-lifecycle cleanup.** Thread deletion cancels generation and embed work under permanent
  per-thread tombstones; normal Explorer close is exact-session-scoped; checkpoint completion and
  provider events cannot attach attempts to a different turn, worktree, or proposal identity.

## Delivery sequence

| Step | Visible win | Delivery |
|---|---|---|
| 1 | Repository `.mdx` files render safely | Complete |
| 2 | Exact proposal submission + code diff inspection | Complete |
| 3 | Codebase exploration in the right panel | Complete |
| 4 | Exact Cartographer analysis of proposed trees | Complete |
| 5 | Plan refinement + proposed-vs-actual comparison | Complete |

The original single-engineer cumulative estimate was 5–8 weeks. This implementation completed the
approved scope in one coordinated repository run; the completion claim is based on the focused
gates and explicit acceptance limits below, not elapsed-time equivalence with that estimate.

## Resolved cross-checks and retained constraints

- **Node 24 / sqlite boundary.** Cartographer requires Node >=24 and uses `node:sqlite` snapshots.
  The integration uses an explicitly configured supervised Node sidecar rather than in-process
  linking, so 456code's Electron/server runtime does not silently become the Cartographer runtime.
- **Watch mode is full-rebuild.** No incremental analysis; no repo-wide latency guarantee in the
  acceptance suite. Current-worktree Explorer uses an on-demand capture and proposal generations
  are event-triggered; neither is presented as an always-fresh watcher.
- **Pre-1.0 private package.** Deep imports into cartographer internals are upgrade risk; the
  CLI/HTTP/message contracts are the coupling firewall. mdx-forge is published (0.9.1) but also
  pre-1.0 — phase 1 pins the exact version and consumes only the documented root export.
- **One effective trust capability.** vsc-mdx-preview computes forced-safe-mode in one place while
  CSP and replicated trust state read another — a near-miss to copy-avoid: 456code must derive a
  single capability used consistently across compilation, fetch authorization, CSP, and browser
  gating. The delivered MDX path is always SafeDocument-only; Cartographer is a separate optional
  trusted-sidecar capability.
- **Blast-radius semantics.** Absent `GraphEdge.symbols` means unknown/all (over-approximation for
  namespace/star/dynamic imports) — surface this honestly in impact UI copy.
- **Symlink boundary.** Proposal operations do not author symlinks. Existing symlinks can exist in
  retained Git trees, but static analysis excludes them without following targets; the embed-time
  source-root digest records symlink targets without dereferencing them.
- **Read-only embed authority.** Cartographer's standalone GraphPatch workflow remains available in
  Cartographer itself, but embedded mode has no patch UI or patch routes. Exact 456code proposals
  remain the only authoring authority in Explorer.
- **Hard-crash cleanup boundary.** Graceful shutdown, interruption, replacement, expiry, and thread
  deletion are covered. An uncatchable process kill or host crash can leave an embed sidecar or
  session directory because v1 does not persist sidecar PIDs or perform an embed-session startup
  sweep; this is an explicit operational limit, not a claimed acceptance path.
- **One exact byte definition.** Proposal bases, freshness checks, current Explorer snapshots,
  implementation-attempt fallbacks, and checkpoint capture all use
  `vcs/ExactGitSnapshot.ts`. Retained trees, Cartographer inputs, and checkpoint restore write Git
  blob bytes directly; clean/smudge/EOL/textconv filters never define an “exact” result.
- **Bounded nontransactional restore.** Exact restore validates and buffers the complete bounded
  target before mutation, preserves ignored paths, and rejects dirty/changing gitlinks. Once leaf
  deletion/direct writes begin it is not transactional; an interruption or external filesystem
  race can require retrying the same checkpoint restore. Interrupted object admission may leave
  unreachable objects for normal Git garbage collection, but never a partial retained ref.
- **Immutable-history retention.** Proposal refs, proposal blobs/rows, and ready generation
  artifacts currently have no automatic retention or garbage-collection policy. Thread deletion
  cleans active generation/embed work but does not prune retained immutable proposal history.

## Final acceptance record (2026-07-27)

### Focused automated gates

The final gate set is deliberately affected-scope-only under this repository's test policy; no
repo-wide test or typecheck command was run locally.

| Surface | Final result |
|---|---|
| 456code contracts/server/desktop | 22 focused files, 179 tests passed across MDX, proposals, exact Git/checkpoints, Cartographer broker/proxy/snapshots/generation, MCP/provider authority, persistence, protocol, and cleanup |
| 456code web | 12 focused files, 76 tests passed across SafeDocument, proposal card/diff, Explorer bridge/lifecycle/selection, file preview/save, timeline, and right-panel state |
| Authenticated server RPC seam | 2 integration tests passed; 87 unrelated tests in the same large server test file were intentionally skipped by name |
| Cartographer | 4 focused files, 11 tests passed for static tree analysis, embedded server/read-only policy, and coarse/detailed lifecycle; full source/web/test typecheck, lint, format check, diff check, and production build passed |
| Static/build gates | contracts, shared, client-runtime, web, desktop, and server typechecks passed; 456code targeted lint/format and both diff checks passed; server bundle (4.54 MB), 456code web production build, and Cartographer production build passed with only existing size/source-map/plugin timing warnings |

### Integrated authenticated local-web traversal

1. **Safe MDX boundary.** An authenticated repository `.mdx` file rendered through the native
   SafeDocument renderer with its authenticated image and source/render toggle. Executable MDX,
   unknown components, raw HTML, and a `javascript:` URL each failed closed with fixed diagnostics,
   escaped source, no authored executable DOM, and no sentinel execution. A neighboring `.md`
   remained on the existing Markdown path, and an external source edit refreshed correctly.
2. **Fresh linked plan path.** A brand-new post-instruction Codex plan turn retried one actionable
   schema error, successfully created immutable revision
   `revision-faa9d8bf-b7e9-4328-a70d-c1f8787d0272`, and only then emitted its final plan. The card
   displayed the exact captured workspace snapshot; Explorer showed the SafeDocument narrative,
   one 516-byte `docs/README.md` operation in Code Changes, and the verified Cartographer atlas for
   the retained proposed tree.
3. **One-use proposal session.** Narrative, Code Changes, and Architecture tab switches preserved
   the same iframe URL/session. Cartographer selection and **View source** routed the retained
   proposal file back to Code Changes rather than the live Files surface. Closing and reopening
   Explorer replaced the exact session with a different session ID and terminated the predecessor.
4. **Unlinked current-worktree fallback.** An honestly unlinked refined plan displayed no immutable
   revision and opened a capture-only **Current worktree snapshot**. The 4,440-file monorepo root
   produced a usable coarse atlas under explicit root scope; the outer false-indexing banner was
   absent, the capture disclosure remained visible, and an opened Cartographer source routed to
   the live 456code file viewer.
5. **Poll and workspace stability.** The current snapshot retained one issued session through more
   than two negative `findByPlan` polling intervals. The user index SHA-256 remained
   `19818fb75a1af021c9ec371ec6f75db94de7cb58e470be80c49fed5575cb1752`; proposal retention created
   only the expected base/proposed refs, whose diffs were one `docs/README.md` modification and one
   `docs/cartographer-acceptance-note.md` addition. No plan turn edited the worktree.

### Explicitly unclaimed or deferred

- Native desktop, remote-host, mobile-web, and mobile-native UI traversal were not run. Desktop
  custom-protocol/CSP behavior and remote cookie policy are covered by focused tests; the live pass
  was authenticated local web only.
- Provider compliance with the proposal-call instruction is not a server invariant. The linked path
  was proven on a fresh turn, while one refinement turn ignored the tool; the unlinked fallback is
  therefore part of the accepted behavior rather than hidden.
- Hard host/process crashes can leave sidecars or session directories, and retained immutable
  proposal refs/blobs/ready artifacts have no automatic GC policy. Graceful, replacement, expiry,
  cancellation, and deletion paths are covered.
- Exact snapshot/restore remains bounded to 25,000 entries / 256 MiB. Restore is nontransactional
  after filesystem mutation starts; clean gitlinks materialize as empty directories, while dirty
  or changing gitlinks fail closed. Interrupted object admission may leave unreachable objects for
  normal Git GC.
- The trusted installed Cartographer process is not hostile-code isolation; executable authored MDX
  remains deferred. No commit, push, deploy, package release, database seed/reset, or history
  rewrite is part of this acceptance.

## Deferred

- **Trusted MDX execution.** `compileTrusted()` output runs via `new Function()` with singleton
  browser-runtime state; in 456code's authenticated web origin that is XSS-equivalent (session,
  threads, MCP control), and agent-authored MDX is prompt-injection-reachable. Interactivity comes
  from growing the closed component catalog. Reconsider only with a concrete need, implemented as a
  genuinely isolated-origin realm with per-workspace explicit consent. The current trusted
  Cartographer same-origin sidecar boundary is not sufficient for authored code.
- **Fully native atlas.** After cartographer exports supported contracts/client/React packages,
  store factories, peer deps, scoped styles, and host-controlled navigation.
- **Cross-worktree / non-Git / dirty-submodule proposals.** Explicit unsupported results in v1.
- **Structural GraphPatch estimate in Explorer.** Cartographer's structural patch evaluator is not
  an exact code preview and remains outside this integration. Embedded mode is intentionally
  read-only.

## Verified code anchors

- `apps/server/src/mdx/WorkspaceMdxDocument.ts` and
  `apps/server/src/workspace/WorkspaceFileSystem.ts` — authorized safe compilation and exact
  race-safe workspace reads; `packages/contracts/src/mdx.ts` — closed v1 transport;
  `apps/web/src/components/files/filePreviewMode.ts`, `FilePreviewPanel.tsx`, and
  `SafeDocumentRenderer.tsx` — separate `.md`/`.mdx` modes and exhaustive native rendering
- `packages/contracts/src/orchestration.ts` — `OrchestrationProposedPlan` prose-only shape
- `apps/server/src/vcs/ExactGitSnapshot.ts` — shared raw-byte capture, materialization, and restore;
  `apps/server/src/vcs/GitVcsDriver.ts` — exact checkpoint capture/restore and retained checkpoint
  refs
- `apps/server/src/proposal/ProposalGitEngine.ts`,
  `ProposalGenerationService.ts`, and `ProposalImplementationAttemptService.ts` — retained proposal
  trees, verified static materialization/freshness, and baseline-to-actual identity
- `apps/server/src/cartographer/CurrentWorktreeSnapshot.ts`,
  `CartographerEmbedBroker.ts`, and `CartographerHttp.ts` — immutable current captures, supervised
  exact-session lifecycle, and bounded authenticated loopback proxy
- `apps/web/src/components/explorer/ConnectedExplorerPanel.tsx` and `ExplorerPanel.tsx` — exact
  proposal/current target composition, retained diff selection, and mounted iframe lifecycle
- cartographer `src/analyze/patch.ts` — structural `GraphPatch`; `src/store/atlasHttp/guard.ts` —
  loopback/origin guard; `src/store/pipeline.ts` — `runBuildPipeline()`
- mdx-forge `src/compiler/safe-document/compile.ts` — `compileSafeDocument()`;
  `src/browser/eval/evaluateModule.ts` — `new Function()` in trusted evaluation
