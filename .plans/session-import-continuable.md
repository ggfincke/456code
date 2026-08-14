# Continuable session import: Codex, Claude, OpenCode, Cursor, and Grok

Status: implementation and focused acceptance complete in the working tree
Date: 2026-07-26
Branch: `codex/continuable-session-import`
Comparison base: `d1c8d7d82d6dd394f388e37e26add0ed82d42904`

This is the execution ledger and acceptance record for importing foreign agent sessions into
456code as inert, attributed transcripts with an exact, consent-gated native continuation when the
source provider can prove that it still owns the native session.

## Execution ledger

| Phase | Status | Acceptance evidence |
|---|---|---|
| Contracts, provenance, and event-log import | Complete | Imported origin, RPC schemas, command invariants, migration, projections, deterministic receipts, and live shell updates are covered by focused contract/server/client-runtime tests. |
| Codex, Claude, and OpenCode parsing | Complete | Bounded parsers preserve renderable messages, reasoning, tools, file changes, titles, metadata, and omission warnings; malformed and oversized structures fail closed or truncate with diagnostics. |
| Cursor and Grok ACP replay | Complete | Bounded `session/list` and `session/load` clients, stable ACP source URIs, replay normalization, credential redaction, child cleanup, and connection-wide accounting are covered by focused ACP and adapter tests. |
| Discovery, identity, import, and continuation | Complete | Configured-source ownership, canonical-path validation, native-ID matching, atomic import serialization, exact binding, repair/reverify, and deadline behavior are covered by focused unit and integration tests. |
| Web import and continuation UX | Complete | Settings scan/import, provider selection, imported grouping, consent blocking/focus, rendering, repair, reload, and restart were exercised in an isolated authenticated browser environment. |
| Resource and adversarial hardening | Complete | Independent persistence/client and provider-identity audits found no remaining confirmed issue. Raw and normalized budgets, traversal limits, fair deadlines, compensated archive replacement, process cleanup, payload compaction, and fail-closed provider authority are in place. |
| Final acceptance | Complete with import-specific iOS interaction pending | Final server matrix: 41 files / 739 tests. Final client matrix: 15 files / 320 tests. Seven package typechecks, 186-file format checks, targeted lint/diff checks, authenticated WS coverage, and a clean isolated browser import/reload/restart/reverify pass are green. The repository-level native boot blocker was repaired and a fresh iOS app booted and paired, but this plan's imported-session consent/send interaction was not rerun on the simulator. |

## Supported sources: all five

| Source | Discovery and parsing | Continuation contract |
|---|---|---|
| Codex CLI | Configured effective `CODEX_HOME`; bounded rollout JSONL parsing; session ID must match the rollout filename. | Exact Codex provider instance with `thread/resume`; no silent `thread/start` substitution. |
| Claude Code | Configured effective Claude home; bounded project JSONL parsing; active parent/leaf branch only; UUID must match the filename. | Exact Claude provider instance with SDK `resume` using the native UUID. |
| OpenCode | Configured local OpenCode storage root; metadata, message, part, and tool files loaded as one bounded bundle. | Exact OpenCode provider instance and native session ID; remote server URL ingestion is intentionally rejected. |
| Cursor | Configured provider process queried through ACP `session/list`, then replayed through `session/load`. | Exact Cursor provider instance and native session ID from the stable ACP URI. |
| Grok | Configured provider process queried through ACP `session/list`, then replayed through `session/load`. | Exact Grok provider instance and native session ID from the stable ACP URI. |

## User-visible outcome

- `/settings/import` scans all configured source instances and groups candidates by source.
- A candidate can only target a provider instance that owns the source root or ACP connection that
  produced it. Client-supplied provenance and incompatible provider selections are rejected.
- Import creates or reuses the normalized project, creates one attributed thread, appends inert
  messages and work-log activities through orchestration commands, and stores a stopped continuation
  binding. Import does not start a live provider process except for bounded ACP catalog/replay work.
- The transcript uses the existing message timeline and work-log UI. Reasoning, commands, tool
  results, file changes, MCP details, and attachment-omission notices retain their intended display
  shape without a parallel renderer.
- Before the first native turn, both Enter and Send are behaviorally blocked until the user accepts
  the explicit `Continue with <provider>` or `Start fresh with <provider>` notice. Missing, invalid,
  unavailable, or mismatched continuation state fails closed and links to repair/provider settings.
- A completed native turn graduates the thread from import consent. The latest turn ID now remains
  persisted even when a non-git workspace produces no checkpoint, so reload/server restart cannot
  resurrect the consent banner.
- Restart projection retains the latest `import.continuation` marker independently of the 500-entry
  live-activity window. Provider shutdown preserves the exact continuation identity in the stopped
  runtime binding.
- Retry/reverify is safe. Identical content reports `already imported`; changed content reports that
  delta sync is unsupported instead of mutating a continued transcript.

## Architecture and invariants

### Event-sourced persistence and atomicity

- History enters through `OrchestrationEngineService.dispatch`, not direct event-store writes or a
  foreign transcript table. Standard events drive projections, connected-client broadcasts, replay,
  archive behavior, and deletion behavior.
- `thread.messages.import` accepts only imported threads with no native turn. It emits inert
  user/assistant messages and non-actionable activities; unresolved approvals and user-input
  requests are never imported.
- One process-global, nonblocking import mutex prevents overlapping import transactions. A busy
  request returns a bounded result immediately. The five-minute aggregate deadline interrupts the
  active import; deterministic command IDs make a retry safe.
- Project and thread creation are claim-checked after dispatch. Deterministic first identities make
  normal retries idempotent; bounded collision retries avoid adopting an unrelated existing entity.

### Canonical identity and source authorization

- File-backed identity is `(source, canonical source path, content hash)`. Native-session matching
  additionally includes source, exact provider instance, and native session ID.
- Source paths are resolved only against configured source roots. Canonical root and file paths,
  device/inode identity, regular-file status, and descendant containment are checked before and
  after the bounded file read, closing symlink escape and read-time replacement windows.
- Native IDs must agree with the authorized source identity: Codex/Claude/OpenCode filenames, or
  `acp://<cursor|grok>/<encoded provider instance>/<encoded native session>`.
- Continuation authority includes an opaque, length-framed SHA-256 identity for the exact live
  source boundary. File roots and executable/source-selector symlinks are re-canonicalized at route
  use; runtime, import catalog, provider snapshot, consent, persisted binding, and recovery must all
  agree on the same identity.
- Import input is source-selective: the server resolves only catalogs required by the request.
  Canonical duplicate roots are grouped, while every compatible provider instance remains available
  for exact selection.
- Relative provider homes and ACP `PATH` entries resolve against `ServerConfig.cwd`, including when
  the launch directory differs. Windows environment keys are case-insensitively deduplicated and
  canonicalized before configured overrides, launch, cataloging, and identity calculation.

### Continuation and stable markers

- Bindings are stopped/lazy. The first accepted send uses normal provider recovery with the stored
  cwd, model selection, runtime mode, exact instance, and resume cursor.
- Validation, verification, directory reads, and binding upserts are fail-closed. An existing newer
  or different binding is preserved; an early failure cannot overwrite it or append a misleading
  fresh-session marker.
- A pristine stopped binding may be refreshed with current model/cwd/runtime metadata. A thread with
  native activity cannot be rebound by a later import.
- Archive replacement keeps the archived source durable until its replacement is archived, validates
  the full source/native/provider/content/project identity before cleanup, compensates failed swaps,
  and bounds interrupt cleanup so the global import mutex can be released.
- Continuation state is recorded as one deterministic activity after the final imported record:
  `verified` or `history-only`, exact driver/instance, and a bounded reason. Transition-specific
  command IDs permit legitimate re-verification while keeping retries idempotent.
- The UI consent token includes thread key, state, exact provider instance, driver, and reason. Any
  change invalidates prior consent.

### Parser semantics

- Codex prefers event messages for display messages, falls back to `response_item` messages, joins
  tool lifecycle records by bounded stable IDs, suppresses current developer/system scaffolding, and
  preserves commands, output, MCP details, and changed-file data required by the web renderer.
- Claude reconstructs the active conversation branch using trusted leaf anchors and parent UUIDs,
  rejects cycles/disconnected foreign branches, imports safe queued prompts/task notifications, and
  skips sidechains. Tool-use/result pairs and selected thinking blocks become work-log activities.
- OpenCode aggregates one session across metadata/message/part storage with total file, byte, node,
  collection, and record budgets. Tool lifecycle and changed-file details are normalized to the same
  renderer contract.
- Cursor/Grok replay ignores notifications for other sessions, omits unfinished tools and binary
  attachment contents, caps nested tool content/locations/plans, and derives stable timestamps and a
  stable content hash from bounded normalized content rather than transport timing.
- Oversized tool IDs become deterministic stable IDs. Text, command, metadata, warning, collection,
  nesting, and record bounds prevent adversarial amplification.

### ACP lifecycle, deadlines, and fairness

- ACP child stderr is always drained, bounded, sanitized, and credential-redacted. Every scoped child
  receives graceful shutdown followed by forced termination when needed.
- Initialize/auth/list calls default to 15 seconds, session load to 90 seconds, idle replay to two
  seconds, and full batch/import execution to five minutes.
- Catalog bytes, replay bytes/notifications, normalized bytes, pages, and sessions are bounded both
  per session and per connection. Shared wire usage prevents each phase from independently consuming
  the full request allowance.
- Scan has a one-minute aggregate deadline. Catalog resolution receives a reserved share; file and
  ACP source classes receive fair byte/time shares; each file group and ACP descriptor receives an
  independent full-lifecycle share. One slow source reports a diagnostic without starving peers.
- Cursor, Grok, and OpenCode provider startup uses a race-safe reclaiming keyed semaphore so same-key
  work serializes while unrelated provider instances proceed concurrently and unused keys are
  reclaimed.

### Resource accounting and compaction

| Boundary | Limit |
|---|---:|
| Raw file-backed session | 25 MiB |
| Whole import/scan request | 256 MiB |
| Compacted normalized session | 50 MiB |
| Normalized session records | 25,000 |
| Normalized request records | 25,000 |
| Filesystem traversal entries | 10,000 |
| OpenCode JSON files | 10,000 |
| ACP catalog bytes | 25 MiB default |
| ACP replay bytes | 25 MiB/session, 100 MiB/connection default |
| ACP normalized bytes | 100 MiB/connection default |

`compactImportedSession` removes redundant raw input/output and redundant non-display item copies
before normalized accounting and persistence. It preserves MCP item payloads, compact changed-file
data, command fields, summaries, statuses, and details used by the existing renderer.

## Acceptance evidence

### Focused automated gates

- Final server import/orchestration/provider/WebSocket matrix: 41 files, 739 tests passed.
- Final web/mobile/client-runtime/contracts matrix: 15 files, 320 tests passed.
- Independent provider-identity audit: 10 files, 159 tests passed, plus the exact configured-cwd
  WebSocket regression.
- Independent persistence/client audit: 3 files, 40 tests passed.
- Windows environment/catalog composition: 4 files, 47 tests passed.
- Typechecks passed for server, web, mobile, contracts, client-runtime, shared, and `effect-acp`.
- Expanded server formatting checked 186 files; targeted client formatting checked 46 files.
  Targeted lint and `git diff --check` passed. The broader lint pass still reports pre-existing
  manual-Effect-runtime diagnostics in unrelated existing tests and the pre-existing unused
  `decodeCompactJwtPayload` in `tests/apps/server/server.test.ts`.

### Live sample resource proof

- Codex: 20/20 sampled rollouts parsed; largest compacted normalized session 10.25 MiB.
- Claude: 20/20 sampled transcripts parsed; largest compacted normalized session 1.20 MiB.
- Codex aggregate: 47.72 MiB compacted versus 134.98 MiB before compaction.
- Claude aggregate: 8.66 MiB compacted versus 19.75 MiB before compaction.
- No sampled session exceeded the 50 MiB compacted normalized-session limit.

### Integrated authenticated browser proof

- A clean isolated final-code environment used a separate fake Codex home and fresh database.
- Scan found the source; import completed with two messages, exact Codex ownership, zero failures,
  and `Resume verified`.
- The imported transcript rendered its prior user/assistant messages, reasoning/work log, command
  activity, and continuation marker.
- The environment intentionally had no authenticated Codex account. The UI therefore reported that
  the exact bound instance was not ready and blocked substitution. Enter created no user row,
  preserved `BLOCKED_IMPORT_DRAFT`, and announced the block through the live status region.
- Browser reload and a complete server stop/start preserved transcript content, the draft, the exact
  provider block, resume cursor, and opaque continuation identity in both the activity and runtime
  binding.
- Retry/reverify returned the safe `already imported` result and the current marker remained valid.
- Browser console contained zero errors. Four instances of the pre-existing LegendList recycling
  warning were observed on unchanged virtualization surfaces.

### Native mobile acceptance boundary

- The representative iOS Simulator native build completed successfully, as did installation, launch,
  and Metro bundling.
- The prior missing `ExponentConstants` / `ExpoAsset` report was not a missing pod or host-toolchain
  registry failure. Swift sanitizes the numeric iOS target module `456codeDev` to `_56codeDev`, while
  Expo looked up `ExpoModulesProvider` through the unsanitized `CFBundleName`. The tracked Expo config
  now emits Swift-safe names (`_56codeDev`, `_56codePreview`, and `_56code`), allowing the fresh app to
  register native modules, boot, and pair normally. React 19.2.3 alignment and Hermes-compatible
  array-copy operations closed the additional runtime compatibility failures found during that run.
- The completed simulator pass exercised the exact-run mobile worktree policy, not this plan's
  imported-session continuation prompt or blocked Send behavior. That import-specific interaction
  remains accepted through focused automated tests and typecheck until a dedicated simulator flow is
  run; it is no longer attributed to a host or Expo-module blocker.

## Residual limitations

### Deliberate product limits

- Delta synchronization is not implemented. A native session whose content hash changes after import
  is reported and left untouched.
- OpenCode imports local storage only; configured external OpenCode server URLs are rejected.
- Strict continuation requires the provider's native history to remain available. Missing or
  unverifiable history becomes explicit history-only state; 456code never silently substitutes a
  new or different provider session.
- Cursor/Grok import requires ACP `session/list` and `session/load` capability support from the
  configured provider.
- Binary attachment payloads are omitted/redacted and represented by a visible summary activity.
- Claude sidechains/subagent branches are skipped; only the selected active branch is imported.
- Bounded traversal/candidate limits may omit unseen sessions after a cap, with an explicit
  truncation diagnostic.

### Acceptance coverage boundary

- Earlier browser evidence exercised a real Codex continuation; the final clean environment
  deliberately used an unauthenticated provider to prove exact-instance fail-closed behavior.
  Claude, OpenCode, Cursor, and Grok continuation paths are covered by focused adapter/import tests
  and binding verification, not live end-to-end provider accounts in the final browser environment.

### Remaining P3 resource notes

- Node `realpath` is not abortable; a pathological mount operation can outlive the Effect timeout,
  although its result is ignored and the request remains bounded.
- Configured-root canonicalization is concurrent without an explicit root-count concurrency cap.
  Roots are trusted configuration, and later scan budgets remain bounded.
- Normalized serialization can allocate a transient in-memory string before the final byte budget
  rejects it. Record, field, raw-file, and request caps bound the input, but do not eliminate that
  temporary allocation.

## Closed decisions

| Question | Final decision |
|---|---|
| Scan scope | All sessions reachable through configured source instances, grouped by normalized workspace/project. |
| Provider selection | Exact compatible instance only; no cross-instance or cross-driver substitution. |
| Default runtime | `approval-required`. |
| Claude branching | Active trusted leaf/parent chain only; sidechains skipped. |
| Import mutation | Full initial import only; changed native history is reported, not merged. |
| First send | Explicit behavioral consent; fail closed on missing/invalid/unavailable continuation. |
| Repair | Retry/reverify from Import settings, preserving any newer/different binding. |
