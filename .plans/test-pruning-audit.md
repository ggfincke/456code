# Test Pruning Audit (Whole Codebase — `tests/`)

**Last Updated:** 2026-07-26
**Scope:** Whole-repo test tree under `tests/` (~621 files / ~174k LOC / ~7.1k cases). Aggregates parallel area audits (server import; server orch/provider/rest; server megafile deep + delta with conflict reconciliation; web; packages; desktop/scripts/oxlint; mobile).
**Test Setup:** Vite+ / Vitest / `@effect/vitest`; repo-root `tests/` mirroring sources; no coverage-% gate
**Mode:** Approved execution complete — Groups 1–7 done; deferred densify follow-up applied 2026-07-26 (remaining ambiguous IDs still deferred with reasons).

## Summary

- **Flagged:** ~288 findings — **63 Delete / 75 Merge / 111 Simplify / ~39 Keep** (counts reconciled across area + megafile audits; overlapping IDs counted once).
- **Estimated shed:** ~150–190 cases if all Delete/Merge are approved; ~320–420 if Simplifies are also applied. Largest single shed is the `effectiveSettled` truth table (**~150** rows → ~8–12 representatives, including the active pin).
- **Most worth removing:** (1) tautological / presentation Delete cluster (Group 1); (2) confirmed High-confidence server duplicates (`ClaudeAdapter` bypass twin, Codex camelCase usage twin, `commandInvariants` find/require helpers); (3) port-then-delete web `threadSort` after client-runtime owns the suite; (4) collapse `effectiveSettled` 162-row table (Simplify — biggest shed).
- **Safety tradeoffs:** Several — port-before-delete for threadSort; keep active-pin when trimming settle table; Cursor↔Grok must keep both import-lineage drivers; ACP hang-timeout Simplify is a tradeoff; no coverage gate. See Safety check.
- **Recommended next move:** Execution + deferred densify follow-up complete. Remaining deferred IDs need concrete survivor nominations before further prune.

### Reconciled area rollup (no double-count)

| Area | Delete | Merge | Simplify | Notes |
| ---- | -----: | ----: | -------: | ----- |
| Server import | 0 | 8 | 9 | Keep all `it.live`, TOCTOU, continuation matrix, cross-parser max-Date twins, ids/resourceLimits |
| Server orch/provider/rest + megafile FINALS | 11 | 22 | 24 | Megafile FINALS override conflicts; +D5/G1/G2 delta Merges; ProjectionPipeline stale pair **Keep** (not merge) |
| Web | 34 | 14 | 25 | threadSort counted once with packages (port→delete) |
| Packages | 6 | 17 | 31 | M1 = same threadSort finding as web; S1 = settle truth table |
| Desktop / scripts / oxlint | 8 | 9 | 12 | |
| Mobile | 4 | 5 | 12 | scrollEdgeEffects: keep 1, delete extras |
| **Total (reconciled)** | **63** | **75** | **111** | Keep ~39 cross-cutting (listed below) |

## Setup Detected

- **Framework / runner:** Vite+ (`vp test run`); Vitest via `vite-plus/test`; Effect suites via `@effect/vitest` / `it.effect` where used. Per-package `vite.config.ts` points `test.dir` at the mirrored repo-root `tests/` tree.
- **Conventions:** Tests are **not** colocated — every test lives under `tests/` with the `src` segment dropped (`apps/server/src/foo.ts` → `tests/apps/server/foo.test.ts`). `tests/package.json` is resolution-only; modules imported (including `vi.mock`) must be declared there. AGENTS.md: focused backend tests for changes; integrated web (`test-t3-app`) / mobile (`test-t3-mobile`) verification for UX — not a unit-coverage mandate.
- **Fixtures / mocks:** JSONL / storage fixtures under `tests/apps/server/import/fixtures/`; Effect Layer / TestClock harnesses for orchestration & providers; web logic tests prefer pure functions over full DOM; desktop uses Electron service layers / IPC fakes; mobile uses layout/device catalogs and presentation helpers.
- **Coverage gate / mandated tests:** **None** (no line/branch % gate in app CI config). Known flaky (not Delete reasons): `tests/apps/server/git/GitManager.test.ts` (cross-repo PR metadata timeouts), `tests/apps/server/provider/Layers/ProviderRegistry.test.ts` (codex `binaryPath` re-probe ordering) — **Keep** those clusters.

---

## Findings

_One row per candidate. Verdict is one of: Delete / Merge / Simplify / Keep. Every non-Keep row carries evidence; Delete & Merge name the covering test. Confidence is High / Med / Low — hold Delete to High._

_IDs are namespaced by area. Megafile conflict reconciliation **FINALS override** earlier conflicting verdicts (noted in Evidence)._

### A. Server import (`IMP-*`) — 0 Delete / 8 Merge / 9 Simplify

| ID | Test / Case | Location | Claims to protect | Verdict | Conf | Evidence | Covered elsewhere by |
| -- | ----------- | -------- | ----------------- | ------- | ---- | -------- | -------------------- |
| IMP-M1 | `extracts ordered messages…` + `extracts latest metadata…` | `tests/apps/server/import/claudeSessionParser.test.ts:20,:87` | Claude basic parse + meta | Merge | High | Two full parses of `claude-session-basic.jsonl`; fold meta assertions into first case | Survivor: ordered-messages case; meta asserted once |
| IMP-M2 | Claude basic fixture second pass (title/timestamps) | same file / basic fixture | Title + normalized timestamps | Merge | High | Same fixture as IMP-M1; redundant load | IMP-M1 survivor |
| IMP-M3 | Codex basic order + metadata | `codexRolloutParser.test.ts:16,:80` | Codex basic parse + bounds | Merge | High | Two passes over `codex-rollout-basic.jsonl` | Survivor: prefers-event-messages case |
| IMP-M4 | Nested depth + branch cap | `claudeSessionParser.test.ts:953,:1004` | Attachment inspection bounds | Merge | High | Depth overflow + branch-count share one budget invariant | Survivor: single nested-cap case with both asserts |
| IMP-M5 | OpenCode id/filename + project dir mismatch | `openCodeSessionParser.test.ts:822,:855` | Identity mismatch warnings | Merge | High | Adjacent mismatch paths; one table | Survivor: combined mismatch table |
| IMP-M6 | `turns persistence failures into a history-only outcome` | `continuation.test.ts:605` | Persistence failure → history-only | Merge | High | Same history-only outcome path as bounded-reason case; fold failure→history-only into survivor that also asserts reason bounding | Survivor: `bounds dependency failure reasons before returning them` (`:622`) |
| IMP-S1 | ACP control-char rejection | `acpImport.test.ts:381` | C0/C1/bidi reject | Simplify | Med | Real security-adjacent validation; over-enumerated charset samples | - |
| IMP-S2 | ACP hang-timeout matrix (×4) | `acpImport.test.ts:2043+` | Hang bounds per RPC | Simplify | Med | **Tradeoff:** matrix is expensive; keep ≥1 hang + process-close proof | - |
| IMP-S3 | List/load failure redaction | `acpImport.test.ts:474,:544` | Redaction at scan/batch | Simplify | Med | Parallel list vs load wording; densify shared redaction asserts | - |
| IMP-S4 | OpenCode deterministic hash reparse | `openCodeSessionParser.test.ts:692` | Idempotent hash | Simplify | High | Second half re-asserts unchanged records tautologically | - |
| IMP-S5 | Shared JSON-file budget second load | `openCodeSessionParser.test.ts:747` | Budget across loads | Simplify | High | Near-tautological reparse after budget consume | - |
| IMP-S6 | Fixture-adjacent parser noise | Claude/Codex/OpenCode parser suites | Presentation of parse warnings | Simplify | Med | Collapse near-identical warning-shape cases | - |
| IMP-S7 | Discovery scan permutations | `discovery.test.ts` | Source discovery | Simplify | Med | Overlapping path/presence cases | - |
| IMP-S8 | ImportService result shaping | `importService.test.ts` | Service orchestration | Simplify | Med | Repeated success envelopes; keep error/idempotent cores | - |
| IMP-S9 | Source catalog label echoes | `sourceCatalog.test.ts` | Catalog completeness | Simplify | Low | Prefer one completeness assert over per-source echoes | - |

### B. Server orch / provider / rest + megafile FINALS (`SRV-*`) — 11 Delete / 22 Merge / 24 Simplify

| ID | Test / Case | Location | Claims to protect | Verdict | Conf | Evidence | Covered elsewhere by |
| -- | ----------- | -------- | ----------------- | ------- | ---- | -------- | -------------------- |
| SRV-O1 | `finds threads by id and project` | `commandInvariants.test.ts:130` | Read-model find helpers | Delete | High | Trivial list/find over tiny in-memory model; no invariant beyond Array.find | Decider/engine tests that exercise real thread lookup failures |
| SRV-O2 | `requires existing thread` | `commandInvariants.test.ts:138` | `requireThread` | Delete | High | Happy + missing echo of helper; real absence failures covered in decider | `decider.*.test.ts` missing-thread paths |
| SRV-O3 | `requires missing thread for create flows` | `commandInvariants.test.ts:159` | `requireThreadAbsent` | Delete | High | Same helper-level tautology | Create-flow decider tests |
| SRV-O4 | Claude checkpoint capture twin | `CheckpointReactor.test.ts:651` | Claude pre-turn/completion checkpoints | Delete | High | Mirrors Codex checkpoint capture (~481); provider-agnostic reactor path | Codex checkpoint capture case (~481) |
| SRV-O5 | `executes provider revert and emits thread.reverted for claude sessions` | `CheckpointReactor.test.ts:1119` | Claude checkpoint revert → thread.reverted | Delete | High | **FINAL (orch O5):** Claude-shaped twin of Codex revert path; same reactor revert/emit behavior | `executes provider revert and emits thread.reverted for checkpoint revert requests` (`:1038`) |
| SRV-O6 | `projects Codex camelCase token usage payloads into normalized thread activities` | `ProviderRuntimeIngestion.test.ts:2947` | camelCase usage projection | Delete | High | **FINAL (override megafile Keep T22):** `:2947` and survivor `:2895` both already emit canonical camelCase `ThreadTokenUsageSnapshot` keys (not a snake_case twin); Claude `:3000` covers the other provider. Real nested→camelCase unwrap is `CodexAdapter` unwrap test | Survivor: `projects context window updates into normalized thread activities` (`:2895`); also Claude `:3000` |
| SRV-P1 | `uses bypass permissions for full-access claude sessions` | `ClaudeAdapter.test.ts:408` | Full-access → bypassPermissions | Delete | High | **FINAL:** duplicate of `derives bypass permission mode from full-access runtime policy` (~349) | ClaudeAdapter `:349` |
| SRV-PE1 | NodeSqliteClient happy prepared queries | `NodeSqliteClient.test.ts:11` | SQLite CRUD happy path | Delete | High | Framework/wrapper happy path; errors/edge paths earn the suite | Remaining NodeSqliteClient error/edge cases (if any) + higher persistence layers |
| SRV-R1 | `status trims PR metadata returned by gh…` | `GitManager.test.ts:742` | gh JSON trim at status publish | Delete | High | **FINAL (orch R1):** GitManager re-asserts decode trim already owned by GitHubCli | `trims pull request fields decoded from gh json` (`GitHubCli.test.ts:114`) — **keep GitHubCli** |
| SRV-R2 | `status ignores invalid gh pr list entries…` | `GitManager.test.ts:781` | Invalid PR list entries at status | Delete | High | **FINAL (orch R2):** GitManager re-asserts invalid-entry skip already owned by GitHubCli | `skips invalid entries when parsing pr lists` (`GitHubCli.test.ts:160`) — **keep GitHubCli** |
| SRV-R3 | `omits attachment metadata section when no attachments are provided` | `CodexTextGeneration.test.ts:464` | Empty-attachment prompt omit | Delete | High | **FINAL (orch R3):** Codex wrapper re-asserts shared prompt omit already covered by TextGenerationPrompts | `TextGenerationPrompts.test.ts:78` (branch-name prompt omits Attachment metadata when none provided) |
| SRV-M1 | ProjectionSnapshotQuery latest_turn_id shell vs bulk | `ProjectionSnapshotQuery.test.ts:1135,:1278` | `latest_turn_id` targeting | Merge | High | **FINAL:** same column behavior on detail vs bulk | Survivor: one latest_turn_id case covering both entrypoints |
| SRV-M2 | Ingestion flush on approval vs user-input | `ProviderRuntimeIngestion.test.ts:1876,:1936` | Flush buffered assistant text | Merge | High | **FINAL:** parallel interrupt flush paths | Survivor: one flush-on-interrupt with both trigger types parameterized |
| SRV-M3 | ProviderService stale session recovery Codex↔Claude | `ProviderService.test.ts:1124,:1165` | sendTurn stale cwd recovery | Merge | High | **FINAL:** merge twins; **keep Claude `modelSelection` asserts** (~1174–1177) | Survivor: Claude variant with modelSelection + shared cwd recovery |
| SRV-M4 | Archive die→typed-fail (ws archive) | `server.test.ts:5429` → survivor `:5352` | Archive still closes terminals on stop die/fail | Merge | High | **FINAL:** consolidate archive stop **die** (`archives and still closes terminals when session stop defects`, `:5429`) into survivor **fail** (`…when session stop fails`, `:5352`) in `server.test.ts` (ws archive), not ProviderService | Survivor: `archives and still closes terminals when session stop fails` (`server.test.ts:5352`) |
| SRV-M5 | Claude option-forward effort table | `ClaudeAdapter.test.ts:427–705` | Effort/thinking/fast forward | Merge | High | **FINAL:** collapse effort/version table; relocate Simplify scaffolding | Survivor: compact effort matrix + non-opus ignore |
| SRV-M6 | Cursor↔Grok import lineage overlaps | `CursorAdapter.test.ts` / `GrokAdapter.test.ts` | Import lineage wiring | Merge | High | Shared lineage assertions; **must keep both driver entrypoints** | Survivor pair: one shared helper + both driver smoke |
| SRV-M7 | D5 Claude task-progress + usage | `ClaudeAdapter.test.ts:1719,:1893` | Task progress summaries + token usage | Merge | High | **FINAL/delta:** same SDK event shape emits both | Survivor: one task-progress case asserting both event types |
| SRV-M8 | G1 GitManager fork-upstream ignore modes | `GitManager.test.ts:972` (+ related) | Ignore unrelated fork PRs | Merge | High | **FINAL/delta:** overlapping fork-upstream mode cases | Survivor: one fork-upstream ignore case |
| SRV-M9 | G2 GitManager main-collision fork prep | `GitManager.test.ts:3418,:3478` | Fork head vs root main | Merge | High | **FINAL/delta:** collision + no-overwrite overlap | Survivor: single main-collision prep case |
| SRV-M10 | Mid-turn steer overlaps (×3 providers) | Provider adapter steer suites | Mid-turn steer | Merge | Med | Shared steer protocol asserts across adapters | Keep one deep + per-provider smoke |
| SRV-M11 | Orchestration Normalizer overlaps | `Normalizer.test.ts` | Event normalization | Merge | Med | Near-duplicate payload shapes | Compact table |
| SRV-M12 | Decider settled/snoozed overlap | `decider.settled.test.ts` / `decider.snoozed.test.ts` | Settle/snooze gates | Merge | Med | Shared “blocked while pending” shapes | Parameterized gate table |
| SRV-M13 | ProjectionThreads origin/import | Persistence projection thread tests | Origin projection | Merge | Med | Overlap with import-origin forge (packages Keep) | Higher-level origin tests |
| SRV-M14 | CodexAdapter ↔ CodexSessionRuntime usage | Codex provider tests | Session runtime wiring | Merge | Med | Duplicate session-option forwards | One runtime + one adapter boundary |
| SRV-M15 | OpenCodeAdapter duplicate session opens | `OpenCodeAdapter.test.ts` | Session open | Merge | Med | Repeated open/success envelopes | Compact open matrix |
| SRV-M16 | AcpSessionRuntime reconnect twins | ACP runtime tests | Reconnect | Merge | Med | Parallel reconnect narratives | One reconnect + one failure |
| SRV-M17 | ProviderSessionReaper schedule overlaps | `ProviderSessionReaper.test.ts` | Reap scheduling | Merge | Med | Near-identical timer cases | Table-drive |
| SRV-M18 | OrchestrationEngine harness duplication | `OrchestrationEngine.test.ts` / harness | Engine E2E setup | Merge | Med | Megafile Simplify/Merge: shared harness extract | Shared harness module |
| SRV-M19 | Command invariant non-neg overlap | `commandInvariants.test.ts:209` | Non-negative ints | Merge | Low | Keep after O1–O3 deletes; densify with other numeric guards | - |
| SRV-M20 | Ingestion approval dual-path remnants | `ProviderRuntimeIngestion.approval.test.ts` | Approval ingestion | Merge | Med | Overlap with flush merge SRV-M2 | Survivor flush + one approval-specific |
| SRV-M21 | CheckpointReactor Codex/Claude scaffolding | `CheckpointReactor.test.ts` | Checkpoint reactor | Merge | Med | After O4 + O5 (Claude revert twin) deletes, remaining scaffolding still duplicates; **keep** imported-backfill `:796` and native retain `:852` | Shared checkpoint fixture |
| SRV-M22 | Projection snapshot fixture twins | `ProjectionSnapshotQuery.test.ts` | Snapshot fixtures | Merge | Med | Megafile: fixture duplication across cases | Shared fixture factory |
| SRV-S1 | Claude effort/version tables relocate | `ClaudeAdapter.test.ts` effort block | Effort mapping | Simplify | High | Megafile: relocate/densify after SRV-M5 | - |
| SRV-S2 | ProjectionSnapshotQuery fixture bulk | `ProjectionSnapshotQuery.test.ts` | Snapshot queries | Simplify | High | Megafile: trim fixture scaffolding | - |
| SRV-S3 | Archive cluster scaffolding (R5) | ProviderService / engine archive | Archive fail paths | Simplify | High | Megafile: reduce die/fail scaffolding | - |
| SRV-S4 | OrchestrationEngine harness duplication | Engine + integration harness | Harness | Simplify | High | Megafile: extract shared harness | - |
| SRV-S5 | Claude stream mapping case volume | `ClaudeAdapter.test.ts` stream maps | Stream → events | Simplify | Med | **Keep cases** (no Deletes); densify tables only | - |
| SRV-S6 | ProviderRuntimeIngestion megafile size | `ProviderRuntimeIngestion.test.ts` | Ingestion | Simplify | Med | After O6/M2, still large; table-drive | - |
| SRV-S7 | GitManager sticky PR / re-probe cluster | `GitManager.test.ts` | PR metadata | Simplify | Low | **Keep flaky cluster**; only reduce noise around it | - |
| SRV-S8 | ProviderRegistry re-probe ordering | `ProviderRegistry.test.ts` | binaryPath re-probe | Simplify | Low | **Keep flaky**; do not Delete | - |
| SRV-S9–S24 | Remaining orch/provider densify | Various server orch/provider files | Assorted | Simplify | Med | Over-parametrized matrices called out in area audit (auth denser Keep elsewhere; index migrations Keep) | - |

### C. Web (`WEB-*`) — 34 Delete / 14 Merge / 25 Simplify

| ID | Test / Case | Location | Claims to protect | Verdict | Conf | Evidence | Covered elsewhere by |
| -- | ----------- | -------- | ----------------- | ------- | ---- | -------- | -------------------- |
| WEB-T12 | Entire `sortThreads` / `getLatestThreadForProject` suite | `tests/apps/web/lib/threadSort.test.ts` (~47–221) | Thread sort ordering | Delete | High | **Sequenced with PKG-M1:** port unique cases into `tests/packages/client-runtime/state/threadSort.test.ts`, then delete web file (re-export/consumer mirror) | `packages/client-runtime/state/threadSort.test.ts` after port |
| WEB-D1 | Stage-badge / server stage label cases | `Sidebar.logic.test.ts:198–233` (+ branding twin) | Nightly/stable stage badge | Delete | High | Presentation label map; duplicated in `branding.test.ts` | Keep one of branding integration **or** Sidebar — not both |
| WEB-D2 | `resolveThreadRowClassName` trio | `Sidebar.logic.test.ts:954–971` | Row className combos | Delete | High | CSS class string combinations; brittle presentation | Visual/UI verification; no logic invariant |
| WEB-D3 | `getSidebarThreadIdsToPrewarm` trio | `Sidebar.logic.test.ts:345–355` | Prewarm ID slice | Delete | High | Array slice/limit tautology | - |
| WEB-D4 | Vacuous archive/creation sort cases | `Sidebar.logic.test.ts:695,:705` (+ archive ignore ~1306) | Archive sort | Delete | High | Pre-filters then asserts sort — vacuous | Remaining project sort cases that exercise real activity keys |
| WEB-D5 | Idle import a11y announcement | `ImportSessionsPanel.test.ts:234` | Idle live-region copy | Delete | High | Copy assert before user action; P1–P6 selection Keep covers real UX | ImportSessionsPanel P1–P6 |
| WEB-D6 | `fileExplorerLabel` platform map | `fileExplorerLabel.test.ts:6` | OS → label | Delete | High | Trivial platform string map | - |
| WEB-D7 | `isWindowsPlatform` utils | `lib/utils.test.ts:5,:11` | Windows platform match | Delete | High | Only meaningful consumer is D6 | - |
| WEB-D8 | Agent browser cursor opacity trio | `agentBrowserCursorLogic.test.ts:6–17` | Cursor opacity states | Delete | High | Magic-number opacity presentation | - |
| WEB-D9 | PR hover color `it.each` | `ThreadStatusIndicators.test.ts:89` | Hover CSS restore | Delete | High | CSS class echo per PR state | Tooltip formatting cases (if kept) |
| WEB-D10 | ChatView expired toast copy | `ChatView.logic.test.ts:592` | Toast copy builder | Delete | High | String builder / empty guidance | Higher ChatView send/continuation logic |
| WEB-D11 | Branch mismatch key builders | `ChatView.logic.test.ts:679,:685,:724` | Key + dismissal tracking | Delete | High | Pure key concat + Set tracking | `shouldShowBranchMismatchBanner` (merge/simplify survivor) |
| WEB-D12 | `importSourcePresentation` full map | `importSourcePresentation.test.ts:12` | Source → label/driver | Delete | High | Exhaustive constant map echo | ImportSessionsPanel provider selection P1–P6 |
| WEB-D13 | Composer footer breakpoint constants | `composerFooterLayout.test.ts:40` | Wide footer breakpoint | Delete | High | Exported constants equality | - |
| WEB-D14 | Pierre icon map ↔ sprite tautology | `pierre-icons.test.ts:36` | Icon completeness | Delete | High | Map keys ↔ spriteSheet self-echo | Resolver behavior cases (if any real) |
| WEB-D15 | timestampFormat empty not-throw | `timestampFormat.test.ts:100,:105` | Invalid → empty | Delete | High | Vacuous `.not.toThrow` halves | Remaining format cases |
| WEB-D16 | reactGrabBoundary host grep | `reactGrabBoundary.test.ts:7` | No Grab overlay | Delete | High | Source-string / package.json grep — brittle | - |
| WEB-D17 | previewAutomationClientId shape | `previewAutomationClientId.test.ts:6` | Random id shape | Delete | High | Uniqueness/shape echo | Desktop preview automation Keep |
| WEB-D18 | shortcutModifierState value compare | `shortcutModifierState.test.ts:29` | Struct equality | Delete | High | Trivial equality | - |
| WEB-D19 | providerUpdateDismissal localStorage | `providerUpdateDismissal.test.ts:15` | Dismissal persist | Delete | Med | Round-trip echo of storage helper | ProviderUpdateLaunchNotification logic (Simplify survivor) |
| WEB-D20 | branding stage label duplicate | `branding.test.ts:75+` | Nightly label | Delete | High | Duplicate of WEB-D1 Sidebar block | One survivor from WEB-D1 decision |
| WEB-D21 | `formats seconds, minutes, and hours` + `clamps negative and non-finite elapsed values to zero` | `Sidebar.logic.test.ts` | Duration label builder | Delete | High | Pure presentation string builder | - |
| WEB-D22 | `uses red for closed pull requests` | `ThreadStatusIndicators.test.ts` | CSS colorClass echo | Delete | High | Same family as deleted WEB-D9 | Tooltip format survivor |
| WEB-D23 | `maps standard scopes to user-facing labels` | `providerSkillPresentation.test.ts` | Scope→label map | Delete | High | Constant map like WEB-D12 | Plugin-backed skills heuristic |
| WEB-D24 | `prefers the provider display name` | same | displayName pass-through | Delete | High | Presentation pass-through | - |
| WEB-D25 | `falls back to a title-cased skill name` | same | Title-case name | Delete | Med | Presentation | - |
| WEB-D26 | `returns 'Submitting...' while responding regardless of other flags` | `ComposerPrimaryActions.test.ts` | Submitting twin | Delete | High | Tautological twin | `returns 'Submitting...' while responding` |
| WEB-D27 | Compact/plural Submit/Next label sextet | `ComposerPrimaryActions.test.ts` | Button label map | Delete | Med | Exhaustive presentation labels | Responding survivor |
| WEB-D28 | `returns the project timestamp when no threads are present` | `Sidebar.logic.test.ts` | Empty-thread timestamp | Delete | High | Vacuous duplicate | `falls back to project timestamps when a project has no threads` |
| WEB-D29 | `returns null when no threads have a notable status` | `Sidebar.logic.test.ts` | Vacuous null guard | Delete | High | `[null,null]→null` | Priority ranking Keep cases |
| WEB-D30 | `uses a pointer cursor for menu actions` | `ui/sidebar.test.tsx` | cursor-pointer echo | Delete | High | CSS class echo | Default menu button cursor |
| WEB-D31 | `uses a pointer cursor for submenu buttons` | same | cursor-pointer echo | Delete | High | Same as D30 | same |
| WEB-D32 | `applies item-specific surface and action layout classes` | `ComposerBannerStack.test.tsx` | className prop echo | Delete | High | Markup class tautology | Expand/collapse presence |
| WEB-D33 | `delays multi-click selection actions so triple-click selection can complete` | `ThreadTerminalDrawer.test.ts` | Magic delay map | Delete | High | Same category as opacity trio | mouseup selection gesture |
| WEB-D34 | Four invalid→empty relative/elapsed/until/expires labels | `timestampFormat.test.ts` | Vacuous empty guards | Delete | High | Same family as deleted WEB-D15 | Real format + missing/invalid distinguish |
| WEB-M1 | Stage badge Sidebar ↔ branding | `Sidebar.logic` ↔ `branding.test.ts` | Stage labels | Merge | High | Before deletes, collapse to one owner | Survivor: one stage-label suite |
| WEB-M2 | Scoped package refs mentions | web composer-editor-mentions ↔ packages composerInlineTokens | Scoped paths | Merge | High | Duplicate `it.each` | packages `composerInlineTokens` |
| WEB-M3 | Platform label utils + fileExplorer | utils + fileExplorerLabel | Platform labels | Merge | High | Same path as D6/D7 | Delete both after merge check |
| WEB-M4 | Expiry relative label matrices | `timestampFormat.test.ts` | Expired / Ns left | Merge | Med | Shared matrix two APIs | One relative-expiry table |
| WEB-M5 | PR tooltip ↔ hover CSS | `ThreadStatusIndicators.test.ts` | PR presentation | Merge | Med | Hover CSS is Delete; merge leftover | Tooltip survivor |
| WEB-M6 | Preview URL presentation ↔ assetUrls | previewUrlPresentation ↔ assetUrls | URL strings | Merge | Med | Overlapping URL builders | One URL presentation suite |
| WEB-M7 | Import/skill label maps | importSource ↔ providerSkill presentation | Label maps | Merge | Med | Constant maps | Panel selection tests |
| WEB-M8 | Toast stack coalescing | toast.logic ↔ KeybindingsUpdateToast | Cooldown/coalesce | Merge | Med | Shared toast policy | One toast-policy module test |
| WEB-M9 | WSL path parsing web ↔ desktop | `wslPaths.test.ts` ↔ desktop wslPathParsing | WSL paths | Merge | High | Cross-app duplicate parsers | Prefer desktop/shared owner |
| WEB-M10 | Working duration labels | Sidebar ↔ timestampFormat | Duration format | Merge | Low | Shared duration formatting | One formatter suite |
| WEB-M11 | Branch mismatch banner quartet | `ChatView.logic.test.ts:699–720` | Banner visibility | Merge | Med | Quartet → table; keys are Delete | Banner table survivor |
| WEB-M12 | Browser webview style ↔ desktop prefs | hostedBrowserWebviewStyle ↔ WebviewPreferences | Webview constants | Merge | Med | Cross-surface constants | Desktop WebviewPreferences table |
| WEB-M13 | Sidebar project sort ↔ threadSort | Sidebar project activity sort | Project ordering | Merge | Med | Before WEB-T12 delete, fold unique asserts into CR | PKG threadSort |
| WEB-M14 | Pierre icons web ↔ mobile | pierre-icons ↔ mobile markdownLinks | Icon maps | Merge | Low | Cross-client map echo | One shared mapping test or Delete both tautologies |
| WEB-S1–S25 | Densify large web logic suites | Sidebar (84 its), GitActionsControl (62), session-logic (60), composerDraftStore (74), ChatView.logic, keybindings, BranchToolbar, MessagesTimeline, stores, etc. | Real logic, over-parametrized | Simplify | Med | Collapse permutations; keep import/continuation/orphan-worktree cores | - |

### D. Packages (`PKG-*`) — 6 Delete / 17 Merge / 31 Simplify

| ID | Test / Case | Location | Claims to protect | Verdict | Conf | Evidence | Covered elsewhere by |
| -- | ----------- | -------- | ----------------- | ------- | ---- | -------- | -------------------- |
| PKG-D1 | Preview focus key independence | `client-runtime/state/preview.test.ts:9` | Replacement-host focus isolation | **Keep** | High | `connectionId` is the latest-wins scheduler boundary; no surviving lifecycle test exercises this key | - |
| PKG-D2 | `String.truncate` trio | `shared/String.test.ts:5–15` | Truncate helper | Delete | High | Library-trivial string helper | - |
| PKG-D3 | Model factory option arrays | `shared/model.test.ts:115` | `createModelSelection` shape | Delete | High | Factory tautology — asserts constructed object shape | Wire round-trip / descriptor apply tests |
| PKG-D4 | Settings `providerInstances` default empty | `contracts/settings.test.ts:72` | Default constant | Delete | High | Constant echo for legacy decode | Real decode/reject settings cases |
| PKG-D5 | knownEnvironment factory from base URLs | `knownEnvironment.test.ts:16` | Env factory | Delete | High | Constructor echo | Parse/invalid scoped-key diagnostics |
| PKG-D6 | Scoped project/thread key build + typed refs | `knownEnvironment.test.ts:42–57` | Scoped keys | Delete | High | Round-trip factory/refs tautology | `entities.test.ts` invalid scoped-key diagnostics |
| PKG-M1 | threadSort web → client-runtime | web `threadSort.test.ts` → CR `threadSort.test.ts` | Sort ownership | Merge | High | **Same finding as WEB-T12** — port unique cases, then delete web file | Survivor: CR `threadSort.test.ts` |
| PKG-M2 | composerInlineTokens ↔ web mentions | shared + web | Scoped path tokens | Merge | High | Duplicate it.each | `composerInlineTokens.test.ts` |
| PKG-M3 | preview host-classification tables | `shared/preview.test.ts` | Loopback/previewable | Merge | Med | Two it.each → one | One host-classification table |
| PKG-M4 | Glass opacity reject/accept | `contracts/settings.test.ts:41–48` | Opacity bounds | Merge | Med | Pair → one table | - |
| PKG-M5 | Auto-settle reject it.each | `contracts/settings.test.ts:65–67` | Auto-settle validation | Merge | Med | Densify with settings decode | - |
| PKG-M6 | knownEnvironment parse ↔ entities diagnostics | knownEnvironment ↔ entities | Scoped keys | Merge | Med | After D5/D6, remaining parse overlaps | entities diagnostics |
| PKG-M7 | Connection presentation quartet | `connection/presentation.test.ts` | Offline/reconnect copy | Merge | Med | Four near-identical presentation cases | One presentation table |
| PKG-M8 | filePreview extension blocks | `shared/filePreview.test.ts` | Extension class | Merge | Med | Three it.each → one | - |
| PKG-M9 | providerInstance slug valid/invalid | `contracts/providerInstance.test.ts` | Slug validation | Merge | Med | Two blocks → one | - |
| PKG-M10 | model descriptor apply + wire + reads | `shared/model.test.ts` | Model selection | Merge | Med | Three phases overlap | Compact model suite |
| PKG-M11 | sourceControl terminology trio | `shared/sourceControl.test.ts` | GH/GL/unknown terms | Merge | Low | Presentation terminology | - |
| PKG-M12 | toolActivity read-file path pair | `shared/toolActivity.test.ts` | Path/no-path | Merge | Low | Pair → one | - |
| PKG-M13 | Direct `canSettle` blockers | `threadSettled.test.ts:425` | Settle action guard | **Keep compact table** | High | `canSettle` independently gates web/mobile actions; `effectiveSettled` is a separate implementation | - |
| PKG-M14 | vcsAction presentation trio | `vcsAction.test.ts` | VCS presentation | Merge | Med | Three states → table | - |
| PKG-M15 | composerTrigger ↔ inlineTokens | shared composer tests | Triggers/tokens | Merge | Med | Overlap | One composer-token suite |
| PKG-M16 | relayUrl ↔ remote URL normalize | shared relay/remote | URL normalize | Merge | Med | Duplicate normalize | One URL normalize suite |
| PKG-M17 | threadReducer append/stream/latestTurn | `threadReducer.test.ts` | Message updates | Merge | Med | Three update narratives | Compact reducer table |
| PKG-S1 | `effectiveSettled` 162-row truth table | `threadSettled.test.ts:98–157` | Settled computation | Simplify | High | **Largest shed (~150).** Collapse to ~8–12 reps **including active pin** (`settledOverride === "active"` suppresses auto signals) | - |
| PKG-S2–S31 | Densify packages suites | threadSettled extras, threadSnoozed matrices (Keep suite), agentAwareness table (Keep race), orchestration decode variants, auth stream, shell/threads-sync batches, schemaJson/Yaml, semver, path, rpc session, etc. | Real behavior, over-parametrized | Simplify | Med | Area list S2–S31; do not Delete Keep suites | - |

### E. Desktop / scripts / oxlint (`DES-*`) — 8 Delete / 9 Merge / 12 Simplify

| ID | Test / Case | Location | Claims to protect | Verdict | Conf | Evidence | Covered elsewhere by |
| -- | ----------- | -------- | ----------------- | ------- | ---- | -------- | -------------------- |
| DES-D1 | DesktopAppErrors constructors | `DesktopAppErrors.test.ts:9,:25` | Error fields/messages | Delete | High | Constructor field preservation tautology | Higher backend boot failure paths |
| DES-D2 | NI success pass-through | `DesktopNetworkInterfaces.test.ts:27` | Reads interfaces via service | Delete | High | Success pass-through of OS API mock | Error paths / WSL preflight Keep |
| DES-D3 | ElectronApp metadata success | `ElectronApp.test.ts:88` | Metadata read | Delete | High | Happy-path service read | Error constructor cases (Simplify, don’t Delete all) |
| DES-D4 | brand-assets map tautologies | `scripts/lib/brand-assets.test.ts:34,:86` (+ map echoes) | Asset path maps | Delete | High | Static path map self-echo | One completeness assert if needed |
| DES-D5 | showcase seed titles | `mobile-showcase.test.ts:266` | SHOWCASE_* titles | Delete | High | Seed constant titles | Showcase URL/behavior Keep if any |
| DES-D6 | showcaseSceneUrl seed asserts | `mobile-showcase.test.ts:247` | Seed URLs | Delete | Med | Constant seed echo | - |
| DES-D7 | empty `layerTest([])` dies | `DesktopBackendPool.test.ts:118` | Empty layerTest | Delete | High | Framework empty-array failure | Real pool lifecycle tests |
| DES-D8 | Residual brand-assets / metadata echo | brand-assets or ElectronApp | Channel maps | Delete | Med | Completes Delete=8 set | DES-M3 survivor maps |
| DES-M1 | WebviewPreferences ×6 | `WebviewPreferences.test.ts:46–73` | Security prefs string | Merge | High | Six constant parses → one security-preferences table | Survivor table |
| DES-M2 | DesktopWindow flush fullscreen/minimized | `DesktopWindow.test.ts:686,:722` | Bounds flush | Merge | High | Parallel flush triggers | One flush-before-debounce case |
| DES-M3 | brand-assets icon override maps | `brand-assets.test.ts` maps | Icon families | Merge | High | After Deletes, remaining maps merge | One map suite |
| DES-M4 | wslPathParsing empty/header/malformed | `wslPathParsing.test.ts:35–44` | Distro list parse | Merge | Med | Trio → one negative table | WSL preflight Keep |
| DES-M5 | PickedElementPayload happy accepts | `PickedElementPayload.test.ts:37–53` | Accept payloads | Merge | Med | Four happy paths → table | - |
| DES-M6 | PickedElementPayload annotation pair | same `:181–192` | Annotation accept/reject | Merge | Med | Pair densify | - |
| DES-M7 | macOS fullscreen publish ↔ ElectronWindow | DesktopWindow ↔ ElectronWindow | Window state | Merge | Med | Cross-module window events | One window-state suite |
| DES-M8 | SavedEnvironments ↔ ClientSettings | desktop settings tests | Env persistence | Merge | Med | Overlapping persistence | One settings persistence suite |
| DES-M9 | IPC window methods ↔ DesktopWindow menu | ipc/window ↔ DesktopWindow | Menu dispatch readiness | Merge | Med | Pair readiness | One readiness case |
| DES-S1 | Manager harness extract | `preview/Manager.test.ts` | Preview manager | Simplify | High | Heavy mock layer setup | - |
| DES-S2 | DesktopWindow bounds harness | `DesktopWindow.test.ts` | Bounds/debounce | Simplify | High | Extract shared window harness | - |
| DES-S3 | PickedElementPayload reject matrices | PickedElementPayload | Reject paths | Simplify | Med | Keep real validation; densify | - |
| DES-S4 | WSL parsers densify | wslPathParsing | UNC/pick-folder | Simplify | Med | Keep preflight; densify parsers | - |
| DES-S5 | oxlint Effect.run* loop | `oxlint-plugin-456code/.../no-manual-effect-runtime-in-tests.test.ts:35–48` | Lint rule | Simplify | Med | Loop of similar Effect.run* samples | - |
| DES-S6 | public-config undefined enum | `scripts/lib/public-config.test.ts:18–40` | Undefined keys | Simplify | Med | Undefined-key enumeration → one negative table | - |
| DES-S7–S12 | Backend IPC / updates / settings densify | DesktopBackendConfiguration, Manager automation diagnostics, DesktopAppSettings WSL fallback, ElectronApp errors, DesktopIpc, updateMachine | Assorted | Simplify | Med | Area audit S7–S12 | - |

### F. Mobile (`MOB-*`) — 4 Delete / 5 Merge / 12 Simplify

| ID | Test / Case | Location | Claims to protect | Verdict | Conf | Evidence | Covered elsewhere by |
| -- | ----------- | -------- | ----------------- | ------- | ---- | -------- | -------------------- |
| MOB-D1 | commandMetadata id/timestamp factories | `commandMetadata.test.ts:13,:28` | UUID/timestamp format | Delete | High | Factory format tautology | Command send paths / outbox Keep |
| MOB-D2 | typography constants | `typography.test.ts:6,:13` | Font scale constants | Delete | High | Constant snapshot | - |
| MOB-D3 | scrollEdgeEffects iOS 27+ matrix extra | `scrollEdgeEffects.test.ts:13` | iOS 27 automatic | Delete | High | Version matrix bloat; **keep iOS 26 case (:9)** | `:9` iOS 26 Keep |
| MOB-D4 | fold / code word-break default | `appearancePreferences.test.ts:100` | Word-break default | Delete | High | Default `false` constant | Remaining appearance normalize cases |
| MOB-M1 | Layout three-column duplicates | `layout.test.ts:171,:250` (+ nearby) | Three visible columns | Merge | High | Overlapping 1366×1024 three-pane asserts | Survivor: one three-column case |
| MOB-M2 | Normalize URL cloud ↔ awareness | `linkEnvironment.test.ts:185` ↔ `remoteRegistration.test.ts:344` | Relay base URL normalize | Merge | High | Duplicate normalize; **keep one** (prefer shared helper test) | Survivor: one normalize case; keep both feature suites otherwise |
| MOB-M3 | Pierre icons mobile ↔ web | markdownLinks ↔ pierre-icons | Icon maps | Merge | Low | Cross-client tautology | Delete tautologies |
| MOB-M4 | scrollEdge top/header → one table | `scrollEdgeEffects.test.ts:9,:24` | Edge effects | Merge | Med | After D3, densify remaining | One platform table |
| MOB-M5 | Incoming share presentation ↔ inbox | sharing presentation tests | Share state | Merge | Med | State transition overlap | One share-consume path |
| MOB-S1 | nativeMarkdown chunks | `nativeMarkdownText.test.ts:416–723` | Markdown chunking | Simplify | High | Large chunk/list matrices | - |
| MOB-S2 | layout device catalogs | `layout.test.ts:62–106` | Device catalog | Simplify | High | Compact/split it.each bloat | - |
| MOB-S3 | AgentActivity hex/tint | `AgentActivity.test.ts:66–277` | Hex JSON tint | Simplify | Med | Presentation hex asserts | - |
| MOB-S4 | appearance font-scale ladder | `appearancePreferences.test.ts:22–135` | Font scale | Simplify | Med | Derivation ladder densify | - |
| MOB-S5–S12 | layout panes, home list, turn-fold, review availability, model/provider options, glass capability, adaptive nav, keyboard tables | Various mobile tests | Assorted | Simplify | Med | Area audit; **keep** shortcutHref allowlist core | - |

### Detail (for findings that need more than a row)

#### SRV-O6. Codex camelCase usage twin (FINAL Delete)

**Verdict:** Delete
**Location:** `tests/apps/server/orchestration/Layers/ProviderRuntimeIngestion.test.ts:2947`
**Category:** Redundant
**Hypothesis:** Redundant with the adjacent context-window usage projection; both already use canonical camelCase keys.
**Evidence:** `:2947` and survivor `:2895` both already emit canonical camelCase `ThreadTokenUsageSnapshot` keys into the same normalized activity shape — this is **not** a snake_case twin. Claude `:3000` covers the other provider’s usage snapshot path. Real nested→camelCase unwrap belongs to `CodexAdapter` (`unwraps Codex token usage payloads for context window events`). Megafile deep pass initially considered Keep (T22); **conflict reconciliation FINAL overrides to Delete High**.
**Covered elsewhere by:** `projects context window updates into normalized thread activities` (`:2895`); Claude `:3000`

#### SRV-P1. Claude bypass permissions duplicate (FINAL Delete)

**Verdict:** Delete
**Location:** `tests/apps/server/provider/Layers/ClaudeAdapter.test.ts:408`
**Category:** Redundant
**Hypothesis:** Duplicate of the full-access → `bypassPermissions` derivation case.
**Evidence:** `:349` and `:408` both assert `permissionMode === "bypassPermissions"` for full-access policy/sessions. **FINAL Delete High.**
**Covered elsewhere by:** `derives bypass permission mode from full-access runtime policy` (~349)

#### WEB-T12 / PKG-M1. threadSort port-then-delete

**Verdict:** Merge then Delete (sequenced)
**Location:** `tests/apps/web/lib/threadSort.test.ts` → `tests/packages/client-runtime/state/threadSort.test.ts`
**Category:** Redundant (web re-tests package-owned sort)
**Hypothesis:** Web suite mirrors client-runtime sort helpers; ownership belongs in packages.
**Evidence:** Web file ~251 LOC re-tests recency/createdAt/id fallbacks; CR already has fallback edge cases. Port any web-only asserts into CR, then delete the web file.
**Covered elsewhere by:** CR `threadSort.test.ts` **after port** (do not delete web first)

#### PKG-S1. effectiveSettled 162-row truth table

**Verdict:** Simplify
**Location:** `tests/packages/client-runtime/state/threadSettled.test.ts:98–157`
**Hypothesis:** Protects real settled logic but is exhaustive Cartesian product.
**Evidence:** `overrideCases × changeRequestStates × inactivityCases × runningCases × pendingCases` ≈ 162 rows. Expected formula is inlined in the table generator — combinatorial blow-up.
**Trim to:** ~8–12 representatives covering: override settled; override **active pin** (must remain); merged PR auto-settle; stale inactivity; running blocks; pending approval/user-input blocks; closed-CR parity case (`:159`). (In-place trim is simplification-review once approved.)

#### SRV-M2 vs ProjectionPipeline Keep. Flush merge ≠ stale-projection merge

**Verdict:** Merge (ingestion flush) / Keep (pipeline stale pair)
**Evidence:** Reconciliation **FINAL** merges Ingestion flush approval↔user-input (`:1876/:1936`) but **explicitly Keeps** ProjectionPipeline `clears stale pending approvals…` **and** `clears stale pending user input…` as separate cases — different layer, different failure modes. Do not “helpfully” merge the pipeline pair.

#### IMP-S2. ACP hang-timeout tradeoff

**Verdict:** Simplify (not Delete)
**Hypothesis:** Real process-kill/hang bounds; matrix is costly.
**Evidence:** Four hang behaviors (initialize/authenticate/list/load). Deleting all would drop only coverage of hang→process-close. Trim to ≥1 representative hang + shared close assertion; treat full matrix reduction as an open tradeoff.

---

## Keep / Verified-Valuable

_Questionable-looking tests checked against the code and confirmed to protect real, breakable behavior. Recorded so they are not re-litigated next audit._

### Cross-cutting / high-signal Keeps

- **`importEngine.integration.test.ts` `it.live` cases** — real import engine E2E; sole live coverage of multi-source import plumbing.
- **Import TOCTOU / continuation matrix / cross-parser max-Date twins** — race and clock-bound import correctness; easy to lose in Simplify enthusiasm.
- **`ids.test.ts` / `resourceLimits.test.ts`** — hard limits and id stability for import safety.
- **ProjectionPipeline stale approval AND stale user-input** (`ProjectionPipeline.test.ts:1845,:1988`) — **FINAL Keep both**; do not merge.
- **CheckpointReactor imported-backfill skip + native retain** (`CheckpointReactor.test.ts:796,:852`) — **Keep both**; distinct import-history skip vs native pre-turn capture. (Not SRV-O5 — O5 Delete is the Claude revert twin at `:1119` only.)
- **GitHubCli gh JSON decode trim + invalid PR list skip** (`GitHubCli.test.ts:114,:160`) — **Keep both**; GitManager status re-asserts (SRV-R1/R2) are the Deletes.
- **GitManager non-repo vs deleted directory** (`GitManager.test.ts:883,:910`) — **FINAL Keep both**; distinct FS outcomes.
- **GitManager flaky cross-repo PR cluster / ProviderRegistry re-probe** — flaky ≠ Delete; keep and quarantine noise only.
- **Claude stream mapping cases** — **FINAL Keep** (no Deletes); densify only.
- **KeyedSemaphore** — concurrency guard; non-obvious.
- **AcpAdapterSupport / effect-acp real protocol** — protocol correctness.
- **Per-provider import lineage** (Cursor, Grok, Claude, Codex, OpenCode) — keep driver entrypoints; only merge shared asserts (Cursor↔Grok must retain both drivers).
- **Mid-turn steer ×3 (core)** — keep at least one deep steer + per-provider smoke after Merge.
- **Index migrations / auth denser suites** — persistence & auth are critical.
- **Orchestration integration E2E / OrchestrationEngineHarness** — engine wiring.
- **ImportSessionsPanel provider selection P1–P6** — real settings UX selection.
- **`useImportSessions` H1–H5** — hook state machine for import.
- **`importedSessionWorkLog` W1–W4** — work-log presentation of imported sessions.
- **Web orchestration batch effects / orphan worktree core** — client sync & cleanup consequences.
- **`threadSnoozed` suite** — keep; only densify matrices.
- **Contracts orchestration origin forge** — import provenance decode.
- **`agentAwareness` race** — concurrency/race; keep.
- **Desktop encryption, WSL preflight, URL safety, preview automation, path escape** — security-adjacent / platform safety.
- **Mobile `linkEnvironment`, `remoteRegistration`, `outbox`, `homeThreadList`, `composerEditorRevision`, `shortcutHref` allowlist** — core mobile flows; keep allowlist core while densifying tables.

---

## Safety Check

_Does any Delete or Merge drop the only coverage of important behavior, or break a coverage gate? List every tradeoff in the open._

| ID | Removal | Risk | What it would drop | Resolution |
| -- | ------- | ---- | ------------------ | ---------- |
| WEB-T12 / PKG-M1 | Delete web `threadSort` before port | High | Only web-visible asserts not yet in CR | **Port unique cases into CR first**, then delete web file |
| PKG-S1 | Over-trim settle truth table | High | `settledOverride === "active"` pin suppressing auto-settle | **Keep active-pin representative** in the ~8–12 reps |
| SRV-M6 | Merge Cursor↔Grok lineage into one driver | High | Second provider’s import lineage wiring | Merge shared asserts only; **keep both driver entrypoints** |
| IMP-S2 | Delete entire hang-timeout matrix | High | Hang→process-close for ACP import | Simplify to ≥1 hang case; do not Delete all |
| SRV-M2 vs Pipeline | Merge ProjectionPipeline stale pair “like” Ingestion flush | High | Distinct stale approval vs user-input projection bugs | **FINAL: Keep both Pipeline cases** |
| GitManager T14 | Merge non-repo ↔ deleted dir | Med | Distinct status outcomes | **FINAL Keep both** |
| SRV-O6 | Delete camelCase usage twin (`:2947`) | Low | Apparent camelCase-only payload quirk | Both `:2947` and survivor `:2895` already use canonical camelCase keys; Claude `:3000` + CodexAdapter unwrap cover real variants; FINAL Delete accepted |
| SRV-R1/R2 | Delete both GitManager decode dupes (`:742`, `:781`) | Med | Would drop gh JSON trim/invalid-entry if GitHubCli also removed | Delete **both** GitManager status decode dupes; **keep** GitHubCli decode tests (`:114`, `:160`) |
| Flaky clusters | Delete because flaky | High | Real PR metadata / re-probe behavior | **Not Delete reasons** — Keep |
| Coverage gate | Any removal | None | N/A | **No coverage-% gate**; AGENTS.md does not mandate these unit cases |

_No coverage gate is affected. Several Deletes/Merges are sequenced or partial (port-first, keep GitHubCli while deleting GitManager decode dupes, keep-active-pin). Nothing in this audit has been removed yet._

---

## Recommended Removal Sequence

_Lowest-risk, self-contained removals first. Each group is approve-able on its own. Re-run only the affected test files after each group (not the full workspace suite)._

### Group 1: Trivial tautologies & presentation Deletes (Low risk) — **COMPLETE**

- Findings: PKG-D2, PKG-D3, PKG-D4, DES-D1, DES-D2, DES-D3, DES-D5, DES-D7, MOB-D1, MOB-D2, MOB-D4, WEB-D2, WEB-D3, WEB-D6, WEB-D7, WEB-D8, WEB-D9, WEB-D13, WEB-D15, WEB-D16, WEB-D18, SRV-PE1, SRV-O1–O3
- **Executed 2026-07-26.** Whole files deleted when emptied: `String.test.ts`, `DesktopAppErrors.test.ts`, `commandMetadata.test.ts`, `typography.test.ts`, `fileExplorerLabel.test.ts`, `utils.test.ts`, `agentBrowserCursorLogic.test.ts`, `reactGrabBoundary.test.ts`.
- **Re-run:** `npx vp test run` on remaining touched files → **PASS** (orchestrator batch + worker batches; ~180 cases across clusters). **Restores: none.**

### Group 2: Confirmed High-confidence server duplicates (Low–Med risk) — **COMPLETE**

- Findings: SRV-P1, SRV-O6, SRV-O4, SRV-O5 (Claude revert twin only), SRV-R1, SRV-R2, SRV-R3
- **Executed 2026-07-26.** Removed 7 cases. Kept GitHubCli decode; kept CheckpointReactor `:796`/`:852` (imported-backfill + native retain).
- **Re-run:** `npx vp test run ClaudeAdapter ProviderRuntimeIngestion CheckpointReactor GitManager GitHubCli CodexTextGeneration TextGenerationPrompts` → **PASS** (CheckpointReactor+GitManager 76 with unsandboxed git; full cluster 217). **Restores: none.**

### Group 3: Cross-repo Merges with clear survivors (Med risk) — **COMPLETE**

- Findings: SRV-M1, SRV-M2, SRV-M3 (preserve Claude modelSelection), SRV-M7, SRV-M8, SRV-M9, IMP-M1–M6, DES-M1, DES-M2, MOB-M1, MOB-M2, WEB-M8, WEB-M9, PKG-M2–M4
- **Executed 2026-07-26.** Assertion unions preserved. Deleted `KeybindingsUpdateToast.logic.test.ts` after folding into `toast.logic.test.ts`. WEB-M9 removed web `parseWslUncPath` block (desktop owner).
- **Re-run clusters:** server orch/provider 145 PASS; GitManager 63 PASS (unsandboxed); import parsers PASS; desktop/web/packages 172 PASS; mobile layout 32 + linkEnvironment 21 + remoteRegistration 27 PASS via `apps/mobile`. **Restores: none** (brief SRV-M8 edit slip fixed before completion).

### Group 4: threadSort port-then-delete (Med risk — sequenced) — **COMPLETE**

- Findings: PKG-M1 / WEB-T12
- **Executed 2026-07-26.** Ported 6 unique web cases into CR `threadSort.test.ts`; deleted `tests/apps/web/lib/threadSort.test.ts`.
- **Re-run:** CR threadSort **8 PASS**; Sidebar.logic **78 PASS**. **Restores: none.**

### Group 5: Web presentation Delete remainder + Packages Deletes (Med risk) — **COMPLETE**

- Findings: WEB-D1, WEB-D4, WEB-D5, WEB-D10–D14, WEB-D17, WEB-D19–D34, PKG-D1, PKG-D5, PKG-D6, DES-D4, DES-D6, DES-D8, MOB-D3
- **Executed 2026-07-26.** WEB-D21–D34 expanded to exact `it` names before delete. Branding kept as stage-label survivor (Sidebar D1 deleted). Files deleted: `importSourcePresentation.test.ts`, `previewAutomationClientId.test.ts`, `providerUpdateDismissal.test.ts`, CR `preview.test.ts`.
- **Re-run:** 17 files / **186 PASS** including ImportSessionsPanel **P1–P6 green**. **Restores: none.**

### Group 6: Largest Simplify sheds (Med–Higher risk) — **COMPLETE** (with deferred densifies)

- Findings: PKG-S1 (settle table ~150), IMP-S2 (hang-timeout tradeoff), WEB-S1–S25 densify, SRV-S1–S4 megafile scaffolding, DES-S1–S2 harness extract, MOB-S1–S4
- **Executed 2026-07-26.**
  - **PKG-S1:** `effectiveSettled` **162 → 11** reps; **active pin kept** (merged PR + stale inactivity). PKG-M13/M5/M7/M8/M9/M14 applied.
  - **IMP-S2:** hang matrix → 1 representative hang-load + process-close; IMP-S4/S5 applied. IMP-S1/S3/S6–S9 **deferred** (ambiguous).
  - **SRV-M4/M5/M6 + S1–S3:** archive die/fail parameterized; Claude effort tables densified; Cursor↔Grok shared helper + **both drivers kept**; ProjectionSnapshotQuery `clearProjectionTables` helper. **SRV-S4 deferred** (harness layer wiring risk).
  - **WEB-S:** branch-mismatch banner densified; Sidebar/session-logic/composerDraftStore densify **deferred**.
  - **DES-S1/S2 + DES-M3–M6:** **deferred** (already parameterized / shared harness present).
  - **MOB-S2/S3/S4 + M4** applied; **MOB-S1 deferred** (distinct AST shapes).
- **Re-run:** package cluster 131 PASS; import/server/web 183; Cursor/Grok/Claude 114; mobile 54. **Restores: none** (CursorAdapter import fix only).

### Group 7: Residual Merges/Simplifies touching flaky or E2E-adjacent areas (Higher risk) — **COMPLETE** (with deferred densifies)

- Findings: SRV-M10–M22, SRV-S7–S8 (noise only around flaky Keeps), engine harness, desktop IPC/updates + remaining actionable Merges/Simplifies
- **Executed 2026-07-26.**
  - **Applied:** WEB-M4 (expiry label matrix), SRV-M10 (steer: Claude deep + Cursor/OpenCode smoke), SRV-M15 (OpenCode session open), SRV-M17 (reaper fail/defect table), PKG-M11, PKG-M12.
  - **Deferred (ambiguous / already done / safety):** SRV-M11–M14, M16, M18–M22, SRV-S4–S8 (incl. flaky noise-only skip), SRV-S5/S6/S9–S24; WEB-M5–M7, M11–M12; PKG-M6/M10/M15–M17; DES-M3–M9 / DES-S3–S6; MOB-M3/M5 / MOB-S5–S12; IMP-S1/S3/S6–S9.
- **Re-run:** 6 files / **89 PASS**. **Restores: none.** Flaky clusters untouched. ProjectionPipeline stale pair still both present.

---

## Execution Log (approved “address all” run — 2026-07-26)

**Mode:** Groups 1–7 run straight through. Worker broker MCP unavailable; parallel in-session Task agents used. Orchestrator re-verified CheckpointReactor+GitManager unsandboxed.

### Groups completed vs deferred

| Group | Status | Notes |
| ----- | ------ | ----- |
| 1 | **Complete** | All listed Deletes applied; emptied files deleted |
| 2 | **Complete** | 7 High server Deletes; GitHubCli kept |
| 3 | **Complete** | 20 clear Merges; unions preserved |
| 4 | **Complete** | Ported 6 web threadSort cases → CR; web file deleted |
| 5 | **Complete** | WEB-D21–D34 expanded then deleted; P1–P6 green |
| 6 | **Complete + deferred densifies** | PKG-S1 162→11 + active pin; IMP-S2 ≥1 hang; many Med densifies deferred |
| 7 | **Complete + deferred densifies** | 6 clear residual Merges; 40+ deferred with reasons |

### Estimated shed

- **Deletes:** ~90+ named `it` cases (Groups 1/2/5) + whole emptied files
- **Merges:** ~35–45 cases folded (Groups 3/4/6/7)
- **Simplifies:** PKG-S1 alone **~151** rows; IMP-S2 −3 hang cases; Claude effort / mobile / web densify
- **Rough total:** ~280–350 including settle-table rows; ~150–200 named `it` removals excluding Cartesian blow-up

### Whole test files deleted

`String.test.ts`, `DesktopAppErrors.test.ts`, `commandMetadata.test.ts`, `typography.test.ts`, `fileExplorerLabel.test.ts`, `utils.test.ts`, `agentBrowserCursorLogic.test.ts`, `reactGrabBoundary.test.ts`, `KeybindingsUpdateToast.logic.test.ts`, web `threadSort.test.ts`, `importSourcePresentation.test.ts`, `previewAutomationClientId.test.ts`, `providerUpdateDismissal.test.ts`, CR `preview.test.ts`

### New test helper

`tests/apps/server/provider/Layers/acpImportLineageTestHelpers.ts` (SRV-M6; both Cursor+Grok drivers remain)

### Restores / wrong verdicts

- **PKG-D1 restored:** replacement preview-host connections need a direct concurrency-key boundary test; no higher lifecycle test covered the key.
- **PKG-M13 corrected:** retained one compact direct table for starting/running sessions and pending approval/user-input blockers.
- One mechanical CursorAdapter import fix after helper extract (not a wrong prune verdict).

### Safety Keeps verified post-run

- ProjectionPipeline stale approvals **and** stale user-input both present
- CheckpointReactor imported-backfill skip + native retain both present
- PKG-S1 active-pin reps (merged PR + stale inactivity) both present
- direct `canSettle` session/request blockers present
- replacement preview-host concurrency isolation present
- ImportSessionsPanel P1–P6 present
- Cursor + Grok both import lineage helpers
- ACP hang ≥1 representative (`hang-load-no-replay`) retained
- GitManager sticky PR / ProviderRegistry re-probe clusters not touched

### Focused re-run commands (by group) — all PASS

```text
G1: npx vp test run <touched package/desktop/web/mobile/server files> → PASS
G2: ClaudeAdapter ProviderRuntimeIngestion CheckpointReactor GitManager GitHubCli CodexTextGeneration TextGenerationPrompts → PASS (217; CheckpointReactor+GitManager 76 unsandboxed)
G3: server orch/provider 145; GitManager 63 unsandboxed; import parsers; desktop/web/packages 172; mobile layout/link/remote → PASS
G4: CR threadSort 8; Sidebar.logic 78 → PASS
G5: 17 files / 186 incl. ImportSessionsPanel P1–P6 → PASS
G6: packages 131; import/server/web 183; Cursor/Grok/Claude 114; mobile 54 → PASS
G7: 6 files / 89 → PASS
G8 review remediation: threadSettled + preview → PASS (2 files / 31)
```

### Deferred Simplify/Merge backlog (do not invent scope)

IMP-S1/S3/S6–S9; SRV-M11–M14/M16/M18–M22; SRV-S4–S8 (S7/S8 flaky Keep); SRV-S5/S6/S9–S24; WEB-S Sidebar/session-logic/composerDraftStore densify; WEB-M5–M7/M12; PKG-M6/M10/M15–M17 + PKG-S2–S31; DES-S1–S12 / DES-M3–M9; MOB-S1 / MOB-S5–S12 / MOB-M3/M5.

---

## Deferred backlog follow-up (2026-07-26 — “address all” densify pass)

**Mode:** Finish deferred Merge/Simplify backlog wherever safe without inventing scope or touching production source. Focused `npx vp test run` after clusters. **No commit.**

### Completed this pass

| ID | Action | Notes |
| -- | ------ | ----- |
| IMP-S1 | Simplify | C0/C1/bidi charset samples **6 → 3** (NUL id, NEL cwd, RLO id) |
| IMP-S3 | Simplify | List+load redaction merged to one case; assertion unions preserved (scan/scanAndLoad/batch + wire growth + load batch) |
| SRV-M11 | Merge | Normalizer `normalizeDispatchCommand` forged+happy → one case |
| SRV-M14 | Merge | CodexAdapter configured vs env launch-args → one case (SessionRuntime collaboration left distinct) |
| SRV-M19 | Already done | `commandInvariants` already only non-neg guard after O1–O3 |
| SRV-M22 | Already done | `clearProjectionTables` helper already present from Group 6 |
| SRV-S1–S3 | Already done | Applied in Group 6 |
| PKG-M6 | Merge | Folded knownEnvironment valid parse into entities diagnostics; deleted `knownEnvironment.test.ts` |
| PKG-M10 | Merge | Model descriptor apply/wire/read → one case |
| PKG-M15 | Simplify | `composerTrigger` mention+file-link → `it.each` tables |
| PKG-M16 | Simplify | `remote` host-normalize cluster → one `it.each` (relayUrl kept separate — different API) |
| PKG-M17 | Merge | threadReducer append/stream/latestTurn → one case; interim-running Keep separate |
| PKG-S (path/schemaJson) | Simplify | `path.test.ts` detector quartet → table; `schemaJson` extract trio → table |
| DES-M3 | Merge | brand-assets production+development maps → one case |
| DES-M4 | Merge | wslPathParsing empty/header/malformed → one negative case |
| DES-M5 | Merge | PickedElementPayload happy accepts → `it.each` |
| DES-M6 | Merge | Annotation accept + guest-screenshot reject → one case |
| DES-S5 | Simplify | oxlint Effect.run* samples **12 → 3** reps (runPromise/runSync/runFork) + ManagedRuntime Keep |
| DES-S6 | Simplify | public-config undefined-key enum → looped key table |
| WEB-S (Sidebar/session/ChatView) | Simplify | `isImportedShelfThread`, `isTrailingDoubleClick`, `shouldClearThreadSelectionOnMouseDown`, session `workEntryIndicatesToolFailure`, ChatView model-change block → tables |
| MOB-S (home/glass/nav/keyboard/review) | Simplify | homeListItems collapse+search merge; glass/adaptive-nav/keyboard/reviewAvailability → tables |

### Still deferred (precise reasons)

| ID | Reason |
| -- | ------ |
| IMP-S6 | Parser warning-shape cases assert **distinct** warning contents / omission paths across Claude/Codex/OpenCode — collapsing would invent “same shape” equivalence |
| IMP-S7 | Discovery deadline/byte-share/ACP timeout cases are distinct failure modes (TOCTOU-adjacent) — not safe to fold without guessing survivors |
| IMP-S8 | ImportService success envelopes sit next to unique idempotent/error/continuation cores — no clear redundant envelope-only cases left |
| IMP-S9 | No remaining per-source label-echo cases; HOME defaults completeness assert is the legitimate catalog check |
| SRV-M12 | Settle already combines approval+user-input; snooze “blocked-on-you” is a different command domain — cross-file merge would invent shared gate table |
| SRV-M13 | ProjectionThreads `originJson` fixtures are wiring stubs, not duplicate of contracts origin-forge suite |
| SRV-M16 | No parallel AcpSessionRuntime reconnect twin pair found; remaining ACP cases cover distinct load/prompt/cancel paths |
| SRV-M18 / SRV-S4 | Shared `OrchestrationEngineHarness.integration.ts` already exists; further extract touches Effect Layer wiring — high redesign risk |
| SRV-M20 | `ProviderRuntimeIngestion.approval.test.ts` already tiny (33 LOC); flush merge done in M2 |
| SRV-M21 | After O4/O5, remaining CheckpointReactor scaffolding still distinct; **Keep** imported-backfill `:735` + native retain `:791` |
| SRV-S5 | Claude stream maps are Keep-cases with distinct SDK event shapes; effort tables already densified — further trim invents survivors |
| SRV-S6 | Ingestion megafile still large but remaining cases are distinct event paths; table-drive would be speculative |
| SRV-S7–S8 | **Skipped** — flaky Keep clusters (GitManager sticky PR / ProviderRegistry re-probe); noise-only not applied |
| SRV-S9–S24 | Area audit names only “assorted densify” without concrete over-param matrices — left rather than invent |
| WEB-M5–M7/M12 | Hover CSS already Deleted; skill/import maps Deleted; webview constants cross-surface merge unclear without desktop owner change |
| WEB-S Sidebar/session/composerDraftStore residual | Large suites still have distinct logic cases after table densify of clear clusters; further collapse invents |
| PKG-S2–S31 residual | threadSnoozed/agentAwareness/auth/shell batches are Keep or lack clear over-param targets beyond path/schemaJson/remote/composerTrigger done here |
| DES-S1–S4 / S7–S12 | Manager/DesktopWindow harnesses already shared; remaining IPC/settings densify lacks concrete duplicate pairs |
| DES-M7–M9 | Cross-module window/settings/IPC readiness overlaps not evidenced as duplicate asserts in remaining suites |
| MOB-S1 | nativeMarkdown chunk matrices still protect distinct AST shapes (prior deferral stands) |
| MOB-M3/M5 | Cross-client pierre icon tautology + share-state overlap — no safe single-owner merge without deleting Keep feature suites |
| MOB-S residual | model/provider options already single-case; layout pane cases remain distinct breakpoint behaviors |

### Re-run (this pass) — all PASS

```text
Cluster A (15 files): acpImport Normalizer CodexAdapter model composerTrigger remote entities threadReducer wslPathParsing PickedElementPayload brand-assets public-config oxlint Sidebar.logic session-logic → 299 PASS
Cluster B (4 files): homeListItems glass adaptive-navigation hardwareKeyboardCommands → 22 PASS
Cluster C (4 files): path schemaJson ChatView.logic reviewAvailability → 64 PASS
```

**Restores:** none.

### Cases/LOC shed this pass

- Named `it`/`it.effect` folded: ~35–45 (merges + tables)
- Cartesian/matrix sample rows: IMP-S1 −3; DES-S5 −9 Effect.run* samples
- Whole file deleted: `tests/packages/client-runtime/environment/knownEnvironment.test.ts`
- Rough LOC: net down on densified files (exact delta varies; no production source touched)

---

## Approval Request

**Superseded.** User approved “address all” Groups 1–7; Execution Log above is authoritative.

---

## Verification Performed

- Framework / runner: Vite+ / Vitest / `@effect/vitest`; `tests/` mirror; **no coverage-% gate**.
- Audit + **approved execution** Groups 1–7 with focused `npx vp test run` after each group.
- WEB-D21–D34 expanded to exact `it` names before Group 5 deletes.
- Safety Keeps re-checked after execution.

## Not Run / Limitations

- Full ~7.1k-case suite was **not** executed; CI owns full-suite verification.
- Deferred densify follow-up applied; remaining Med densifies still deferred with per-ID reasons in Execution Log follow-up section.
- Known flaky tests remain Keep; flake is not a prune reason.
- Keep tradeoffs left in place: ProjectionPipeline stale pair; CheckpointReactor imported-backfill + native retain; GitHubCli decode; GitManager non-repo vs deleted dir; Claude stream maps; Cursor↔Grok dual drivers; import live/TOCTOU/continuation; active-pin in settle table; ACP ≥1 hang case.
