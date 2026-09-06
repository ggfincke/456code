<!-- .plans/t3-nightly-reconciliation-20260904.md -->
<!-- maintain the frozen 468-commit t3 reconciliation and checkpoint record -->

# Revised T3 reconciliation, including official Antigravity ACP

## Status and authority

This is the maintained implementation source of truth approved on 2026-09-04. Work proceeds one
group at a time. Each group still receives a verified checkpoint and ledger receipt, but the user's
2026-09-04 continuation approval waives routine per-group pauses and authorizes the planned
source-attributed commit, PR, green-CI, merge-commit, and exact merged-main verification sequence.
Work must still stop for a material scope or behavior change, unavailable required gate, external
authority beyond this plan, or Group 12's human personal-Google OAuth actions. Approved integrated
gates may issue and consume pairing credentials only inside their run-owned disposable state. Use
only the plan's existing `sync/` branches; do not create `codex/` reconciliation branches.

Current state:

- Published `main`: `9a797692a24ad2d2df2ff8e6691f6fb0ef883709`.
- Published predecessor: original Group 1, sources `c78ae50a5`, `2a7a449cc`, `f90e2f2bd`, and
  `d2042d288`, merged through PR #91. Its four source-attributed fork commits and the merge commit are
  recorded in the ledger; PR and merged-main CI were green.
- Published Group 01: [PR #92](https://github.com/ggfincke/456code/pull/92) merged through merge commit
  `8e1785e6ca5ee582d9ad910a338d333760e2aca2`. Exact merged-main CI run
  [33941082381](https://github.com/ggfincke/456code/actions/runs/33941082381) passed with 15 successful
  jobs and the intentional mobile-native-static skip.
- Published Group 02: [PR #93](https://github.com/ggfincke/456code/pull/93) merged through merge commit
  `e831f6cf51c01d31952b0de06c29a55b9bad9b80`. Exact merged-main CI run
  [33945024714](https://github.com/ggfincke/456code/actions/runs/33945024714) passed with 15 successful
  jobs and the intentional mobile-native-static skip.
- Published Group 03: [PR #94](https://github.com/ggfincke/456code/pull/94) merged through merge commit
  `f02d28b6323d02b2802d06d6aea0c7f3205e81d3`. Exact merged-main CI run
  [33950331362](https://github.com/ggfincke/456code/actions/runs/33950331362) passed with 15 successful
  jobs and the intentional mobile-native-static skip.
- Published Group 04: [PR #95](https://github.com/ggfincke/456code/pull/95) merged through merge commit
  `dcaba8bda6991f08568453ef0581a54394a3eafe`. Exact merged-main CI run
  [33956661399](https://github.com/ggfincke/456code/actions/runs/33956661399) passed with 15 successful
  jobs and the intentional mobile-native-static skip.
- Published Group 05: [PR #96](https://github.com/ggfincke/456code/pull/96) merged through merge commit
  `41c357f8967e8ec8c78b41f3c755c6fdb7669116`. Exact merged-main CI run
  [33962109060](https://github.com/ggfincke/456code/actions/runs/33962109060) passed with 15 successful
  jobs and the intentional mobile-native-static skip.
- Published Group 06: [PR #97](https://github.com/ggfincke/456code/pull/97) merged through merge commit
  `023572c63f64a0d7e226e11ee369fd1f6c52b346`. Exact merged-main CI run
  [33965498899](https://github.com/ggfincke/456code/actions/runs/33965498899) passed with 15 successful
  jobs and the intentional mobile-native-static skip.
- Published Group 07: [PR #98](https://github.com/ggfincke/456code/pull/98) merged through merge commit
  `9a797692a24ad2d2df2ff8e6691f6fb0ef883709`. Exact merged-main CI run
  [33973168375](https://github.com/ggfincke/456code/actions/runs/33973168375) passed with 15 successful
  jobs and the intentional mobile-native-static skip.
- Active group: **08 — OpenCode lifecycle follow-ups**, implementation and integrated verification
  accepted; cleanup and publication remain.
- Active branch: `sync/t3-r08-20260904`, based on published `main`.
- Active worktree: `/Users/ggfincke/Projects/Experiments/456code-t3-nightly-20260903`.
- Groups 09-27 are approved as plan scope but remain planned, not implemented. Their branches are
  `sync/t3-rNN-20260904`, each created only from the preceding green merged `main`.
- The exact source inventory is [the 468-row ledger](./t3-nightly-reconciliation-20260904-ledger.md).

## Frozen upstream universe

The reconciliation universe is fixed and must not grow silently:

1. 244 previously audited commits, exclusive of
   `053affbed2659f90cd1b1efaaa7a75865c4131c7` through inclusive
   `fff33f9e851912363c5b1f3ac65598be35eb5f0d`.
2. 224 newer commits, exclusive of
   `fff33f9e851912363c5b1f3ac65598be35eb5f0d` through inclusive
   `82f64cd8d046ab4ee8588f7bcbc1e66a4a0c80fe`.
3. Total: 468 distinct upstream commits. Official Antigravity foundation `06336460c` is row 239 in
   the previously audited first range and is therefore included, not an extension.

The initial ledger records exact API-derived commit order, full SHA, first-line title, source author,
and original author date. Per-commit touched paths remain deliberately pending until semantic
classification; the GitHub compare endpoint does not expose commit-local paths and 468 individual
commit downloads are not required for the inventory checkpoint. A title is never evidence of
equivalence, inapplicability, or implementation.

After Group 02's exact merged-main gate, the verified `upstream` URL fetched only frozen cutoff
`82f64cd8d046ab4ee8588f7bcbc1e66a4a0c80fe` into `FETCH_HEAD` with `--no-tags` so later groups can
inspect complete source objects. `upstream/main` remained exactly
`fff33f9e851912363c5b1f3ac65598be35eb5f0d`; no upstream branch, tag, or newer intake moved.

After all accepted groups are merged, refresh upstream/nightly refs and report every commit after
`82f64cd8d046ab4ee8588f7bcbc1e66a4a0c80fe` as a separate unapproved range. Do not add those commits
to this plan or ledger without a new decision.

## Working and preservation rules

- Preserve the clean original checkout and all unrelated dirty, staged, untracked, ignored,
  credential-bearing, worktree, branch, process, simulator, installation, and cache state.
- Use only worktree-local dependencies, caches, runtime state, and disposable fixtures. Never link
  dependencies or mutable cache state back to the original checkout.
- Re-ground HEAD, source SHAs, status manifests, ignored state, process ownership, dependency/cache
  ownership, and applicable repository instructions before each group.
- Manual adaptation is required. Do not wholesale merge or cherry-pick upstream architectures.
- At most three non-overlapping implementation workers may be active. Sol owns implementation,
  tests, and focused reviews: high reasoning for bounded work and xhigh for contracts, persistence,
  provider lifecycles, authentication, and final integration. Luna may supply bounded source context.
- Read repository, Effect, React, and comment guidance before touching applicable owners. Effect work
  also requires `.repos/effect-smol/LLMS.md` and relevant vendored examples. Do not edit `.repos/`.
- Tests remain under the mirrored root `tests/` tree. Add only the major regressions approved here.
  Do not add coverage tooling, `react-test-renderer`, trivial formatting/pass-through tests, exhaustive
  coverage, or unrelated cleanup.
- Terminate only group-owned processes and remove only run-owned disposable state. Never download or
  erase simulator runtimes.

## Original-to-revised group mapping

| Original group | Revised destination | Continuity requirement |
| --- | --- | --- |
| 1 | Published predecessor, before revised numbering | Already merged in PR #91; retain its four rows and evidence. |
| 2 | 01 | Finish the existing service/Git/text safety diff before new intake. |
| 3 | 05 | Carry bounded projection replay behavior forward. |
| 4 | 07 | Carry provider reliability behavior forward. |
| 5 | 09 | Carry streaming correctness and memory bounds forward. |
| 6 | 10 | Carry Claude skill dispatch behavior forward. |
| 7 | 11 | Carry workspace-specific discovery behavior forward. |
| 8 | 17 | Carry assistant-media behavior forward. |
| 9 | 18 | Carry citations and artifacts behavior forward. |
| 10 | 21 | Carry iOS files, review, and navigation behavior forward. |
| 11 | 27 | Carry server-owned settlement behavior forward. |
| 12 | 04 | Carry desktop preview recovery behavior forward. |

## Ordered implementation groups

“Conditional” means reproduce or measure the remaining fork-specific problem first. Port only
demonstrated missing behavior. If the fork is already sufficient or the candidate is inapplicable,
record the evidence and disposition without manufacturing an empty adaptation commit.

### Safety and runtime foundations

| Group | Sources | Required behavior and principal gate |
| --- | --- | --- |
| **01 — Finish service/Git/text safety** | `a81a52afb`, `0e77fbd3d`, `60f2ce027` | Repair service rollback ownership, nullable snapshots, retry delay, and stale-cleanup fixtures. Preserve local-only worktree bases and contained root instruction reads. Rerun focused service, Git, generated-text, and isolated-web gates. No new intake enters this diff. |
| **02 — Authentication and privacy** | `9d28c21a2`, `eb77683e5`, `b6f72681d` | Remove pairing secrets from routine read models; transactionally replace only desktop-bootstrap sessions; prevent private-host disclosure through third-party favicons. Test rollback, session isolation, snapshot consumers, and private/public hostname behavior. |
| **03 — iOS persistence safety** | `7839140e5` | Preserve drafts/outbox state across read failures, expose failures, retry safely, and protect attachment ownership. Use storage fault injection and an iPhone recovery pass. |
| **04 — Desktop preview recovery** | `19c97ea56`, `6319a9714`, `b5fb3fba0`, `098bf5329` | Pin debugger ownership, isolate preview shortcuts, preserve explicit navigation URLs, and bound native capture to five seconds. Decode returned PNG data locally without an asynchronous network conversion. Keep annotations when screenshots fail, settle picks exactly once, and fence replacements. Verify in real Electron. |
| **05 — Bounded projection replay** | `7e460f429`, `a9ffb8279`, `9a7b1e21e`, `b17cc3d1b`, `e86604d33`, `50bfca43d` | Enforce 1,000-row/8 MiB replay limits, thread-specific aggregate reads, incremental CRLF-safe scanning, 25-ID hydration batches, active-session-only binding reads, selective activity hydration, and append-without-read message updates. Test snapshot fallback, recreation, ordering, and terminal content. |

### Provider and streaming correctness

| Group | Sources | Required behavior and principal gate |
| --- | --- | --- |
| **06 — Projection/query efficiency** | `8ac546292`, `2263e13fd`, `dffb4cd3b`, `6365919f2`, `dddc0bdcb` | Replace unnecessary history/body reads with bounded summary queries, batch cursor writes, consolidate buffered-event reads, and retain useful sanitized SQLite conditions. Assert query counts, transaction behavior, and unchanged projections. |
| **07 — Provider reliability** | `fc262f1a2`, `f86c5e8c8`, `994bd7373`, `b7d6e6502`, `a5bbad910`, `bfef973d9`, `75ab5ab3f`, probe slice of `98a29cbaa` | Preserve three-attempt title generation, safe Claude probes, and exact Cursor flags. Repair runtime-event parity, Claude fallback notices, authoritative Codex catalog refresh, and rate-limit resume decoding. Optional probe failures must not erase successful capability discovery. |
| **08 — OpenCode lifecycle follow-ups** | selected `d2b6f3b92`, `01f3e50ec`, `f2e3764c2`, `c8f77e0d4`, `ec8b2119c` | Repair approval acknowledgement, event-pump, cancellation, and stop behavior. Remove only demonstrated unused retained tool data/log repetition. Preserve startup fencing, inventory retention, output bounds, and supervised permissions. |
| **09 — Streaming correctness and memory bounds** | `7e4ce3bbb`, client slice of `c2283ce14`, `355fbd96d`, `108f295cc`, `44dc8ae25` | Coalesce at 50 ms/512 tool updates without delaying boundaries. Share a 1,000-item/8 MiB budget across queued, coalesced, and ACK-in-flight data. Add caller-owned O(1) append indexing with safe reconciliation fallbacks and stable web/iOS references. Verify slow clients, reconnect, duplicates, ordering, and terminal replacement. |
| **10 — Claude skill dispatch** | `ea71a19d4`, `18573d60a`, `82f64cd8d` | Preserve enabled/user-invocable selection, unknown mentions, prefixes, attachments, and final slash-command placement. Support digit-leading skill names without treating currency as skills. Verify web and iPhone composers. |

### Workspace discovery and Antigravity

| Group | Sources | Required behavior and principal gate |
| --- | --- | --- |
| **11 — Workspace-specific discovery** | `80a14b658`, `15fea6c5f`, `2152d44de`, `087cfb8ae` | Add authorized exact-CWD snapshots, 16-entry caches, 20-second bounded probes, deduplication, generation fencing, and failure retention. Keep workspace results out of machine snapshot persistence. Verify two-project switching and failed-probe fallback. |
| **12 — Official Antigravity vertical slice** | `06336460c`, `e01c153c1`, `f25e44289`, `eb334ca57`, `8ea52c8f2`, `d487dfbf4`; install gate `912276bcd` | Land managed runtime, personal OAuth, official execution, minimum setup UI, and explicit legacy-session transition atomically. Include known sign-in/startup fixes before enabling the replacement. Use the detailed contract below. |
| **13 — Antigravity catalogs and discovery** | `baf67b6e3`, `0aae1e2ad`, `2120fbc18`, `ef4cc6085` | Consume live account-model updates, including authoritative empty catalogs; retain valid catalogs after failed probes. Add legacy skill-directory precedence, setup-status deduplication, and iOS driver/icon normalization. Reuse Group 11's workspace cache. |
| **14 — Antigravity subagents** | `f8a14b28f`, `2675e3c70` | Adapt native child-tool calls/results and batch lifecycle together. Preserve active batches after launch, handle late/historical updates, and avoid duplicate or premature terminal rows. Verify web/iOS presentation and stop/reconnect behavior. |
| **15 — Custom model names/options** | `5a433244d` | Keep legacy slug arrays and add rich metadata through existing instance configuration/model snapshots. Extend supported provider owners instead of importing the absent upstream Claude catalog architecture. Verify old-client compatibility and web/iPhone model selection. |

### Client behavior and provider features

| Group | Sources | Required behavior and principal gate |
| --- | --- | --- |
| **16 — Rendering and draft performance** | `dab5f6e6e`, `b3e1d8859`, `887ece307`, `19c1710a8`, `3e2c1a66f`, `65f1839ae`; conditional `c7c1dfe4d` and mobile slice of `5f878d2a8` | Defer expensive serialization/worker initialization; repair demonstrated Markdown mounting, restart continuity, and layout shifts. Reuse the current timeline architecture. Require identity/reconnect regressions and profiling evidence before extra caching or animation work. |
| **17 — Assistant media** | `c0e09f323`, `8f525af5a`, `652515a34`, applicable `8bd544cdf`, `db8d60f48`, `61a91b6ef`, `c0ebc882b`, `15eda897d`, `09b81a349` | Resolve authenticated workspace images, render produced/viewed images without duplicate tool rows, support keyboard expansion and composer-focus restoration, and avoid unnecessary historical asset requests. Verify successful and failed images on affected clients. |
| **18 — Citations and artifacts** | `c1e70b5f8`, `e7deb2aaf`, `77e35c561` | Implement strict directive parsing, provenance-bound citations, artifact actions, selection/comment/edit/undo, clipboard/draft/stash persistence, and Cmd+Enter delivery. Preserve 8,000-character/32-context-line bounds, UTF-16 offsets, and quoted-data expansion. Verify web send and iPhone rendering. |
| **19 — Codex asynchronous questions** | `d76b24dd1` | Support explicit valid async-question payloads without pausing the active run. Retain unresolved requests durably; atomically resolve answers, append the human message, and start the response turn. Test restart, eviction, duplicate/concurrent responses, and continued streaming. |
| **20 — Manual context compaction** | `c5ba51d62` | Complete native/provider dispatch and iOS controls using existing compaction states and richer summaries. Serialize against starts/sends/stops, bound waits, recover failures, preserve ownership, advertise only supported commands, and require exact attachment/context-free `/compact`. |

### Native UX, operational follow-ups, and settlement

| Group | Sources | Required behavior and principal gate |
| --- | --- | --- |
| **21 — iOS files, review, and navigation** | `9159b808d`, `2aa907b19`, `3b6be3ef4`, `d6e29dc9d`, `777f5bb2e`, `77b655c47`, `80b53730d` | Add long-press copy/open, explicit preview failure/retry states, and stale-result fencing. Bound review highlighting/cache retention, reuse comment-independent diff work, initialize highlighting lazily, and repair edge-swipe behavior. |
| **22 — Web interaction correctness** | `8faf031c2`, `896fe82f2`, `14bf3f6d1`, `4f1092cec` | Preserve POSIX path case, picker focus/shortcut ownership, single-stash restoration, and origin-worktree preference availability. Adapt current split components; do not restore upstream's resting composer. |
| **23 — Git/workspace/executable follow-ups** | applicable `36c4e9cf5`, `f54ab901f`, `c163d502d`, `4e547318b`, `fce850845`, `f33fdc992`, `2d5464afb` | Preserve patch prefixes, allow large worktree removal, avoid full checkpoint patches, refresh newly opened PR state where missing, report missing CWD clearly, and preserve resolved executable paths. Skip slices already covered by fork turn-completion refresh. |
| **24 — Terminal history bounds** | `3bbbc1d9f`, `cf9729d5e` | Maintain incremental, UTF-safe, byte-bounded history through the existing xterm backend. Do not import Ghostty rendering or snapshot code. |
| **25 — Static assets and file guards** | applicable `27e6cc27f`, `781f41ef1`, `5f4c7161f` | Stream/cache static assets and repair demonstrated theme/media path inconsistencies. Preserve symlink refusal, containment, authentication, and platform behavior; do not add absent services. |
| **26 — Development/runtime tooling** | applicable `6f405370c`, `c3caceade`, entrypoint slice of `f96a220b5` | Repair bundled-dev reload behavior, deduplicate PATH probes without case folding, and use platform-correct entrypoint URL handling. Exclude unrelated workflow/runner changes. |
| **27 — Server-owned settlement** | `f32f9a2f4`, `2971ec320`, applicable `c78f05a45`, `2b96220f0`, merge-confirmation slice of `98a29cbaa` | Move policy to server settings and serialized sweeps using qualifying activity timestamps and stale-snapshot guards. Keep open-PR threads active. Preserve pin/snooze precedence and every liveness exclusion. Do not add migration 073 or the absent PR dashboard/service. |

## Carried-forward contracts from the original plan

The revised group table changes sequencing, not the already-approved behavior. The following
contracts remain mandatory where the compact table omits their details.

### Projection replay and streaming

Group 05 keeps full and shell subscription snapshot fallback, recreation ordering, CRLF-safe
incremental activity scanning, 25-ID hydration batches, role/order preservation, and terminal
replacement while appending messages without a history read. For `c2283ce14`, the existing server
append slice remains the accepted fork counterpart and is not ported again; only its still-missing
client slice enters Group 09.

Group 09 keys coalescing by tool-call ID. The 50 ms window never delays lifecycle, status, error,
terminal, or sync boundaries, and queued, coalesced, and ACK-in-flight state share one 1,000-item/8
MiB limit. Caller-owned append indexes remain O(1) in the normal case but must safely invalidate or
reconcile on duplicates, out-of-order delivery, replacement, or a missing reference.

### Skill and workspace discovery

Group 10 retains optional `userInvocable` and `userInvocationOnly` fields. Only enabled, discovered,
user-invocable skills activate `$` mentions; unknown mentions remain literal. Earlier recognized
mentions stay inline, while the final recognized invocation is placed in final text. Skill images
precede final text without dropping generic attachments or surrounding prefixes.

Group 11 authorizes exact-CWD discovery only, with a 20-second probe bound, a 16-entry cache,
deduplication, and generation fencing. A failed workspace probe retains both the machine snapshot and
the last valid workspace result; workspace data never leaks into machine snapshot persistence.

### Media, citations, and native previews

Group 17 treats malformed, escaped, or missing image references as visibly failed and
non-executable. Keyboard and pointer expansion restore composer focus, and lifecycle folding renders
one image without a duplicate tool row.

Group 18 uses the `AssistantCitationV1` ownership boundary and binds citations to environment,
thread, and message provenance. Text and comments remain capped at 8,000 characters, selections use
UTF-16 offsets, and quoted context expands to at most 32 lines. Malformed directives render literally;
artifact prompts append once; clipboard, draft, stash, and modifier behavior remain durable; the
server owns validation and quoted-data expansion.

Group 04 bounds native screenshot capture to five seconds. Returned PNG data is decoded synchronously
and locally, eliminating the renderer's network-backed conversion wait. A failed screenshot may emit
`screenshotFailed` while preserving a structured annotation without crop data, unlocking the composer,
and notifying the user. Picks settle exactly once and teardown on timeout, navigation, destruction,
replacement, cancellation, or success; replacement identity fences late results.

### iOS file state and server settlement

Group 21 keeps explicit loading, disconnected, failed, and retry states. Every request carries an
identity fence so a late file, review, or navigation result cannot replace a newer selection.

Group 27 defaults settlement to three days with merge settlement enabled, advertises the optional
capability with a legacy-client fallback, and serializes one-minute/settings-triggered sweeps. It
excludes archived, keep-active, pending-approval/input, queued-turn, active/starting-session,
background-liveness, and open-PR threads. Qualifying activity and `settledAt` have distinct freshness
semantics; explicit settle clears pin state, derived settlement preserves pin/snooze precedence, and
snapshot generations fence stale sweeps. No migration 073 or unsafe client-preference migration is
introduced.

## Official Antigravity replacement contract

Retain one provider and the existing `antigravity` driver and instance IDs. Official ACP replaces all
future CLI execution; no dual backend is maintained. Pin the reviewed Google Antigravity ACP 1.1.1
distribution from Google's published archives with source-recorded hashes and sizes. It is distinct
from the `agy` CLI and must not float during implementation. The source manifest is
<https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json>.

Group 12 must land these boundaries together:

1. **Managed runtime ownership.** Validate download size/hash, exact archive members, member paths,
   types and extracted sizes, executable/harness pairing, supported platforms, and ACP initialization
   identity. Activation is atomic; cleanup is cancellation-safe; processes are leased; a failed new
   version rolls back to the previous version. Add only the required ZIP reader and its types.
2. **Personal OAuth only.** Use isolated per-instance profiles and official `oauth-personal`. Scrub
   inherited auth variables. Sign-in URLs are disclosed only to the initiating client session. Validate
   OAuth URLs, state, and callbacks; redact errors. Do not add API-key fields, credential import,
   GCP/business setup, or paid fallback. Student-account entitlement remains a live sign-in result,
   never a mocked claim. Google documents personal OAuth for individual Free/Pro/Ultra plans at
   <https://antigravity.google/docs/ide/extensions/zed>.
3. **Settings preservation.** Add `officialRuntime?: { mode: 'managed' } | { mode: 'custom';
   executablePath: string }` inside instance configuration; omission means managed ACP. Preserve legacy
   `binaryPath`, `agent`, `sandbox`, and configured model strings without forwarding incompatible CLI
   settings to ACP. Label them as legacy. Do not uninstall or alter `agy`.
4. **Explicit session transition.** Preserve historical `antigravity.stream-json` decoding and old
   transcripts. New continuations use `{ source: 'antigravity.official-acp', schemaVersion: 1,
   sessionId }`. A legacy cursor returns a typed incompatibility and is never sent to ACP. A confirmed
   **Start fresh with official Antigravity** action clears only the continuation binding via a durable
   command/event; history, files, attachments, and instance identity remain.
5. **Truthful runtime capabilities.** Use account-advertised models and supported permissions,
   questions, attachments, MCP, and filesystem operations. Contain filesystem access and mediate it by
   permission. Refuse unsupported rollback before modifying files. Do not synthesize native child
   relationships or custom-model capabilities.

Group 12 includes the minimum web/iOS setup and transition UI needed for immediate use. iOS controls
the server-side runtime; no runtime is downloaded to the phone.

The live gate requires a human personal-Google sign-in, real model response, tool permission and
question handling, cancellation, official-session resume across restart, legacy-session transition,
and logout using disposable profiles. A failed login, unavailable entitlement, or unavailable native
gate is reported as unavailable; mocks cannot replace this receipt.

## Other compatibility contracts

- **Pairing:** credentials exist in creation results only, never routine access snapshots, lists, or
  change events. Consumers change together; no obsolete secret-bearing reader is retained.
- **Custom models:** keep legacy settings and `config.customModels` as `string[]`. Add optional
  slug-keyed `config.customModelMetadata` for names/capabilities. Existing model snapshots publish the
  display metadata. Removed slugs cannot leave orphan active overrides. Antigravity stays account-driven.
- **Async questions:** extend pinned Codex generator overrides and optional runtime metadata. Only
  explicit valid async payloads activate the path; malformed/unknown forms remain ordinary messages.
  Blocking questions retain their current flow.
- **Compaction:** reuse current states, summaries, capabilities, and command routing. Unsupported native
  operations remain visible and recoverable; do not silently fall back to another execution mode.
- **Settlement, citations, workspace snapshots:** retain previously approved bounded schemas,
  capability/version-skew behavior, authorization, sparse persistence, and ownership. No new database
  migration is planned.

## Group 01 detailed checkpoint contract

### Scope lock

Only source adaptations for `a81a52afb`, `0e77fbd3d`, and `60f2ce027`, their approved major tests,
the two existing service/source-control docs, these maintained plan and ledger docs, and directly
required fixture repairs may enter the current diff. No later group, drive-by cleanup, dependency
change, generated output, commit, or external mutation is authorized.

The currently modified manifest is limited to service lifecycle, Git/VCS, generated-text prompt,
server transport fixture, focused tests, the two related service/source-control docs, and these two
maintained `.plans/` docs. Every pre-existing path is preserved until the primary owner reconciles the
final manifest.

### Five authorization dimensions

| Dimension | Group 01 authorization |
| --- | --- |
| Source edits | Approved only for service rollback ownership and retry semantics; nullable service snapshots; stale cleanup fixtures; local-only worktree/base resolution; contained root-instruction reads; and directly coupled Git/VCS/text owners plus the two existing service/source-control docs and these maintained plan/ledger docs. |
| Generated outputs | **None.** No generator or generated artifact is approved for this group. |
| Hand-written tests | Major regressions for rollback ownership, nullable snapshots, retry delay, stale cleanup, local-only bases, contained root-instruction reads, and existing server transport consequences. Tests stay in mirrored root `tests/`; no unrelated expansion. |
| Existing verification | Focused service, Git/VCS, generated-text, and server tests; affected package type/build checks; changed-file format/lint/header checks; dependency consistency; `git diff --check`; then one isolated authenticated `test-t3-app` pass for the affected web-visible flow. No workspace-wide suite. |
| Git and external actions | **None until the user approves the verified checkpoint.** Leave all changes unstaged and uncommitted. No push, PR, merge, branch deletion, ref refresh, release, deployment, non-disposable credential mutation, or non-disposable environment change. The isolated web gate may issue and consume pairing credentials only in its run-owned disposable base directory. |

### Acceptance criteria

1. A failed service replacement rolls back only installation state created or taken over by that
   attempt; it never removes/restores state owned by another installation or newer process. A
   requested `--allow-downgrade` is checked before stopping the current service and again before
   activation, so a forbidden downgrade cannot create an outage.
2. Snapshot absence is represented and handled as nullable state without turning cleanup, status, or
   rollback into an unsafe broad delete. Unknown legacy installation state stays repairable. Retry
   delay is bounded and observable in the focused fixture.
3. Stale cleanup tests use explicit owned identities and cover success, failure, and ownership-loss
   behavior without relying on ambient host service state.
4. Git/VCS worktree base selection uses the matching remote branch only when that branch is actually
   advertised by the selected remote; otherwise it preserves a valid local-only base without crossing
   into the original checkout or an unrelated registered worktree.
5. Generated-text discovery reads only contained regular root `AGENTS.md` files, plus root
   `CLAUDE.md` only for Claude generation. Each file is capped at 20,000 bytes and the prompt includes
   at most 20 recent non-merge subjects; nested instructions, symlinks, and paths above/outside the
   authorized workspace root are excluded.
6. Existing compatible behavior remains intact: no later-group intake, no secret exposure, no added
   cloud/Relay/Connect boundary, and no change to source attribution or publication state.

### Checkpoint evidence to append

Before asking for approval, append the exact final HEAD/branch, staged and unstaged manifests,
source-adaptation notes, commands and results, changed-file statistics, dependency/cache ownership,
process cleanup, integrated screenshots/recordings or an explicit unavailable gate, and outstanding
risks. The primary agent must confirm all changes are unstaged and uncommitted and then stop.

Current receipt: **verified and approved for publication on 2026-09-04.** The evidence below preserves
the pre-publication checkpoint exactly.

#### Final state and manifest

At the checkpoint, `HEAD` remained published `main` commit
`b58e8c7088ba1330f7fdf14a56430d02f2174442` on
`sync/t3-git-service-text-safety-20260903`. The index is empty. The checkpoint contains 16 modified
tracked files plus these two untracked maintained plan documents; the tracked diff is 2,787 insertions
and 394 deletions. No dependency or lock manifest changed.

```text
 M apps/server/src/cli/service.ts
 M apps/server/src/git/GitManager.ts
 M apps/server/src/git/GitWorkflowService.ts
 M apps/server/src/service/bootService.ts
 M apps/server/src/textGeneration/TextGenerationPrompts.ts
 M apps/server/src/vcs/GitVcsDriver.ts
 M apps/server/src/vcs/GitVcsDriverCore.ts
 M apps/server/src/ws.ts
 M docs/integrations/source-control-providers.md
 M docs/user/background-service.md
 M tests/apps/server/cli/service.test.ts
 M tests/apps/server/git/GitManager.test.ts
 M tests/apps/server/server.test.ts
 M tests/apps/server/service/bootService.test.ts
 M tests/apps/server/textGeneration/TextGenerationPrompts.test.ts
 M tests/apps/server/vcs/GitVcsDriverCore.test.ts
?? .plans/t3-nightly-reconciliation-20260904-ledger.md
?? .plans/t3-nightly-reconciliation-20260904.md
```

#### Source adaptations

| Source | Fork adaptation and evidence |
| --- | --- |
| `0e77fbd3d0d79eec5247e75583a04590a1785133` | Adapted the upstream service replacement into the fork's service/lease owners. Rollback and lock closure cover typed failure, defect, and interruption; activation handoff and prepared-unit registration close their cancellation gaps; downgrade permission is rechecked before stop and activation; nullable/unknown legacy snapshots remain repairable; lock retry is an interruptible 50 ms delay; unsupported hosts fail before mutation. |
| `a81a52afbb4e03ba82b2743801772151ed8c7d70` | Adapted worktree bootstrap to query the selected remote's advertised branch with `ls-remote`, exact-fetch that branch, and fall back locally when the remote or branch is absent. Remote-qualified `origin/main` is normalized to local `main` only while the origin preference is enabled; disabling the preference preserves the selected tracking ref. Transport failures stay typed and sanitized. |
| `60f2ce0279d524bd70a573f6e0b6e9fab56e4b3e` | Adapted generated source-control policy to the fork's text-generation boundary. Only contained regular root `AGENTS.md` is shared; root `CLAUDE.md` is added only for a resolved Claude writer. Each file is limited to 20,000 bytes, history to 20 recent non-merge subjects, and the combined policy section to 44,000 characters. Nested, directory, FIFO, oversized, and escaping symlink inputs are excluded. |

#### Automated verification

All commands used Node 24.20.0 through `mise x node@24 --`. The service owner ran
`pnpm exec vp test run cli/service.test.ts service/bootService.test.ts` from `apps/server`: two files,
52 tests passed. The Git/text owner ran
`pnpm exec vp test run git/GitManager.test.ts server.test.ts textGeneration/TextGenerationPrompts.test.ts vcs/GitVcsDriverCore.test.ts`
from `apps/server`: five files, 262 tests passed in 54.53 seconds. No full workspace suite ran.

`pnpm run typecheck` from `apps/server` passed after the final remote-qualified-base repair. It rebuilt
the worktree-local `@t3tools/cartographer-core` output and completed `tsc --noEmit` with exit 0; only
pre-existing repository suggestion diagnostics were printed, with no type errors.

The final static commands were:

```text
pnpm run fmt -- --check --staged apps/server/src/git/GitManager.ts apps/server/src/git/GitWorkflowService.ts apps/server/src/textGeneration/TextGenerationPrompts.ts apps/server/src/vcs/GitVcsDriver.ts apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/ws.ts docs/integrations/source-control-providers.md tests/apps/server/git/GitManager.test.ts tests/apps/server/server.test.ts tests/apps/server/textGeneration/TextGenerationPrompts.test.ts tests/apps/server/vcs/GitVcsDriverCore.test.ts .plans/t3-nightly-reconciliation-20260904.md .plans/t3-nightly-reconciliation-20260904-ledger.md
pnpm exec vp lint --report-unused-disable-directives apps/server/src/git/GitManager.ts apps/server/src/git/GitWorkflowService.ts apps/server/src/textGeneration/TextGenerationPrompts.ts apps/server/src/vcs/GitVcsDriver.ts apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/ws.ts tests/apps/server/git/GitManager.test.ts tests/apps/server/server.test.ts tests/apps/server/textGeneration/TextGenerationPrompts.test.ts tests/apps/server/vcs/GitVcsDriverCore.test.ts
pnpm run comments:check -- apps/server/src/git/GitManager.ts apps/server/src/git/GitWorkflowService.ts apps/server/src/textGeneration/TextGenerationPrompts.ts apps/server/src/vcs/GitVcsDriver.ts apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/ws.ts docs/integrations/source-control-providers.md tests/apps/server/git/GitManager.test.ts tests/apps/server/server.test.ts tests/apps/server/textGeneration/TextGenerationPrompts.test.ts tests/apps/server/vcs/GitVcsDriverCore.test.ts .plans/t3-nightly-reconciliation-20260904.md .plans/t3-nightly-reconciliation-20260904-ledger.md
node scripts/check-directive-preservation.ts HEAD
git diff --check
```

Formatting, comment/header, directive-preservation, and tracked/untracked whitespace checks passed.
Lint exited 0 with six pre-existing unused-import warnings in `GitManager.ts`; no new warning was
introduced. The service owner separately reported own-file format, lint, comment, and diff checks
green.

#### Integrated browser evidence

The primary owner used one authenticated disposable `test-t3-app` environment at
`http://127.0.0.1:5733`, backed by `/tmp/t3code-group01-web.mnbtwM`, with a deterministic Gemini
wrapper under the ignored Group 01 fixture directory. A one-time pairing credential was issued and
consumed only in that disposable state.

With **Start from origin** enabled and local-only base `d8e7d9766bb7ce04afdf952af6435f711b6c5b2a`
selected, the UI created branch `456code/bounded-local-base` at exactly that commit in
`/private/tmp/t3code-group01-web.mnbtwM/worktrees/repository-824f1979/456code-eef4b45a`; remote
`origin/main` remained `9801dcf14cfd7494d3ba70504c24c7be1b130698`. This proves the remote
preference does not replace a valid local-only base.

The real source-control UI then created disposable fixture commit
`039995434f9f7696fa9e80dc30fd87085854b1f8` with subject `Use bounded local base` and body
`Follow the disposable repository instructions.` The operator used the **Commit only** action; no push
occurred. The captured Gemini prompt contained the repository-conventions policy, recent subject
`Initialize browser acceptance fixture`, the root `AGENTS.md` marker and staged summary/patch, and no
`CLAUDE.md` marker.

The optional mock chat initially recorded two honest fixture-model rejections for `auto` and `default`:
the shared mock advertises only `grok-build` and `grok-mock-alt`, so the Gemini adapter correctly
refused unadvertised models. After selecting advertised `grok-build`, a follow-up in the created
worktree accepted **Approve once**, displayed `Approval accepted by provider`, completed as **Worked
for 10s**, and rendered terminal assistant text `hello from mock`. The primary owner's native inline
CUA screenshot at approximately 22:33 EDT shows the correct branch, approval result, terminal text,
and the two earlier fixture failures. The capture API returned no standalone screenshot path.

#### Preservation, cleanup, and remaining risk

The original checkout remains clean at `b58e8c7088ba1330f7fdf14a56430d02f2174442`; its cache mtimes
remain `.vite=1784948790` and `.vite-temp=1788016177`. The concurrent unrelated worktree
`/Users/ggfincke/Projects/Experiments/456code-cartographer-review-20260904` on
`codex/cartographer-integration-review-20260904` was not touched. Worktree-local dependencies and
caches were used, and package/lock manifests remain unchanged.

Cleanup receipt: retained web/backend session `45181` was stopped, leaving ports 5733 and 13773 with
no listeners. Only `/tmp/t3code-group01-web.mnbtwM`, the ignored
`.456code/group01-browser.XCkfwL` fixture, and `/tmp/group01-env-body` plus
`/tmp/group01-auth-body` were moved to the user's Trash, so the removed disposable evidence remains
recoverable until Trash is emptied. No other process or path was cleaned.

Outstanding risk is bounded to integration realism: service replacement was verified through focused
fixtures rather than a mutation of a real host service, source-control generation used a deterministic
Gemini wrapper rather than external credentials, and the only visual artifact is the native inline
capture. No provider credential, source-control remote, unrelated worktree, branch, simulator,
installation, or non-disposable setting was changed.

#### Publication authorization and local commit map

The user approved Group 01 publication and continuous execution of the remaining ordered groups on
2026-09-04. The reviewed 16-file implementation tree is unchanged at 2,787 insertions and 394
deletions across the following coherent commits:

| Commit | Ownership |
| --- | --- |
| `d27e3e812d3b9bf7a46ff772e0690b220adb063a` | Source `0e77fbd3d0d79eec5247e75583a04590a1785133`; original author, AuthorDate, subject, and empty source body preserved; fork service/lease adaptation recorded. |
| `2741f7d82eb5118c79373f7920f77959fe99e87c` | Source `a81a52afbb4e03ba82b2743801772151ed8c7d70`; original author, AuthorDate, subject, and empty source body preserved; live-remote/local-fallback adaptation recorded. |
| `413219535e93da7b1cd259a854ea07ab5cf524eb` | Fork-only reviewer repair for remote-qualified bases, authored with local identity. |
| `907a0b25b3d54c75f0b7ea56aa1e2309c0ccf543` | Source `60f2ce0279d524bd70a573f6e0b6e9fab56e4b3e`; original author, AuthorDate, subject, and `Co-authored-by: maria-rcks` trailer preserved; bounded instruction adaptation recorded. |

The maintained plan/ledger publication record is committed separately with local identity. The
reviewed stack was pushed without force and [PR #92](https://github.com/ggfincke/456code/pull/92)
merged as `8e1785e6ca5ee582d9ad910a338d333760e2aca2`. Exact merged-main CI run
[33941082381](https://github.com/ggfincke/456code/actions/runs/33941082381) completed successfully with
15 successful jobs and the intentional mobile-native-static skip. The clean original `main` was
fast-forwarded to that exact green merge, the integration worktree moved to `sync/t3-r02-20260904`,
and only the old Group 01 local/live/tracking branch refs at
`334457affd1c6af262dc46be764d849f94f803ec` were compare-and-deleted. All worktrees and unrelated refs
were preserved.

## Group 02 checkpoint receipt

### Scope and source adaptations

Group 02 started from exact green merged `main`
`8e1785e6ca5ee582d9ad910a338d333760e2aca2` on `sync/t3-r02-20260904`. Before
publication, its reviewed source tree contains 28 files with 1,275 insertions and 223 deletions;
the two maintained `.plans/` files are the only additional checkpoint-document changes, and the
index was empty before source attribution.

| Source | Fork adaptation |
| --- | --- |
| `9d28c21a26aeef198cb064fe466e49cbeabfe09c` | Routine pairing-link snapshots, lists, and change events expose metadata only. The plaintext credential remains available solely in the creation result and in the initiating web client's transient memory; navigation, reload, and environment replacement clear it. Contracts, server serialization, web consumers, user documentation, and mirrored regression tests changed together. |
| `eb77683e5544e071db74831bae052bbd8a7d5f88` | Reusable desktop-bootstrap exchanges alone enter the session-repository replacement transaction. Paired clients and browser sessions remain isolated; removal events publish only after commit, and insertion failure preserves the prior desktop credential. |
| `b6f72681da394369274121c4d1216f5d64a7a4bb` | Shared strict host classification allows external favicons only for public DNS hosts. Web and iPhone Markdown suppress third-party requests for loopback, private, link-local, reserved, `.localhost`, and `.home.arpa` targets while retaining local fallback presentation and existing browser-target behavior. |

No database migration, cookie import, provider-settings redesign, or unrelated auth architecture
entered the group.

### Focused automated gates

All commands used Node 24 through `mise x node@24 --` and the worktree-local dependency graph.

- From `apps/server`, `pnpm exec vp test run auth/PairingGrantStore.test.ts
  auth/EnvironmentAuthAdmin.test.ts auth/SessionStore.test.ts auth/EnvironmentAuth.test.ts
  cliAuthFormat.test.ts` passed 37 tests in five files. The three selected `server.test.ts` auth
  cases passed with `-t 'replaces the local desktop credential|keeps pairing credentials out of raw
  websocket|lists and revokes pairing links'`; the selected `bin.test.ts` case passed with
  `-t 'executes auth pairing subcommands and redacts secrets from list output'`.
- From `packages/client-runtime`, `pnpm exec vp test run state/auth.test.ts` passed two tests; from
  `apps/web`, `pnpm exec vp test run components/settings/ConnectionsSettings.test.tsx` passed two
  tests. The authentication lane therefore passed 45 focused tests.
- The favicon lane passed `hostClassification.test.ts` (2), the `faviconUrlForOrigin` selection in
  `favicon.test.ts` (15, with three unrelated project-favicon tests skipped),
  `browserTargetResolver.test.ts` (16), web `components/markdown/links.test.tsx` (4), web
  `lib/favicon.test.ts` (1), and mobile `feedMarkdown.test.tsx` (1): 39 assertions. Together the
  group passed 84 focused tests.
- `pnpm run typecheck` passed from `packages/contracts`, `packages/client-runtime`, `apps/server`,
  and `apps/web`; `pnpm exec vp run typecheck` passed from `packages/shared` and `apps/mobile`.
  Targeted repository formatting, `vp lint --report-unused-disable-directives` (with
  `--deny-warnings` for the favicon lane), comment-header checks, `pnpm run lint:mobile`, dependency
  consistency, and `git diff --check` passed. SwiftLint reported zero violations across nine Swift
  files. Existing non-failing Effect suggestions and existing lint warnings were not expanded into
  unrelated cleanup.

No full workspace suite was run, as required by the focused-check policy.

### Integrated web and iPhone evidence

One disposable backend and Vite client served both clients. The final-source web flow created the
read-only link `Group 02 creation-only visibility`: **Copy code** appeared only in the creation
result. After navigating from General back to Connections, and again after a full reload, the
metadata and creation-only notice remained but no copyable credential existed. Revoking that exact
link succeeded without removing unrelated session rows.

In a real mock-provider response, web rendered an external favicon only for the public
`github.com` link; RFC1918, loopback, and `.home.arpa` fixtures used local fallback presentation and
made no third-party favicon request. The paired iPhone opened the same disposable project/thread and
showed the public link plus the private `.home.arpa` fallback. The existing mobile autolinker leaves
literal local-IP and localhost fixtures as plain text, so those cases remained automated rather than
being misreported as rendered links.

The native iPhone screenshot is
`/var/folders/hv/8x7nl_n50gdbsjd70yt_v7xr0000gn/T/screenshot_optimized_a85ee5f2-b9e0-4b81-a102-1b7360cb8b58.jpg`.
Web captures remain in the primary owner's controlled-browser session. GitHub evidence URLs are
pending upload during PR publication; no repository-owned PR asset was created.

XcodeBuildMCP initially returned `spawn /usr/bin/xcrun ENOENT` before a real generated workspace
existed. A clean Expo 57 prebuild/CocoaPods pass and bounded host `xcodebuild` succeeded, after which
XcodeBuildMCP resolved, verified, installed, and launched the exact development bundle. Semantic UI
automation remained unavailable because the installed Xcode 27 SimulatorKit/AXe combination did not
provide the required interface, so the authorized serve-sim/CUA visual route performed the actual
pairing, navigation, and screenshot gate. This is recorded as a tooling limitation, not a semantic
mock success.

### Cleanup, preservation, and commit map

All run-owned listeners on ports 13774, 15733, 18091, and 3200 were stopped. The backend, Vite,
Metro, serve-sim, app process, and owned Xcode log helpers were terminated after identity checks.
Only `com.ggfincke.code456.dev` installed for this run was removed from simulator
`F8D4BC0B-E701-43AA-B56B-B95AB20E6ECE`, and that simulator was shut down. Exact disposable paths
`/tmp/t3code-group02.x18TLK` and `/tmp/t3code-group02-fixture.ZhjfyJ` were removed after ownership and
open-file checks. The ignored compatible native build/workspace remains available for the next
approved iOS gate. The original checkout stayed clean, and the unrelated Cartographer review
worktree, all unrelated refs, installed release app state, caches, credentials, and simulator
runtimes were preserved.

| Commit | Ownership |
| --- | --- |
| `77a7da17a211f26c90df2b990a0fbdd36f4e4db5` | Source `9d28c21a26aeef198cb064fe466e49cbeabfe09c`; original author, AuthorDate, subject, and empty body preserved; pairing read-model adaptation recorded. |
| `971865c691b9c03941d6147ee8fece87cef3e63c` | Source `eb77683e5544e071db74831bae052bbd8a7d5f88`; original author, AuthorDate, subject/body, and contiguous two-line co-author trailer block preserved; transactional desktop-bootstrap adaptation recorded. |
| `d6c37dfc96c091a5cd9443e4c2872ee758b60926` | Source `b6f72681da394369274121c4d1216f5d64a7a4bb`; original author, AuthorDate, subject, and contiguous four-line co-author trailer block preserved; public-host favicon adaptation recorded. |

The maintained plan/ledger receipt is committed separately with local identity. The reviewed stack
was pushed without force and [PR #93](https://github.com/ggfincke/456code/pull/93) published three
secret-free captures in the
[Group 02 acceptance comment](https://github.com/ggfincke/456code/pull/93#issuecomment-5549304967).
Its exact-head rollup finished with 19 successful checks and three intentional skips before merge
commit `e831f6cf51c01d31952b0de06c29a55b9bad9b80`. Exact merged-main CI run
[33945024714](https://github.com/ggfincke/456code/actions/runs/33945024714) completed successfully with
15 successful jobs and the intentional mobile-native-static skip. The clean original `main` was
fast-forwarded to that exact green merge and the integration worktree moved to
`sync/t3-r03-20260904`.

Only the old Group 02 local/live/tracking refs at
`fae7227308105a95dc9541cc0d3908c40665e51c` were compare-and-deleted. The run-created metadata-repair
backup at `3bfdbd5221ff7b5f6177120e934d70daedc7e537` was also compare-and-deleted after proving its tree
exactly matched corrected source tip `d6c37dfc96c091a5cd9443e4c2872ee758b60926`. All worktrees and
unrelated refs were preserved.

## Group 03 checkpoint receipt

### Scope and source adaptation

Group 03 started from exact green merged `main`
`e831f6cf51c01d31952b0de06c29a55b9bad9b80` on `sync/t3-r03-20260904`. The reviewed
implementation is six files with 390 insertions and 94 deletions. It adapts upstream source
`7839140e5e93d3f401d7eb45b86cf1a234eb3609` to the fork's relocated mobile state owners and
mirrored root test layout:

- outbox storage now decodes a complete snapshot before publishing any record, so one unreadable or
  malformed record produces a typed load failure without partially hydrating the queue;
- the outbox manager retains durable and in-memory ownership when cleanup cannot load or remove a
  record, allowing a later retry instead of treating uncertain state as deleted;
- composer draft hydration, mutation, cleanup, debounced persistence, sticky model selection, and
  attachment state share one serialized retry path, preserving the last known snapshot through
  read/write failures and the fired-debounce-during-flush race; and
- the thread composer surfaces a recoverable restoration failure without leaking attachment data or
  replacing the user's saved state.

No database migration, provider behavior, server source, native project, dependency, or unrelated
mobile state entered the group. Source commit
`4b3add0b00184674014e643ba33a31b197b88aca` preserves Theo Browne's exact source Author,
AuthorDate, subject, and empty original body, then appends the full source SHA and fork adaptation.

### Focused automated gates and review

All implementation commands used the worktree-local dependency graph with Node 24 through `mise`.
From `apps/mobile`, `pnpm exec vp test run state/threads/use-composer-drafts.test.ts
state/threads/thread-outbox.test.ts connection/environment-cleanup.test.ts` passed all 65 tests in
three files, and `pnpm run typecheck` passed through `tsc6 --noEmit`. From the repository root, the
six implementation/test files passed `node scripts/format-repository.ts --check --staged`,
`pnpm exec vp lint --report-unused-disable-directives`, and `node scripts/check-js-comments.ts`.
`git diff --check` passed. No full workspace suite ran.

Independent focused review found no actionable defect and rated the implementation appropriately
engineered. It specifically verified atomic outbox decoding, retry-preserving cleanup ownership,
serialized draft mutation/persistence, attachment-safe restoration handling, and the major failure
regressions. Reviewer `git diff --check` also passed independently.

### Integrated iPhone persistence evidence

One fresh disposable backend served two clean fixture projects through a deterministic Gemini ACP
mock. The retained compatible `com.ggfincke.code456.dev` artifact was installed without a native
rebuild. On the exact iPhone 17 Pro simulator
`F8D4BC0B-E701-43AA-B56B-B95AB20E6ECE`, the primary owner paired a fresh Group 03 environment,
selected `gemini_group03/default`, and verified a saved `G03 draft sentinel` plus one owned 24 x 24
PNG attachment. With the backend stopped, two queued outbox rows were visible: the first retained
the PNG and the second was text-only, both with the explicit mock model.

The first attempted draft probe replaced `drafts.json` with a directory. It is explicitly **invalid
and not acceptance evidence**: Expo FileSystemFile reports a directory at a file path as
`exists === false`, so no read/open failure occurred and the app legitimately created a new regular
file. This probe is retained only as evidence for why directory substitution must not be used.

The corrected native probe used an existing regular `drafts.json` at mode `000`. Its pre-fault
baseline was 7,217 bytes, mode `0644`, mtime `1788586576`, and SHA-256
`8a1a7158bd53ae526c55c3c83391c8e255c3f7895f7e5d8d34c49dc4461bb70c`. Opening Draft Recovery
and entering a harmless retry mutation produced the sanitized typed warning
`Composer draft persistence operation read failed for composer-drafts/drafts.json.` The live file
remained a regular 7,217-byte mode-`000` file with the same mtime. After stopping the app and
restoring only mode `0644`, its SHA-256 remained exactly unchanged; the final offline launch visibly
restored the sentinel, PNG, and mock selection.

For the outbox fault, the stopped app retained the first JSON byte-for-byte at SHA-256
`8f5a7b1e6fc0b511647b3b9078514834c0a9369e0d503617ecdb79ffa1392cf5` while only the second JSON
was replaced with malformed data. The faulted launch emitted the sanitized typed outbox-load warning
and did not publish the otherwise valid first record as a partial queue. Restoring the second record
to its exact original SHA-256
`ab2bad6100b249ae68e7cdd3a11eeab7920e1ca0706c34d17fc31973500e501c` returned both pending rows,
including the first row's image and model selection, while the backend remained offline. No queued
record was sent or drained.

The final local evidence paths are:

- restored draft, attachment, and model:
  `/var/folders/hv/8x7nl_n50gdbsjd70yt_v7xr0000gn/T/screenshot_optimized_6a9b387f-6d00-4196-a708-0e05d177e93a.jpg`;
- two initial offline pending rows:
  `/var/folders/hv/8x7nl_n50gdbsjd70yt_v7xr0000gn/T/screenshot_optimized_7ad5f121-0176-4e83-9046-51d90386939e.jpg`; and
- both rows recovered after exact restoration:
  `/var/folders/hv/8x7nl_n50gdbsjd70yt_v7xr0000gn/T/screenshot_optimized_0d2df17c-bf92-407a-832e-5ce2ac34bcae.jpg`.

XcodeBuildMCP verified, installed, launched, and stopped the retained app artifact, but semantic AXe
inspection remained unavailable with the pinned Xcode 27 SimulatorKit interface. The already
authorized serve-sim/CUA route performed the real pairing, photo selection, offline queueing,
failure, retry, and recovery interactions. This is a tooling limitation, not a mocked native result.

### Cleanup and preservation

The fresh Group 03 environment was removed through the app's Connections UI while offline. Its
outbox files and cache rows were absent after cleanup; the one residual Group 03 pending-task draft
and sticky model selection were then removed while the app was stopped. The retained prior
`http://127.0.0.1:13774/` connection, compatible development app, ignored native build/workspace,
keychain/shared-container state, and all unrelated client data remain in place.

The only imported Photos asset, `IMG_0007.PNG` / UUID
`570565A4-C162-4E05-AA15-F591FF2663EE`, was deleted through the Photos UI and is recoverable in
Recently Deleted for 30 days. Its trashed state is `1`, it has no active row, and all six pre-existing
photos remain active. Owned backend, Metro, serve-sim, app, and log-helper processes terminated;
ports 13775, 18092, and 3200 have no listeners. The exact owned simulator was shut down. Disposable
roots `/tmp/t3code-group03.xhJ4Hh` and `/tmp/t3code-group03-fixtures.mFmCjI` were moved to the
user's Trash after open-file checks, preserving a recovery route until Trash is emptied.

The reviewed stack was pushed without force. [PR #94](https://github.com/ggfincke/456code/pull/94)
published all three secret-free recovery captures in the
[Group 03 acceptance comment](https://github.com/ggfincke/456code/pull/94#issuecomment-5549861501).
The first exact-head CI attempt retained one unresolved, non-reproducing server-shard failure in
unchanged code: a provider-cache assertion observed the initial `checkedAt`, while Vitest reported an
unhandled interruption rejection and identified CheckpointReactor as the latest test context. The two
exact cases then passed individually, and their two files passed together with 74/74 tests and no
unhandled rejection. No
source or fixture change was made. The requested failed-job rerun replaced the displayed CI job set;
that attempt and the complete PR rollup finished with 19 successful checks and three intentional
skips.

PR #94 merged through merge commit `f02d28b6323d02b2802d06d6aea0c7f3205e81d3`. Exact merged-main
CI run [33950331362](https://github.com/ggfincke/456code/actions/runs/33950331362) completed successfully
with 15 successful jobs and the intentional mobile-native-static skip. The clean original `main` was
fast-forwarded from `e831f6cf51c01d31952b0de06c29a55b9bad9b80` to that exact green merge, and the
integration worktree moved to `sync/t3-r04-20260904`. Only the old Group 03 local, live-origin, and
tracking refs at `f526f71ce33d086cbd9b3b81c23361c1f55948f1` were compare-and-deleted after proving
the merged PR head and live-main ancestry. The unrelated Cartographer worktree and every unrelated
ref, cache, installation, simulator/runtime, credential, process, and workspace remain preserved.

## Group 04 checkpoint receipt

### Scope and source adaptations

Group 04 started from exact green merged `main`
`f02d28b6323d02b2802d06d6aea0c7f3205e81d3` on `sync/t3-r04-20260904`. The reviewed
implementation is 17 files with 1,162 insertions and 241 deletions; the two maintained `.plans/`
files are the only additional checkpoint-document changes, and the index remains empty before source
attribution.

| Source | Fork adaptation |
| --- | --- |
| `19c97ea56d30b3a2de31a060f8f47d6b7404b78f` | Desktop capture ownership and the shared web/contracts flow settle each pick once. A five-second native crop timeout yields a typed `screenshotFailed` result; web retains the structured annotation without crop data, restores composer ownership, and reports the failure. The active owner admits one capture at a time and replacement identities fence late results. |
| `6319a9714881a1d25549f797c468fabebae92813` | The preview manager pins debugger sessions to the intended guest web contents and tears them down on replacement or destruction so a stale or displaced target cannot crash or settle the current request. |
| `b5fb3fba0fb3dbd1bc2e29886232321cc06863d5` | Keyboard ownership remains inside the focused preview guest and its popup. Guest shortcuts do not activate host commands, while the same shortcut in the host composer retains its existing behavior. |
| `098bf5329727fcd7d973bf842e6b4d50d6e7b924` | Explicit preview URL requests remain byte-for-byte navigation targets. Only discovered server URLs use environment-port resolution, preserving path case, encoded separators, query, fragment, and the explicit `0.0.0.0` host. |

Two integration-discovered fork repairs remain separate from upstream attribution. A retained
`did-start-navigation` listener keeps a pick alive through subframe navigation and cancels it only
when the main frame navigates. The renderer now decodes a returned PNG data URL synchronously and
locally instead of calling `fetch(data:)`, which the desktop content-security policy correctly
blocks; no CSP, permission, or security policy was loosened. The native five-second deadline remains,
while the asynchronous renderer conversion wait is removed entirely.

The root `tests/` workspace gained only its resolution-time `react-grab` declaration and the matching
three-line lock importer entry for the already-installed repository version. Application dependency
metadata and versions did not change.

### Focused automated, build, and review gates

Implementation tests, typechecks, builds, and the final comment check used Node 24 through `mise` and
the worktree-local dependency graph.
The desktop lane passed 44 focused tests in `Manager.test.ts` and `PickPreload.test.ts`; the web lane
passed 32 focused tests across browser-target resolution and preview behavior; and the contracts lane
passed three IPC-schema tests. Targeted desktop, web, and contracts typechecks plus changed-file
formatting, lint, comment-header checks, lock consistency, and `git diff --check` passed. The final
web suite passed 31 tests across three files after the local-PNG repair, bringing the latest combined
desktop/web/contracts run to 78 tests. `pnpm run build` from `apps/web`
completed in 11.07 seconds with only the repository's expected plugin, chunk-size, and source-map
warnings. The preceding affected desktop build also completed successfully.

Independent focused review found no remaining desktop, web, or contract defect. It verified current-
owner settlement, debugger-session pinning, replacement and navigation fencing, guest shortcut
ownership, exact URL routing, crop-free annotation retention, and the final local PNG conversion.
No full workspace suite ran.

### Integrated Electron and browser evidence

One isolated Electron 41.5.0 process owned its backend and used a persistent process-local
`app.setPath` interceptor for `appData`, `userData`, `sessionData`, and `crashDumps`. Startup verified
desktop version `0.0.28`, the intended application path, and every redirected profile path before UI
work. No `HOME`, installed profile, global protocol registration, content-security policy, or provider
credential changed.

In the real Electron UI, the explicit fixture URL
`http://0.0.0.0:18093/Case?x=a%2Fb#keep` remained byte-for-byte intact. Guest-focused Cmd+K reached
only the fixture's key handler; host-composer Cmd+K opened the actual command palette. A named local
popup opened and closed without forwarding its shortcut to the host.

The exact guest `capturePage` fault was armed once after proving a zero-call baseline. The real
annotation request invoked it at `2026-09-05T08:09:45.438Z` with crop
`{ x: 4, y: 197, width: 475, height: 116 }`. After five seconds the annotation remained as a crop-free
chip, Send stayed enabled, and annotation mode unlocked. Restoring the same guest's capture method
without restarting let the immediately following real pick produce the `Annotated preview crop`
thumbnail and `preview-annotation-annotation_4.png`, while retaining the earlier crop-free annotation.
No provider turn was sent.

The integrated pass also reproduced and then closed the renderer conversion defect: native
`capturePage` returned a 950 x 232 Retina PNG of 11,221 bytes, but `fetch(data:image...)` failed under
the existing `connect-src` policy. The UI truthfully retained the annotation and displayed
`Could not capture the picked element` / `The annotation was kept without the screenshot.` After the
local decoder repair, the same-process next capture succeeded as described above.

One earlier attempt is deliberately excluded from acceptance: an owned Vite restart overlapped the
pick and destroyed the guest before capture, producing zero capture calls. It was a fixture-induced
invalid attempt, not a product failure. No shared verification process was restarted during the final
failure-to-success pass.

A fresh one-time pairing URL also authenticated the ordinary browser client, listed the owned project,
and showed a healthy composer. Preview resources are intentionally desktop-only, so the plain-browser
gate verified authentication and capability gating rather than claiming a native preview flow. The
shared web preview behavior itself was exercised in Electron; no fake browser bridge was injected.

The three secret-free local evidence files retained for PR upload are:

- timeout retention: `/tmp/t3code-group04-evidence.rjejXy/final-timeout-retained-annotation.png`,
  SHA-256 `3bfc74ba2632df325c1b00c3f0b5cd4c636a92f718ffd791685f4bac53009f6a`;
- reproduced normal-conversion failure toast:
  `/tmp/t3code-group04-evidence.rjejXy/native-normal-capture-failure-toast.png`, SHA-256
  `5b0c872a4225982d0165de6d18ac58af9ee38790786acd18c66d3344d1bf004b`; and
- same-process recovery: `/tmp/t3code-group04-evidence.rjejXy/final-recovered-screenshot.png`,
  SHA-256 `cb9a81fbda7abb4bd4cccab37748774fef67398f2d8c0e2f0d09a03a7c307b95`.

Each capture is 2,200 x 1,560 and was reviewed as secret-free. All three were uploaded in the
[Group 04 evidence comment](https://github.com/ggfincke/456code/pull/95#issuecomment-5550626650);
no `.github/pr-assets` file exists.

### Cleanup, preservation, and publication state

All owned Electron, backend, Vite, inspector, and fixture-server processes stopped. Ports 13776,
15734, 18093, 9234, and 9235 have no listeners. The exact owned fixture and project were moved
recoverably to `/Users/ggfincke/.Trash/t3code-group04.efrYjY` and
`/Users/ggfincke/.Trash/t3code-group04-project.v5zc28`; the three evidence PNGs were retained through
their GitHub upload, and the canonical evidence comment is linked above. The controlled browser tab
was closed.

The original checkout remained clean through publication and was fast-forwarded only after exact
merged-main CI passed, from `f02d28b6323d02b2802d06d6aea0c7f3205e81d3` to
`dcaba8bda6991f08568453ef0581a54394a3eafe`, with original
cache mtimes `.vite=1784948790` and `.vite-temp=1788016177`. The unrelated dirty Cartographer review
worktree at `b58e8c7088ba1330f7fdf14a56430d02f2174442` was observed but not modified. All unrelated
worktrees, refs, caches, profiles, installations, credentials, and processes remain preserved.

The accepted implementation tree was preserved exactly by the following published commit stack:

| Commit | Ownership |
| --- | --- |
| `815bd336bd3c3d443cce2fb386da248302906266` | Source `b5fb3fba0fb3dbd1bc2e29886232321cc06863d5`; original author, AuthorDate, subject, and empty body preserved; guest/popup shortcut isolation adaptation recorded. |
| `814174b9d531a8c4be7cac9c5576a0701a34b0bf` | Source `6319a9714881a1d25549f797c468fabebae92813`; original author, AuthorDate, subject, and `Co-authored-by: Claude Fable 5` trailer preserved; pinned-debugger adaptation recorded. |
| `4c9f304ff63cfea9e29c462e1e12c0cee5615ba2` | Source `098bf5329727fcd7d973bf842e6b4d50d6e7b924`; original author, AuthorDate, subject, and empty body preserved; explicit-URL adaptation recorded. |
| `8a8728028e7eaefc699ed66268debc4bac69ff2c` | Source `19c97ea56d30b3a2de31a060f8f47d6b7404b78f`; original author, AuthorDate, subject, and `Co-authored-by: Claude Fable 5.1` trailer preserved; bounded capture/ownership adaptation recorded. |
| `fc21bcd2fde5e49a4b051cb772f573adfac7fd21` | Fork-only main-navigation listener repair, authored with local identity. |
| `c8c51aa09ccb2c0cbb0725e86d77bf79c1f70bc1` | Fork-only synchronous local PNG decoder repair, authored with local identity. |
| `1bd22cf0d1562bb8b463695f83ec0d5ba68183c7` | Mechanical fork-only CI repair that retains the existing `globalDate` directive verbatim and declares `globalTimers` separately, with no runtime change. |

The binary implementation diff from the green base has SHA-256
`104600f33bb084d211e189d3a64492479a4e4aeba52bf65499953df5a3103d4a`, exactly matching the
accepted pre-commit tree. PR #95's first `Check` job then demonstrated that combining the existing
`globalDate` directive with the new timer exception violated directive-preservation policy. The
mechanical split above passed the exact local directive check and changed only comments; the final
implementation fingerprint is `ff2af2be2b1b0ff43c92ef2975462831c3d962eb757fffbee8ac360e53106348`.
The follow-up receipt commit `54c85c251ab897ae430ca5344490051268e000b0` completed the PR head.
[PR #95](https://github.com/ggfincke/456code/pull/95) passed exact-head run `33955954664`
with all 16 workflow jobs terminal (15 successful and the intentional mobile-native-static skip; the
full PR rollup was 19 successful and three intentional skips). It merged with merge commit
`dcaba8bda6991f08568453ef0581a54394a3eafe`; exact merged-main run `33956661399` passed with
the same 15-success/one-intentional-skip workflow outcome. The clean original checkout was then
fast-forwarded to that exact green merge, and the integration worktree moved to
`sync/t3-r05-20260904`. The old Group 04 local, live-origin, and tracking refs at
`54c85c251ab897ae430ca5344490051268e000b0` were compare-and-deleted only after proving the exact
merged PR head and live-main ancestry. No worktree held the branch; every unrelated ref and worktree
was preserved.

## Group 05 checkpoint receipt

Group 05 started from exact green merged `main`
`dcaba8bda6991f08568453ef0581a54394a3eafe` on `sync/t3-r05-20260904`. Its six approved sources were
implemented across non-overlapping replay, projection, and provider-service owners:

| Fork commit | Source and adaptation |
| --- | --- |
| `560f63617c0e828a8abc848ab7879f7e3f14d3bc` | `9a7b1e21e51609266adf657bcab0b43b6bcd445c`; resolves persisted bindings only for unique active thread IDs and preserves typed fallback, mismatches, and lifecycle locks. |
| `26e2f0232e79be12a7ebc956bd72b42f62bced05` | `7e460f429b740180cd72730418262a2df971ba54`; adds the SQL row/UTF-8-byte replay preflight and shell snapshot fallback. |
| `f7099aa35219988ba361a74f19134eb8e994ea25` | `50bfca43d76ced00f5d67cfbab8bc44c50eb0e53`; reads and measures only the selected thread through aggregate indexes while preserving recreation, deletion, ordering, and captured-head behavior. |
| `5a0dc26fbcfb90b3bf415cd8020fd99e2bbdce0c` | `a9ffb8279614df6ae2f1f4b7f09a0dc42edef797`; scans CRLF-safe activity previews incrementally and hydrates client payloads in sequential 25-ID batches. |
| `8f3fa746fe259db2cb5b91cea61dc055cc512c63` | `b17cc3d1bf0f4a5deee6dd6a470e36970b864a9b`; filters lifecycle, task, evidence, and handoff activity kinds in SQL before decoding payloads. |
| `99bde49a06c9348c26980280ec4f7afe06cb0c59` | `e86604d3372acccd9f6a33a2c4ae46f4e2685541`; atomically appends text-only streaming deltas without reading message bodies while retaining slow-path attachment and terminal semantics. |

The final focused gate passed 363 unique tests: 329 tests across 16 affected server files, 15 targeted
server subscription/replay cases from `server.test.ts`, and 19 client-runtime shell/thread sync cases.
The one coordinated Node 24 server typecheck passed; its output contained only existing Effect
suggestions. Changed-scope formatting, comment/header checks, directive preservation, and
`git diff --check` passed. Changed-scope lint exited successfully; the remaining warnings were proven
to exist at the green base and were not changed. The accepted code/test implementation spans 34
files, 2,153 insertions, and 158 deletions; the final published diff including the two maintained
receipt files spans 36 files, 2,255 insertions, and 185 deletions. The implementation-only binary diff
fingerprint from the green base is
`e56eba4be0caf3025d252cc79edec35ce073b77edd8e0f923621186a303b3c76`.

The primary agent then exercised the real web client against one isolated loopback stack, normal ACP
ingestion, and the unchanged ACP mock behind a temporary output-expansion wrapper. The fixture first
exposed and corrected its own catalog mismatch: `Auto` and configured `default` were truthfully
rejected because `session/new` advertised `grok-build`; no real provider was contacted. A new
`grok-build` thread then settled at `GROUP05 INITIAL SETTLED`. During the second prompt, tab-scoped
CDP networking closed the actual WebSocket while the backend accepted 2,071 inbox records through
sequence 2,073, including 1,030 completed-item and 1,026 updated-item records, and projected 2,054
activity rows plus terminal non-streaming text `GROUP05 TERMINAL SNAPSHOT RESTORED`.

On the same warm client cache, reconnect request 27 subscribed to the exact thread with
`afterSequence: 51`. The server returned a bounded snapshot at sequence 2,110 containing 500
activities, a ready session, a completed latest turn, and four non-streaming assistant messages,
then sent `synchronized`. The visible UI retained both initial and terminal markers, cleared the
offline state, and unlocked the composer. The actual 1,280x720 primary CUA capture was copied from
the owning rollout without recapturing or exposing authentication/wire credentials; its SHA-256 is
`cd41def29cf67dfa609ebe6068ae517a52e986076e8c31281d61c7c26a25cec1`. It is published in the
[Group 05 evidence comment](https://github.com/ggfincke/456code/pull/96#issuecomment-5551244601).

Cleanup stopped the sole retained dev session and its orphaned mock child pair, confirmed no
listeners on ports 13,773 or 5,733, closed the owned browser tab after restoring networking, and moved
only the run-owned base, tiny project, and fixture directory to Trash for recoverability. After the
GitHub upload was confirmed, the verified JPEG and temporary publication files were moved recoverably
to `/Users/ggfincke/.Trash/t3code-group05-evidence.QFimtc`. The unrelated client environment, original
checkout, dependencies, caches, refs, and worktrees were preserved.

The source-attributed stack and receipt commit produced exact PR head
`d4495997318839d4e56e4657483bef2512f6535e`. [PR #96](https://github.com/ggfincke/456code/pull/96)
passed exact-head run `33961400191` with all 16 workflow jobs terminal (15 successful and the
intentional mobile-native-static skip; the full PR rollup was 19 successful and three intentional
skips), including Windows installed-artifact acceptance and cleanup. It merged through merge commit
`41c357f8967e8ec8c78b41f3c755c6fdb7669116`; exact merged-main run `33962109060` passed with the same
15-success/one-intentional-skip workflow outcome. The clean original checkout was fast-forwarded only
after that exact main gate, and the integration worktree moved to `sync/t3-r06-20260904`. The old
Group 05 local, live-origin, and tracking refs at `d4495997318839d4e56e4657483bef2512f6535e`
were compare-and-deleted only after proving the exact merged PR head, live-main ancestry, and no
worktree holder. Every unrelated ref and worktree was preserved.

## Group 06 published checkpoint

Group 06 started from exact green merged `main`
`41c357f8967e8ec8c78b41f3c755c6fdb7669116` on `sync/t3-r06-20260904`. Its five approved sources were
implemented across non-overlapping projection/persistence, runtime/query, and persistence-error
lanes:

- `8ac5462920c45cdee63af15b2598909736f2ec84` replaces full message and approval hydration during
  shell-summary refresh with scalar latest-user and pending-count queries while retaining proposed
  plans and user-input lifecycle state.
- `2263e13fda8c9a4f1b6f4dee32e3c9020195e2aa` batches runtime projector cursor writes in the existing
  transaction while preserving per-projector bootstrap, event filters, cleanup enqueues, and full
  rollback.
- `dffb4cd3b16dc6f41aced99922950ee3083082c6` reads active runtime context through one joined query and
  retains fork model selection, provider switch, provider-instance, hidden-thread, lifecycle, and
  pending-turn guards.
- `6365919f2e5bcfb4fa4020b95e19af26ae40979f` uses fresh shell state at all four late/live metadata
  consumers: provider-start failure, post-generation title replacement, and both interrupt recovery
  reads. Planning, send, handoff, and history-dependent paths retain their existing detail reads.
- `dddc0bdcb2230147e207efb17df2e49dbe1bdd8c` carries normalized SQLite conditions through both SQL
  mapper paths, preserves correlation metadata and tag-only schema summaries, bounds wrapper
  traversal, and never copies query data or driver messages.

The final-byte Node 24 focused gate passes 188 tests across seven affected suites. The one coordinated
server typecheck passes with only existing Effect suggestions. Aggregate formatting, lint,
comment/header checks, directive preservation, and `git diff --check` pass; five lint warnings are on
lines unchanged from the green base. An initial typecheck exposed only a widened `SqlError` in a
deliberate corrupt-history test fixture; the fixture now makes setup corruption fatal before the
intended typed provider failure, and the final CommandReactor suite passes all 72 tests. The accepted
implementation/test diff spans 20 files, 1,090 insertions, and 138 deletions, with binary diff SHA-256
`14c631b5d1dd61050a4281dc51edae21e80ad0e7a38b719e27c161b9a4651db1` from the green base.

Two earlier mistaken broad formatter invocations were interrupted and reconciled against the final
manifest; no mid-scan byte-equality claim is made. Final targeted checks ran on the frozen bytes, and
the implementation fingerprint was independently reverified. Independent peer review closed the two
initially omitted late metadata consumers before the final 188-test/typecheck/static gate, and found
no remaining actionable issue.

This group changes server query and transaction mechanics without adding a client-visible interface,
so no duplicate web, mobile, or Electron environment was launched. Focused real-SQL, durable-engine,
query-count, transaction rollback, and unchanged-projection tests are the integrated gate for this
server-only group. Five source-attributed commits plus a fork-only typed-fixture repair and maintained
receipt were published in [PR #97](https://github.com/ggfincke/456code/pull/97) from exact head
`820d738ff435470fa40d0d7ed040c379f21b8e9f`. PR CI run
[33964794564](https://github.com/ggfincke/456code/actions/runs/33964794564) passed its full rollup with
19 successes and three intentional skips. Merge commit
`023572c63f64a0d7e226e11ee369fd1f6c52b346` passed exact merged-main CI run
[33965498899](https://github.com/ggfincke/456code/actions/runs/33965498899) with 15 successes and the
intentional mobile-native-static skip, including Windows installed-artifact acceptance and cleanup.
The clean original checkout was fast-forwarded to that exact merge, and the run-owned Group 06 local,
live-origin, and tracking refs at `820d738ff435470fa40d0d7ed040c379f21b8e9f` were compare-deleted
after exact PR, holder, ancestry, and live-ref guards.

## Group 07 verified checkpoint

Group 07 started from exact green merged `main`
`023572c63f64a0d7e226e11ee369fd1f6c52b346` on `sync/t3-r07-20260904`. Eight approved upstream
sources were adapted without expanding the frozen intake. `fc262f1a28d8305951c751f2486da6ca72e6c1d1`
adds three total title-generation attempts on a two-second exponential schedule while retrying only
the generator and preserving the fresh-title guard, source-sequence idempotence, cancellation, and
single durable rename. `994bd7373cf3a335c204a617604e690ed4c00cba` carries runtime mode into Cursor
ACP and places `--auto-review` or `--force` before `acp`, retaining endpoint/environment arguments and
supervised behavior. `f86c5e8c8700b76250ed1073700a5b9db47e2d57`,
`a5bbad910f78cc14eef8baa94fe6f46676f78d5a`, and only the approved probe slice of
`98a29cbaa1ccf8d8afb6d35e3e1d925ff9b5fa90` make Claude probes non-invasive, retain successful
capability discovery when optional usage lookup fails, and surface safety-model fallback warnings;
the source's merge-confirmation slice remains planned for Group 27. `bfef973d9ec64e580fff4197ac53085207471ffd`
makes refreshed Codex catalogs authoritative without invalidating the current selection,
`75ab5ab3fb6ad35117da754644c404a31b2fed84` accepts the approved thread-resume rate-limit error
shape, and `b7d6e65021b021207424c56cb32d6d711fd875fb` restores `tool.denied` runtime-contract parity.

Final focused verification passed 281 tests across eight files: 110 title/Cursor tests, 87 Claude
adapter/provider tests, 48 provider-registry tests, 28 generated-schema tests, and eight runtime
contract tests. A four-test Claude capability-probe rerun passed after the test-only fixture was typed
against the public SDK initialize-response shape. Targeted Node 24 server, contracts, and
effect-codex-app-server typechecks passed. Changed-file formatting, lint, comment/header,
directive-preservation, and `git diff --check` passed; reported warnings were pre-existing and outside
introduced lines. Independent peer and primary reviews found no remaining source or test finding.
The implementation-only binary diff from the published Group 06 merge is
`43f0c6b27876bcaad2b0650d28f31cec35a1fb678b31379b8a6acddd46f16988` across 17 source/test files.

One disposable environment exercised the accepted behavior on actual web and iPhone clients without
live provider credentials. A deterministic Cursor turn used exact arguments
`-e http://127.0.0.1:1 --force acp`, retried title generation once, produced the final title
`GROUP07 RETRIED TITLE`, and persisted exactly one title metadata update. The initial Codex catalog
showed GPT-6 Astra and the disposable Joule Alpha entry on both clients. Removing only Joule Alpha
from the temporary catalog and using the product's environment refresh left Astra current, removed
Joule, and kept Cursor available. No per-instance refresh capability was claimed, and an accidental
handoff confirmation was canceled without changing the active provider session.

The same environment displayed a projection-only `runtime.warning` row on real web and iPhone UI
while retaining the completed response and an unlocked composer. The generic visual fixture read
“Group 07 fixture warning: plan usage is unavailable; provider features remain available.” with the
detail “Disposable projection-only visual fixture.” SDK-specific Claude fallback mapping is covered
by focused tests; no live Claude/Opus fallback was invoked or claimed as visual evidence. XcodeBuildMCP
semantic snapshots remained unavailable because the selected Xcode 27 installation lacks the expected
SimulatorKit private framework, so the previously approved serve-sim/CUA visual route drove the real
iPhone flow. A 127.0.0.1 web attempt was correctly blocked by the fixture's localhost-only CORS origin;
no security policy was weakened. A fresh localhost browser session passed instead. The native cache
was cleared only through the G07 environment's product UI; after an exact owned-app termination to
avoid its normal finalizer rewriting the stale in-memory snapshot, the relaunched app received all
three projected activity rows and visibly rendered the warning.

Reviewed web and iPhone evidence is published in
[PR #98 comment 5552543049](https://github.com/ggfincke/456code/pull/98#issuecomment-5552543049).
The exact G07 mobile environment was removed through the real Connections UI, leaving the pre-existing
127.0.0.1:13774 connection intact. Owned backend, Vite, Metro, manifest-shim, and serve-sim processes
are terminal; ports 13777, 5737, 18092, 18094, and 3200 are clear; the owned simulator is shut down;
and the compatible development client remains installed. The disposable base and tiny Git project
were moved recoverably to Trash, while the original checkout, unrelated refs/worktrees, caches, and
credentials were preserved. Eight source-attributed commits plus the separate fork-only typed-fixture
repair were published from exact PR head `d81c303e97ce3ff9a073508a153cf4bc8bd31eb1`.
PR CI passed its complete 22-check rollup with 19 successes and three intentional skips. Merge commit
`9a797692a24ad2d2df2ff8e6691f6fb0ef883709` passed exact merged-main CI run
[33973168375](https://github.com/ggfincke/456code/actions/runs/33973168375) with 15 successes and the
intentional mobile-native-static skip. The clean original checkout was fast-forwarded to that merge,
and the exact run-owned Group 07 local, live-origin, and tracking refs were compare-deleted after PR,
holder, ancestry, and live-ref guards.

## Group 08 active checkpoint

Group 08 started from exact green merged `main`
`9a797692a24ad2d2df2ff8e6691f6fb0ef883709` on `sync/t3-r08-20260904`. The approved OpenCode server
lifecycle lane is locally verified and awaiting publication. The non-overlapping client/logger lane adds durable mobile
approval locking and lifecycle copy for `responding` and `unknown` outcomes while preserving dynamic
provider options, labels, and request identity. It deliberately does not duplicate approval lifecycle
state in the thread-detail reducer: both clients already merge the authoritative shell outcome, and
the web surface already locks and explains those states. The `ec8b2119c377f5c1dbe6235b221ef98eca31a96e`
slice omits only repeated native OpenCode running-tool snapshots from provider NDJSON logs; pending,
completed, failed, unknown, malformed, canonical, and orchestration records remain unchanged.

The frozen checkpoint passes 222 focused tests: seven EventNdjsonLogger tests, three mobile approval
presentation tests, 24 OpenCode environment, inventory, and permission-runtime tests, plus 188 adapter,
runtime-ingestion, and command-reactor tests. The coordinated server and mobile typechecks and exact
changed-file formatting, lint, comment/header checks, and `git diff --check` pass. Peer review found no
remaining issue before the integrated gate began.

The focused server targets ran from `apps/server` with
`mise x node@24 -- pnpm exec vp test run <targets>`: `provider/Layers/OpenCodeAdapter.test.ts` passed
62 tests, `orchestration/Layers/ProviderRuntimeIngestion.test.ts` passed 49,
`orchestration/Layers/ProviderCommandReactor.test.ts` passed 77,
`provider/Layers/EventNdjsonLogger.test.ts` passed seven, and the three
`provider/opencodeRuntime.{environment,inventory,permissions}.test.ts` targets passed 24. From
`apps/mobile`, the same command targeting
`features/threads/activity/pendingApprovalPresentation.test.ts` passed three. Both affected packages
passed `mise x node@24 -- pnpm run typecheck`. From the repository root,
`node scripts/format-repository.ts --check --staged <20-file manifest>`, the changed-TypeScript-file
forms of `pnpm exec vp lint --report-unused-disable-directives`, `node
scripts/check-js-comments.ts`, and
`node scripts/check-directive-preservation.ts` passed, followed by `git diff --check`.

The final 20-file manifest consists of two maintained `.plans` receipts, three mobile source files
and one mirrored mobile test, five server source files and seven mirrored server tests, plus two
maintained provider/observability docs. The accepted implementation/source-doc diff against Group 07
merge `9a797692a24ad2d2df2ff8e6691f6fb0ef883709` has SHA-256
`c52e9f333e9876acff9f6b642c61804ba228927052df86b99906419dddc5aeb8` when computed with
`git diff --binary <merge> -- apps packages tests docs | shasum -a 256`; `.plans` receipt text is
deliberately outside that implementation fingerprint.

One shared disposable web/iPhone environment has exercised the approved real-client approval paths.
An automatic full-access reply failure fell back to one manual card; an abrupt SSE disconnect
reconnected without duplicating the request, and the real manual HTTP success cleared the card even
though the fixture intentionally omitted the native reply event. A second request timed out into the
same durable `unknown` and non-retryable presentation on web and iPhone, and a real disabled-button
attempt did not resubmit it. That first Stop exposed an integration defect: the Stop command was
durably recorded as `thread.turn-interrupt-requested` sequence 41, but the earlier approval action at
sequence 38 remained `unknown`, fenced the provider-command cursor at sequence 37, and prevented the
provider abort from running. The repair preserves the durable `unknown` approval outcome without
falsely resolving the approval, records the OpenCode approval-response action as handled, and leaves
generic provider unknown-action fencing unchanged.

A clean replacement environment then repeated the whole affected lifecycle on the repaired bytes.
The same SSE reconnect and single manual approval behavior passed; the second approval again became
durably `unknown` on web and iPhone with no disabled-button resubmission. A real iPhone Stop then
closed the approval, interrupted the turn, restored both composers, and advanced the provider-command
cursor through the succeeded approval and interrupt actions. A deliberately late native permission
reply increased only the disposable sidecar's event sequence: it did not reopen a canonical request,
increment the reply count, or change the stopped client state after web reload. No live provider
credential or provider turn was used. XcodeBuildMCP semantic inspection remained unavailable because
the host's pinned Xcode-beta SimulatorKit private framework is absent; the previously approved
serve-sim/CUA visual-control route exercised the real installed iPhone client, and exact simulator
screenshots captured the unknown and post-late stopped states. Root-controlled UI removed only the
fresh `13778` mobile environment and preserved the pre-existing `13774` connection. The owned
sidecar, web/backend, Metro, serve-sim, and app processes stopped; ports `4098`, `5738`, `13778`,
`18095`, and `18096` have no listeners; and the simulator returned to shutdown while the compatible
development client remained installed. Both disposable bases and projects were moved recoverably to
Trash after their reproduction evidence was recorded. The two safe final screenshots remain in one
run-owned temporary evidence directory for GitHub upload. Source attribution, publication, and exact
merged-main CI remain required before Group 08 completes.

## Verification policy for every group

1. **Preflight and ownership:** verify HEAD, exact source SHAs, dirty/staged/ignored manifests,
   dependency/cache ownership, processes, and applicable instructions; assign non-overlapping owners.
2. **Focused gates:** run only relevant Vite+/Effect tests and affected-package typechecks/builds. Cover
   meaningful auth, persistence, bounds, cancellation, replacement, and compatibility failures. Run
   changed-file formatting/lint/header checks, dependency consistency, and `git diff --check`.
3. **Integrated gates:** the primary agent alone uses `test-t3-app`, `test-t3-mobile`, and real Electron
   for affected surfaces. Use disposable authenticated environments and one representative iPhone;
   rebuild ignored native projects only when required.
4. **Evidence:** record exact commands/results, adaptations, manifests/diff summary, visible evidence,
   risks, and unavailable gates. Performance candidates require profiling or behavioral evidence, not
   brittle wall-clock assertions.
5. **Cleanup and continuation:** stop owned processes, remove only owned disposable state, update this
   plan and ledger, preserve the checkpoint receipt, then publish and continue sequentially under the
   standing approval. Stop only for the explicit material-scope, authority, required-gate, or human
   OAuth conditions above.

Do not run full local workspace suites or duplicate integrated environments across workers.

## Publication after each accepted checkpoint

Group 01 is explicitly approved, and standing approval covers the same sequence for each later group
after its scoped checkpoint is green:

1. Create coherent source-attributed commits preserving original Author, AuthorDate, subject/body, and
   trailers; append the full source SHA and fork adaptation notes. Keep fork-only repairs separate.
2. Push one group PR with rendered multiline Markdown and GitHub-uploaded evidence. Never commit PR
   screenshots or recordings into the repository.
3. Wait for every expected check to succeed or be intentionally skipped. A material behavioral CI
   repair returns to a new verified checkpoint and triggers the material-change stop condition.
4. Merge with a **merge commit**, verify exact merged-main CI, and fast-forward the clean local `main`.
5. Delete only that run-owned merged branch. Preserve every unrelated ref, worktree, installation, and
   credential.

## Exclusions

Remain excluded throughout: Android; Connect/Relay/cloud restoration; cookie import; automatic
post-update thread continuation; unrelated provider/settings redesign; cosmetics; usage-dashboard
expansion; broad dependency/release churn; test pruning; and patches whose upstream architecture is
absent. Group 12 personal OAuth is the only approved Antigravity authentication path. There is no
Antigravity dual backend and no authority to alter the existing `agy` installation.

## Completion definition

Completion requires all accepted groups merged and verified plus a final exact 468-row ledger. Every
row must end with an evidence-backed disposition, fork counterpart, dependencies, verification, and
associated fork commit/PR. Conditional rows must have a demonstrated outcome, never “probably
equivalent.” The current inventory intentionally leaves non-grouped rows unreviewed; that is truthful
checkpoint state, not final reconciliation.
