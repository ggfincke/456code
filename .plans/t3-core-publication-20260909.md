<!-- .plans/t3-core-publication-20260909.md -->
<!-- record the standalone core publication scope, source attribution and local verification -->

# Core reconciliation publication checkpoint

Prepared on 2026-09-09 for approved Group 1 of the four-PR reconciliation: streaming/rendering
foundations, asynchronous questions, manual compaction, runtime/tooling, settlement and checkpoints
(former PRs 7, 9, 12 and 13). Baseline is `380adafaf6fa30a481962ece4678d425bb9e94fb`.
The approved frozen intake ends at `6c583620ff7ad3235b135af7107c0543467eecfa`; this is not a new
nightly intake or a claim that every row of the 894-source reconciliation ledger is implemented.

The independently extracted code tree is `858dc21462c760572387fea1b5a413a28a6b1556`, changing 179
files from baseline. Its prepared history contains 51 nonempty source-attributed adaptations and one
fork integration commit. This document is a separate documentation-only addition after that code
tree; the containing Git commit identifies the final publication tree. Publication, hosted CI and
merge are separate acceptance stages, not represented by local preparation.

## Source fidelity and actual adaptations

Each source-attributed commit retains the exact original Author, AuthorDate, full message and
trailers, and adds `Source` and `Adaptation` paragraphs. The source identities below identify the
bounded implementation actually adapted, not the whole upstream patch. Later overlapping changes
have their own nonempty commits; they are not credited wholesale to a foundation source. Tests that
span several source contributions and fork-specific ownership repairs are grouped separately.

| Source SHA | Adapted Core behavior |
| --- | --- |
| `c5ba51d629b3813182cf3e161cc3f23b1e541dc3` | Manual native/slash compaction, binding and completion ownership, orchestration and required native composer/queue guards. |
| `5fa35d211682ee02e34fba0711838ca431ed003b` | Adapter-declared compaction strategies, unsupported-adapter rejection and common ten-minute completion timeout. |
| `fce8508456e7f9218eebb02ecd764f9b3a47df6b` | Actionable missing-workspace failure before replacing a provider session. |
| `d76b24dd15a219666941ab1b4967d8f738adcda0` | Whole-payload-validated asynchronous questions and durable atomic answer lifecycle. |
| `d7fe47fd0957a34fc2e8bb05f12db19bac3403b6` | Resolve native callback questions when their exact turn ends while retaining message-mode and other-turn questions. |
| `7112697e8be2d6f231726a91eb565e00ddbeebec` | Explicit no-answer dismissal for message-mode questions and both client consumers. |
| `f32f9a2f41342bf8a1a109d6ebe9b70044c5311b` | Server-owned settlement, saved-branch PR lookup, freshness guards, settings and client capability fallback. |
| `2971ec3209d7ef1b00d7ded70fe6342816b1539f` | Preserve the qualifying activity timestamp on settlement. |
| `d3d4ea42ee569f20d8a79562974355f659dc46d9` | Skip snapshot/session/PR work when both settlement policies are disabled. |
| `4e547318b60031eb546d8cf2b84ad9fa0785a87a` | Refresh missing PR state after a turn; own-name remote tracking and repository cache identity. |
| `2b96220f00de09b61327c8e881b7f509f8cc5a79` | Sixty-second PR lookup cache TTL only. |
| `050690d1bc048c1f94096c17a1c9231c3ad61a83` | Actual merged/closed terminal timestamps through existing GitHub/GitLab producers and saved-branch lookup. |
| `6f405370c8e552da9dcfdd6922e85789fd918340` | Startup error reporting and bundled-development Tailwind reload ownership, retaining the fork root and hash router. |
| `f96a220b5b154ea44c94bf43929c6362cd511699` | Electron runtime script pathToFileURL entrypoint guard only. |
| `60e1b73948debac845c3dc72aac35c9adbd4cd64` | Separate LAN/Tailscale desktop endpoints and preserve Tailscale-only network mode. |
| `2c301fd0c4fc58c1612be47c3856fa4ad547429d` | Validate the already-supported cloudflared binary with its version subcommand. |
| `f33fdc992488e36ccb70cbb71d55e630b5184cbd` | Exec the resolved managed SSH executable instead of recording an npm wrapper PID. |
| `c3caceade14ccda0686db0031aca79d7d38a71d0` | Deduplicate executable search directories. |
| `781f41ef1f6b5054e75f77237df9eba3b7f61cc9` | Reject environment-theme symlink escapes. |
| `08463e2c401ce87858aaaebcb70ed86fb002fb5f` | Release consumed bounded replay pages. |
| `ac11bd29b03ec568f2616c78d885574eff16ad3c` | Canonical task-status mapping using the baseline task.progress envelope. |
| `bc918e74ace5dbb4fe1ce73b59d06a9ca1be9ed3` | Exact-CWD Claude skill discovery through the existing bounded workspace cache. |
| `3bf74eb6dce3e1372cfafc2ca84825f4b13bae6a` | Per-turn Claude retry/rate-limit warning continuity with the baseline raw payload. |
| `95834d68aa475a8afe4b2b14eaedffb35b590dab` | Disable executable capabilities and project configuration for Claude metadata. |
| `bc4b00666272188027d086361fa5ae01cda53bd2` | Disable Claude metadata hooks only. |
| `36c4e9cf5c0123e33d65f2af9497ee090404b532` | Force a/b prefixes for existing Git patch producers. |
| `f54ab901fa77f76eeb1e1cdfa103b9ed6f5ee4ca` | Bounded five-minute dependency-heavy worktree removal. |
| `c163d502dd32b993c03d8c20a5fae55b159bd8dc` | NUL-delimited numstat checkpoint summaries without full patch materialization. |
| `430fbd1ffc98378f6a6a41027ddc6004a79b2e7b` | Full completed-turn idle window and exact-current session freshness before reaping. |
| `47eed9face4186635488fba5f2494eddd13f6491` | Windows terminal process-tree shutdown. |
| `27e6cc27fe0f3cff53a44905e40615b7db99c80c` | Open-handle static streaming, conditional requests and manifest-bound immutable cache metadata. |
| `3bbbc1d9fd8b3d649c60ba0137c7dae93a6aab3f` | Incremental line-only terminal history deque/cache and extracted snapshot owner. |
| `cf9729d5ee9660c08556e823080d3bb19648ed28` | Byte-bounded history, chunking and UTF-8-safe file-tail restoration. |
| `89ee69e4430b21ee14565abf5c34dae43f38c1d8` | Truecolor default while respecting explicit COLORTERM values. |
| `061543e9e5b54ec0048725c37d52fef2962df173` | Bounded MCP transport/session snapshots and preview evaluate value envelope. |
| `5f878d2a85807618a4c8571cdef5daa3124672d6` | Preserve a lone native compaction marker. |
| `6866fd6b5ccff82333ad4386ce68cdec03531b68` | Stable latest-turn/checkpoint references on semantically unchanged streaming updates. |
| `e0adcc8a24db604c522282edea2823e3ef7a2bc6` | Capture checkpoints before independently queued PR refresh work; drain both lanes. |
| `dab5f6e6e02e78675655e69503aa89654e5b8050` | Defer composer draft partialization/serialization to the debounced flush. |
| `f14f41b894448298a86865c9114e6700245356e7` | Transfer prompt/image-preview ownership during draft promotion without revoking moved previews. |
| `65f1839ae82af4e67f389f23e4ccc50f51a4a83f` | Retain active visual response continuity through restored in-flight turns. |
| `3e2c1a66f74f0a45768332c360cd3682f61129e1` | Thread-error overlay placement without transcript resize/scroll. |
| `b3e1d88590489da2bb63b95c18a57e6f400b8b7f` | Lazy diff-worker creation with shared consumer leases and final disposal. |
| `887ece307131bdc853cc10f3b82067dee77c4ecf` | One mounted Markdown document and stable renderer context across streaming completion. |
| `c843c19294bcea9a4f5cf19632b135459a16d214` | Preserve post-init checkpoint capture when the pre-turn Git baseline is absent, without a false diff failure. |
| `1e740e48a5f91b3edd35c5446d33b0d36fb5a6ac` | Follow placeholder branches only in exclusive dedicated worktrees using existing expectedBranch compare-and-set. |
| `7a089b2b2449c5c146e1a7d554a31e6d55924d3f` | Capture final files after completed/tracked-aborted turns; preserve interrupted projections and retry identity. |
| `39802c06117fae0b3da43624b0d54309c5437c72` | Preserve remote installer failure output and nonzero status. |
| `311f05c8e333a9f7adfbbf5681b849888670d00a` | Pinned npm@11 runner fallback only for npm spawn NotFound. |
| `62f568b88b58e1e7cf422c21ee2e08f10977b714` | Explicit provider-instance enabled state wins over legacy metadata-writer fallback defaults. |
| `4ca71463a289e7b96b5776b6f6bbdecefe4757e4` | Revert from the first removed OpenCode assistant and respect the native message boundary on reads, repeated and zero rollback. |

The fork integration commit retains managed SSH leases/stop ownership, exact Cursor turn release,
and approved major regressions/fixture adaptations. No source identity is invented for those repairs.

## Durable checkpoint and settlement boundaries

Checkpoint capture remains in the fork's durable runtime-action infrastructure. A missing mid-turn
placeholder is no longer converted into an immutable snapshot of incomplete files. Existing queued
placeholder actions are acknowledged without capturing current files for historical state; durable
action schema, operation version and revert identity are not rewritten. Terminal completed and
tracked-aborted events capture final content, retain a reserved turn checkpoint identity on retries,
and preserve interruption state. A held PR lookup cannot block another durable checkpoint.

Settlement stays fail-closed: open PRs and failed lookups remain active, policy snapshots and live
work are rechecked inside the engine, and PR settlement requires actual merged/closed timestamps,
not generic updatedAt. No absent source-control provider, PR dashboard, PR-link schema or migration
is restored. In particular, `699f66cfe2219` open-PR inactivity behavior is intentionally not adopted.

No empty commits are created for these separate source boundaries:

- `c78f05a45e1c2b274d8b0ab2b4d2d88b4767c968` selects a live worktree CWD for sidebar PR-cache
  sharing; the fork groups by project root. No matching cache-key adaptation is claimed.
- `98a29cbaa1ccf8d8afb6d35e3e1d925ff9b5fa90` re-fetches before an absent PullRequestService
  merged PubSub event. The polling fork emits no such event; its earlier Claude slice is baseline.
- `2b96220f00de09b61327c8e881b7f509f8cc5a79` owns the TTL only, not terminal timestamps or absent
  merge-event cache invalidation.
- `19c1710a88a2c87c159d76269dacdf0b17ddd9f4` stable row behavior was assessed as retained
  equivalent behavior. No neighboring rendering hunk is attributed to it.
- `2d5464afbc19058be8c125d5ee70481d721d14f4` has no separately identified new executable-path
  hunk here. `5f4c7161fa7782ea93b63fe934d43229742e7ec8` is not credited with the later host-media
  fallback; canonical-file safety requires its own baseline proof.

## Explicit later-group exclusions

- Group 2 owns host-absolute media fallback (`a01b227d6f37d1cfed7a2f47aaace2f72ea76ce3`), its
  extension allowlist correction, signed image dimensions, citations/authority, rich Markdown/media,
  native viewed images, TerminalViewport focus repair and preview recording transfer/storage.
  Core's preview work is only the bounded MCP snapshot/evaluate slice. No new ws.ts or
  rpcAuthorization.ts slice is required by Core's async command.
- The Effect beta.107 getSetCookie compatibility patch/hash belongs to Group 2 iOS reliability and
  is absent here. Core's lockfile change is only the mirrored bundled-dev test's existing
  @vitejs/plugin-react dependency. Shared relay work only validates existing cloudflared runtime
  support; it does not restore a relay architecture.
- Group 3 owns usage/pricing, active ordering and migration 073, sparse defaults, balancing,
  onboarding and broader metadata-writer routing. Core retains the baseline raw rate-limit and
  task.progress payloads. No host-resource or usage service is imported.
- Group 4 owns official Antigravity setup/auth/install, continuation-transition contracts, new ACP
  transforms, task.updated enrichment and yauzl. Baseline legacy provider compatibility remains.
  Personal Google OAuth gates Group 4 only.

## Focused local verification

The candidate was exported from a private alternate index/object store into a standalone source
snapshot. All workspace package links resolve to that snapshot. Existing third-party dependency
links and unchanged Cartographer build output were reused; no dependency install or full workspace
suite was run. Exact Node 24.20.0 and direct local Vite+ binaries were used.

Earlier independently extracted Core gates passed nine affected package typechecks, 16 focused
server files/509 tests, 13 named package gates, runtime-owner suites and server bundling. Later
changed slices were rerun below; overlapping totals must not be added as unique tests.

| Final affected behavior | Result |
| --- | --- |
| CheckpointReactor, ProjectionPipeline, projector, pinnedRuntime, serverSettings | 5 files / 118 tests passed, including 35 checkpoint tests. |
| Shared reducer identity and interrupted projection | 1 file / 39 tests passed. |
| OpenCode adapter and native rollback boundary | 1 file / 62 tests passed. |
| SSH runner and tunnel ownership | 2 files / 20 tests passed. |
| Draft persistence, response continuity and lazy diff-worker lifecycle | 3 files / 122 selected-candidate tests passed. |
| Mounted streaming Markdown identity | 1 focused test passed. |
| Native historical queued-compaction rejection | 39 focused tests passed; native typecheck passed. |
| Final server and client-runtime typechecks | Passed after the last checkpoint/runtime batch. |
| Final web typecheck | Passed after all selected rendering changes. |
| Server bundle | Passed; 6.84 MB entry bundle. |
| Selected formatting, comment checks and lint | Passed; existing lint warnings remain, no errors. |
| Candidate diff and source-history partition | Whitespace check passed; nonempty parent chain matches the exact selected tree. |

Primary controlled web verification separately observed error placement/dismissal, restored work
continuity, a fresh task reaching a completed response with an available composer, and reload
retention. Mounted component identity is demonstrated by its regression, not inferred from a
screenshot. Verification servers/browser were closed after the pass.

No fresh frozen-lockfile installation is claimed: reused dependencies include the combined tree's
installed Effect compatibility guard, although that patch is not part of Core. No full workspace
suite, hosted CI, real native-provider context shrink, complete Electron/iOS acceptance, personal
Google OAuth, or live title-generation/provider execution is claimed. A separate isolated title
fixture could not launch its required Node 24.21 runtime. Those limits do not turn local tests into
external acceptance evidence.

## Publication handoff

Preparation preserves the dirty integration checkout, its ordinary index, baseline HEAD and shared
refs. Publication must import only the reviewed private objects, create the new
`sync/t3-core-reconciliation-20260909` ref with an absent-ref guard, then use a normal non-force push.
Do not check out, reset, rebase or squash the shared integration worktree. Review the containing
commit's actual diff and hosted checks before any separately authorized merge. The other three
groups remain independent follow-up publication work.
