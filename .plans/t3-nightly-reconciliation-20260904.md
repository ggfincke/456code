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

- Published `main`: `b58e8c7088ba1330f7fdf14a56430d02f2174442`.
- Published predecessor: original Group 1, sources `c78ae50a5`, `2a7a449cc`, `f90e2f2bd`, and
  `d2042d288`, merged through PR #91. Its four source-attributed fork commits and the merge commit are
  recorded in the ledger; PR and merged-main CI were green.
- Active publication: revised Group 01 is verified, approved, and published in
  [PR #92](https://github.com/ggfincke/456code/pull/92). Hosted checks are pending; merge remains
  gated on every expected check succeeding or being intentionally skipped.
- Active branch: `sync/t3-git-service-text-safety-20260903`, based on published `main`.
- Active worktree: `/Users/ggfincke/Projects/Experiments/456code-t3-nightly-20260903`.
- Future groups are approved as plan scope but remain planned, not implemented. Their branches are
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
| **04 — Desktop preview recovery** | `19c97ea56`, `6319a9714`, `b5fb3fba0`, `098bf5329` | Pin debugger ownership, isolate preview shortcuts, preserve explicit navigation URLs, and bound capture/conversion to five seconds. Keep annotations when screenshots fail, settle picks exactly once, and fence replacements. Verify in real Electron. |
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

Group 04 keeps separate five-second bounds for screenshot capture and conversion. A failed screenshot
may emit `screenshotFailed` while preserving a structured annotation without crop data, unlocking the
composer, and notifying the user. Picks settle exactly once and teardown on timeout, navigation,
destruction, replacement, cancellation, or success; replacement identity fences late results.

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
reviewed stack was pushed without force to `sync/t3-git-service-text-safety-20260903`, and
[PR #92](https://github.com/ggfincke/456code/pull/92) was opened against `main`. This receipt update
records the external publication state without changing the reviewed implementation tree.

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
