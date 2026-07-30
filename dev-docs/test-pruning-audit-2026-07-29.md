# Test Pruning Audit (456code — whole codebase)

**Last Updated:** 2026-07-29
**Scope:** Entire `tests/` tree — `tests/apps/server` (~198 files / ~1904 cases), `tests/apps/web` (169 / ~1448), `tests/packages` (108 / ~800+), and other (`tests/apps/mobile`, `desktop`, `scripts`, `oxlint-plugin-456code`; 158 / ~959). Residual after the 2026-07-26 server prune — do not re-flag items already removed in that pass.
**Test Setup:** Vite+ / Vitest / `@effect/vitest`; tests live only under repo-root `tests/` (mirrors source with `src` dropped); no coverage gate.
**Mode:** Implementation complete — removals applied as of 2026-07-29.
**Sources:** Four area audits (server / web / packages / other). Area audits were thorough; some megafiles were sampled rather than line-by-line.

## Summary

- **Flagged:** ~107 tests/cases — **26 Delete / 24 Merge / 37 Simplify / ~39 Keep** (area counts: Server 2/5/9/8; Web ~19/~12/~14/~19; Packages 3/6/12/7; Other 2/1/2/5).
- **Estimated shed:** ~75–90 cases if all Delete+Merge are approved (~12–18 server + ~45–55 web + ~11 packages + ~7 other). Approving High/Med Simplifies adds ~45–65 more case reductions without dropping files.
- **Most worth removing:**
  1. **WEB-D1** — `diffCollapse.test.ts` entire file (tautological / trivial)
  2. **MOB-D1 / MOB-D2** — one-liner / ternary trivial suites
  3. **SRV-D1 / SRV-D2** — dead helper + trivial metric label normalize
  4. **PKG-D1–D3** — settings/fork duplicates already covered by ConfigMap / sibling cases
  5. **WEB-D3–D7 / WEB-D9–D10** — type-guard smokes, LRU miss, hash/revision tautologies, mirror helpers
- **Safety tradeoffs:** **WEB-D14 (`assetUrls`) must relocate to `client-runtime` first — do not bare-delete.** **WEB-D8 (`browserRecordingScope`)** is accepted-trivial sole coverage — delete only with eyes open. No coverage gate. Server Deletes do not drop important live coverage.
- **Recommended next move:** ~~Approve **Group 1**…~~ **Done** — user approved addressing **all** findings; implementation complete (see below).

## Implementation status (2026-07-29)

User approved addressing **ALL** findings. Removals / merges / simplifies applied as of 2026-07-29.

### Applied

- **Mobile** ([agent]): MOB-D1, D2, M1, S1, S2 — deleted native-glass + git-overview-navigation files; filePath merge; appearance/terminalTheme simplifies. Tests: 3 files, 13 passed.
- **Packages**: All PKG-D1–D3, M1–M6, S1–S12 — 13 files edited; 183 passed.
- **Server**: SRV-D1–D2, M1–M5, S1–S6 applied; SRV-S7–S9 skipped (Low/speculative megafile densify). Also removed unused `requireNonNegativeInteger` from `apps/server/src/orchestration/commandInvariants.ts`. Focused re-runs green (48+174+18).
- **Web**: All WEB-\* Delete/Merge/Simplify — relocated assetUrls→`tests/packages/client-runtime/state/assets.test.ts`, createDebouncedStorage→`tests/apps/web/lib/storage.test.ts`; deleted diffCollapse, PreviewPanelShell, browserRecordingScope, useThreadActions, assetUrls web tests; merges+simplifies done. WEB-D11–D13 had no extra named targets. 31 files / 462 tests passed.

### Intentionally not applied

- SRV-S7–S9 (Low megafile scaffolding — no concrete survivors without inventing)
- All Keep / verified-valuable items left in place

### Verification

Each area ran focused `vp test run` on affected files and reported green. Full-suite was not run (per AGENTS.md).

---

### Prior prune note (2026-07-26)

A server-side pruning pass already landed on 2026-07-26. This audit is the **residual** after that pass. Do not re-open or re-flag tests already removed then; IDs and paths below are current-tree only.

---

## Setup Detected

- **Framework / runner:** Vite+ (`vp test run`) wrapping Vitest; server/effect suites also use `@effect/vitest`. Per-package `vite.config.ts` sets `test.dir` into the mirrored `tests/` tree (e.g. `apps/server` → `tests/apps/server`). Focused runs: `vp test run <test-files>`.
- **Conventions:** No colocated tests outside `tests/`. Layout mirrors source with the `src` segment dropped. `tests/package.json` is resolution-only — modules imported (including `vi.mock(...)` targets) must be declared there. AGENTS.md: keep local verification focused; do not run full-suite as routine completion.
- **Fixtures / mocks:** Effect layers / test services on server; React Testing Library + hooks on web/mobile; contract Schema decode tables in packages; `vi.mock` for I/O boundaries. Server suite disables file parallelism and raises timeouts for sqlite/git/orchestration load.
- **Coverage gate / mandated tests:** **None.** No coverage thresholds in Vite configs; AGENTS.md does not mandate specific cases. Removals are not gate-blocked.

---

## Findings

_One row per High/Med candidate. Verdict: Delete / Merge / Simplify / Keep. Delete & Merge name covering tests where applicable. Confidence High / Med / Low — Delete held to High where possible. Low Simplifies summarized in a deferred list at the end of this section._

| ID          | Test / Case                                            | Location                                                                 | Claims to protect            | Verdict         | Conf    | Evidence                                                                              | Covered elsewhere by                             |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------- | --------------- | ------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| SRV-D1      | `requires non-negative integers`                       | `tests/apps/server/orchestration/commandInvariants.test.ts`              | non-neg int helper           | Delete          | High    | Dead unused `requireNonNegativeInteger` helper — trivial-coverage of dead code        | N/A (helper unused in production)                |
| SRV-D2      | `groups GPT-family models under a shared metric label` | `tests/apps/server/observability/Attributes.test.ts`                     | model metric label normalize | Delete          | High    | Trivial `normalizeModelMetricLabel` mapping                                           | Adjacent Attributes cases / metric label usage   |
| SRV-M1      | Metrics pipe ↔ direct twin                             | `tests/apps/server/observability/Metrics.test.ts`                        | same metric emission path    | Merge           | High    | Pipe-style and direct-style assert the same path                                      | Survive one style; preserve union of assertions  |
| SRV-M2      | win32 hostname twin                                    | `tests/apps/server/environment/ServerEnvironmentLabel.test.ts`           | hostname label on win32      | Merge           | High    | Near-duplicate win32 hostname cases                                                   | Single win32 case                                |
| SRV-M3      | Claude version-gate sextet                             | `tests/apps/server/provider/Layers/ProviderRegistry.test.ts`             | Claude version gate matrix   | Merge           | High    | Six near-identical version-gate cases → table                                         | One table-driven case                            |
| SRV-M4      | Codex title sanitize pair                              | `tests/apps/server/…` (Codex title sanitize)                             | title sanitization           | Merge           | High    | Pair covers same sanitize path                                                        | One survivor                                     |
| SRV-M5      | ProviderService stale sendTurn densify                 | `tests/apps/server/…` (ProviderService)                                  | stale sendTurn               | Merge           | High    | Overlapping stale-send densification cases                                            | Densified survivor                               |
| SRV-S1      | `expandHomePath` permutations                          | server path helpers                                                      | home expansion               | Simplify        | Med     | Over-parametrized path variants                                                       | -                                                |
| SRV-S2      | imageMime alphabet cluster                             | server imageMime                                                         | MIME alphabet                | Simplify        | High    | Alphabet cluster exhaustive; **keep** stack-overflow + prototype-pollution            | -                                                |
| SRV-S3      | checkpoint Errors string brittleness                   | checkpoint Errors tests                                                  | error messages               | Simplify        | High    | Pins exact strings — impl-detail brittleness                                          | -                                                |
| SRV-S4      | Claude effort matrix trim                              | ProviderRegistry / Claude                                                | effort matrix                | Simplify        | Med     | Combinatorial matrix → representatives                                                | -                                                |
| SRV-S5      | ACP charset optional                                   | ACP charset tests                                                        | optional charset             | Simplify        | Med     | Optional charset over-parametrized                                                    | -                                                |
| SRV-S6      | ActivityPayloadProjection unused fixtures              | ActivityPayloadProjection                                                | projection fixtures          | Simplify        | Med     | Unused / dead fixtures inflate suite                                                  | -                                                |
| SRV-S7–S9   | megafile scaffolding + residual Low                    | various server megafiles                                                 | scaffolding                  | Simplify        | Low     | Sampled megafile scaffolding noise                                                    | -                                                |
| WEB-D1      | `diffCollapse` suite                                   | `tests/apps/web/lib/diffCollapse.test.ts`                                | collapse helpers             | Delete          | High    | Entire file trivial / tautological                                                    | Higher-level diff UI coverage                    |
| WEB-D2      | `getPreviewPanelMaxWidth`                              | `tests/apps/web/components/preview/PreviewPanelShell.test.ts`            | max width helper             | Delete          | High    | Trivial getter/math                                                                   | Panel integration cases                          |
| WEB-D3      | `ThreadArchiveBlockedError` type-guard smoke           | `useThreadActions` tests                                                 | Schema/type-guard            | Delete          | High    | Type-guard / Schema smoke only                                                        | Schema package / action flow tests               |
| WEB-D4      | ProviderSettingsForm `typeof` trio                     | ProviderSettingsForm tests                                               | typeof checks                | Delete          | High    | Type-level typeof smokes                                                              | Form behavior cases                              |
| WEB-D5      | LRU miss                                               | web LRU tests                                                            | cache miss                   | Delete          | High    | Vacuous miss assertion                                                                | Eviction/promote (merge survivor)                |
| WEB-D6      | diffRendering hash tautologies                         | diffRendering tests                                                      | content hash                 | Delete          | High    | Asserts hash equals itself / setup                                                    | Real render cases                                |
| WEB-D7      | fileContentRevision stability tautology                | fileContentRevision tests                                                | revision stability           | Delete          | High    | Tautological stability assert                                                         | Real revision flow                               |
| WEB-D8      | `browserRecordingScope` suite                          | `tests/apps/web/browser/browserRecordingScope.test.ts`                   | recording scope              | Delete          | Med     | Accepted-trivial; **sole** coverage of this module                                    | None — tradeoff (see Safety)                     |
| WEB-D9      | `getTimestampFormatOptions` mirror                     | timestamp format helper test                                             | format options               | Delete          | High    | Mirrors implementation constants                                                      | Consumers of format options                      |
| WEB-D10     | `useDiscoveredLocalServers` listening duplicate        | hook tests                                                               | listening state              | Delete          | High    | Duplicate of listening coverage                                                       | Sibling listening case                           |
| WEB-D11–D13 | residual High/Med deletes (~3–9)                       | various web                                                              | trivial / tautological       | Delete          | Med     | Area audit total ~19; highest named above                                             | Named covering suites in area audit              |
| WEB-D14     | `assetUrls` suite                                      | `tests/apps/web/assets/assetUrls.test.ts`                                | asset URL helpers            | Delete→Relocate | High    | **Do not bare-delete** — move to `client-runtime` first                               | Target: `tests/packages/client-runtime/…`        |
| WEB-D15     | `createDebouncedStorage`                               | web storage helper test                                                  | debounced storage            | Delete→Relocate | High    | Relocate to `lib/storage.test.ts` rather than drop                                    | `tests/apps/web/lib/storage.test.ts` (or create) |
| WEB-M1      | LocalStorage errors table                              | LocalStorage tests                                                       | error paths                  | Merge           | High    | Multi-case errors → one table                                                         | Table survivor                                   |
| WEB-M2      | filePathDisplay abs vs markdown-links                  | filePathDisplay tests                                                    | path display                 | Merge           | High    | Abs-path vs markdown-link twins                                                       | One survivor                                     |
| WEB-M3      | LRU eviction + promote                                 | LRU tests                                                                | eviction/promote             | Merge           | High    | Overlapping eviction/promote                                                          | One densified case (after WEB-D5)                |
| WEB-M4      | ThreadStatusIndicators branch mismatch                 | ThreadStatusIndicators                                                   | branch status                | Merge           | High    | Duplicate branch-mismatch path                                                        | Survivor in `.ts` / `.tsx` pair                  |
| WEB-M5      | `normalizeCompactToolLabel` twins                      | tool label helpers                                                       | compact labels               | Merge           | High    | Same normalize path                                                                   | One survivor                                     |
| WEB-M6      | composer triggers                                      | composer trigger tests                                                   | trigger wiring               | Merge           | High    | Overlapping trigger cases                                                             | One survivor                                     |
| WEB-M7      | draft clear / sticky                                   | composer draft tests                                                     | clear vs sticky              | Merge           | High    | Overlapping draft lifecycle                                                           | One survivor (keep persist/sanitize Keep)        |
| WEB-M8      | breadcrumbs                                            | breadcrumb tests                                                         | crumb path                   | Merge           | Med     | Duplicate breadcrumb coverage                                                         | One survivor                                     |
| WEB-M9      | `hasSelection`                                         | selection helpers                                                        | selection                    | Merge           | Med     | Duplicate hasSelection                                                                | One survivor                                     |
| WEB-M10     | worktree display                                       | worktree display tests                                                   | display string               | Merge           | Med     | Overlapping display cases                                                             | One survivor                                     |
| WEB-M11     | promptStash scope                                      | promptStash tests                                                        | stash scope                  | Merge           | Med     | Scope overlap                                                                         | One survivor                                     |
| WEB-M12     | residual web merge                                     | various                                                                  | shared paths                 | Merge           | Med     | Completes ~12 Merge count                                                             | Survivor per area audit                          |
| WEB-S1      | Sidebar detail `each`                                  | Sidebar tests                                                            | sidebar detail               | Simplify        | Med     | Over-parametrized each                                                                | -                                                |
| WEB-S2      | worktree falsy variants                                | worktree tests                                                           | falsy inputs                 | Simplify        | Med     | Exhaustive falsy                                                                      | -                                                |
| WEB-S3      | GitActions menu pairing sample                         | GitActions tests                                                         | menu pairing                 | Simplify        | Med     | Sample pairing; keep scenario Keeps                                                   | -                                                |
| WEB-S4      | provider option `each`                                 | provider option tests                                                    | options                      | Simplify        | Med     | Over-parametrized each                                                                | -                                                |
| WEB-S5      | ImportSessionsPanel plurals                            | ImportSessionsPanel                                                      | plural copy                  | Simplify        | Low–Med | Plural string matrix                                                                  | -                                                |
| WEB-S6      | Keybindings mega                                       | keybindings tests                                                        | bindings                     | Simplify        | Med     | Megafile sampled — trim permutations; **keep** core bindings                          | -                                                |
| WEB-S7      | pierre icons                                           | pierre icon tests                                                        | icon map                     | Simplify        | Med     | Exhaustive icon matrix                                                                | -                                                |
| WEB-S8      | browser credential pair                                | browser credential tests                                                 | credentials                  | Simplify        | Med     | Pair can densify                                                                      | -                                                |
| WEB-S9      | preview stale twin                                     | preview stale tests                                                      | stale state                  | Simplify        | Med     | Twin cases                                                                            | -                                                |
| WEB-S10     | PR URL matrix                                          | PR URL tests                                                             | URL shapes                   | Simplify        | Med     | Exhaustive URL matrix                                                                 | -                                                |
| WEB-S11     | sidebar CSS snapshots                                  | Sidebar CSS snapshots                                                    | class/CSS                    | Simplify        | High    | Brittle snapshot / CSS pins                                                           | -                                                |
| WEB-S12     | QR custom color                                        | QR tests                                                                 | custom color                 | Simplify        | Med     | Custom color perm; **keep** default contrast                                          | -                                                |
| WEB-S13–S14 | residual web Simplifies                                | various                                                                  | over-param                   | Simplify        | Low–Med | Completes ~14 Simplify count                                                          | -                                                |
| PKG-D1      | settings multi-instance map decode                     | `tests/packages/…` settings                                              | multi-instance map           | Delete          | High    | Covered by providerInstance ConfigMap                                                 | providerInstance ConfigMap decode                |
| PKG-D2      | settings slug-key reject                               | settings tests                                                           | slug-key reject              | Delete          | High    | Covered by ConfigMap reject path                                                      | ConfigMap slug reject                            |
| PKG-D3      | fork `ProviderInstanceRef` duplicate                   | fork / provider instance                                                 | ProviderInstanceRef          | Delete          | High    | Duplicate of sibling fork case                                                        | Sibling ProviderInstanceRef case                 |
| PKG-M1      | settings fork patch                                    | settings fork tests                                                      | fork patch                   | Merge           | High    | Overlapping fork-patch paths                                                          | One survivor                                     |
| PKG-M2      | cliArgs empty variants                                 | cliArgs tests                                                            | empty args                   | Merge           | High    | Empty-variant twins                                                                   | One empty case                                   |
| PKG-M3      | terminal missing `terminalId` twins                    | terminal event tests                                                     | missing id                   | Merge           | High    | Twin missing-id cases                                                                 | One survivor                                     |
| PKG-M4      | preview process metadata                               | preview metadata tests                                                   | process metadata             | Merge           | High    | Overlapping metadata asserts                                                          | One survivor                                     |
| PKG-M5–M6   | composerInlineTokens scoped pkgs                       | composerInlineTokens across pkgs                                         | token scopes                 | Merge           | Med     | Cross-package duplicate scopes                                                        | Single package survivor                          |
| PKG-S1      | slug matrix                                            | settings slug                                                            | slug shapes                  | Simplify        | Med     | Exhaustive slug matrix                                                                | -                                                |
| PKG-S2      | keybindings command catalog                            | keybindings catalog                                                      | command list                 | Simplify        | Med     | Catalog exhaustiveness                                                                | -                                                |
| PKG-S3      | TerminalEvent / Preview union smokes                   | contracts unions                                                         | union decode                 | Simplify        | Med     | Union smoke overbreadth                                                               | -                                                |
| PKG-S4      | glassOpacity mid                                       | glass opacity                                                            | mid values                   | Simplify        | Med     | Mid-range perm noise                                                                  | -                                                |
| PKG-S5      | sidebarAutoSettle rejects                              | sidebar auto-settle                                                      | reject paths                 | Simplify        | Med     | Reject matrix trim                                                                    | -                                                |
| PKG-S6      | cliArgs chrome flags                                   | cliArgs chrome                                                           | chrome flags                 | Simplify        | Med     | Flag permutations                                                                     | -                                                |
| PKG-S7      | loopback hosts                                         | loopback host list                                                       | host strings                 | Simplify        | Med     | Host string exhaustiveness                                                            | -                                                |
| PKG-S8      | filePreview ext matrix                                 | filePreview                                                              | extensions                   | Simplify        | Med     | Ext matrix; keep escape + SVG after MOB-M1                                            | -                                                |
| PKG-S9      | path helpers                                           | shared path helpers                                                      | path ops                     | Simplify        | Med     | Over-param path helpers                                                               | -                                                |
| PKG-S10     | threads-atoms TTL tautology                            | threads atoms                                                            | TTL                          | Simplify        | High    | Tautological TTL assert                                                               | -                                                |
| PKG-S11     | provider start payloads                                | provider start                                                           | payloads                     | Simplify        | Med     | Payload permutation trim                                                              | -                                                |
| PKG-S12     | terminalLabels                                         | terminal labels                                                          | label map                    | Simplify        | Med     | Label matrix                                                                          | -                                                |
| MOB-D1      | `native-glass-capability` suite                        | `tests/apps/mobile/lib/native-glass-capability.test.ts`                  | glass capability             | Delete          | High    | Android one-liner trivial-coverage                                                    | N/A (trivial)                                    |
| MOB-D2      | `git-overview-navigation` suite                        | `tests/apps/mobile/features/threads/git/git-overview-navigation.test.ts` | nav ternary                  | Delete          | High    | Ternary / trivial navigation helper                                                   | Higher-level git overview UI                     |
| MOB-M1      | mobile filePath preview wrappers                       | mobile filePath preview tests                                            | preview wrappers             | Merge           | High    | Thin wrappers over shared filePreview — merge into shared; **keep** path escape + SVG | `tests/packages/…/filePreview.test.ts`           |
| MOB-S1      | appearancePreferences formula snapshots                | appearancePreferences                                                    | formula snapshots            | Simplify        | Med     | Snapshot formula pins                                                                 | -                                                |
| MOB-S2      | terminalTheme hex pins                                 | terminalTheme tests                                                      | hex colors                   | Simplify        | Med     | Hex pins; **keep** Ghostty regression                                                 | -                                                |

### Detail (for findings that need more than a row)

#### SRV-D1. Dead `requireNonNegativeInteger` helper case

**Verdict:** Delete
**Location:** `tests/apps/server/orchestration/commandInvariants.test.ts`
**Category:** Trivial-coverage / Vacuous (dead code)
**Hypothesis:** Protects an unused helper that production no longer calls.
**Evidence:** Case exercises `requireNonNegativeInteger`; helper is unused in live orchestration command paths. Removing the case does not drop coverage of live invariants.
**Covered elsewhere by:** N/A — production path does not use the helper. (If the helper is later deleted from source, that is a separate source cleanup — not required for this prune.)

#### WEB-D14. `assetUrls` — relocate gate (do not bare-delete)

**Verdict:** Delete only after relocate
**Location:** `tests/apps/web/assets/assetUrls.test.ts`
**Category:** Misplaced coverage (belongs in client-runtime)
**Hypothesis:** Behavior is real but the suite belongs next to shared runtime, not web-only.
**Evidence:** Helpers are shared client-runtime concerns. Bare-deleting from web would drop coverage before a home exists under `tests/packages/client-runtime/`.
**Covered elsewhere by:** After relocate — the new client-runtime suite. **Block bare-delete until relocate lands.**

#### WEB-D8. `browserRecordingScope` — sole trivial coverage

**Verdict:** Delete (tradeoff) or Keep-or-improve
**Location:** `tests/apps/web/browser/browserRecordingScope.test.ts`
**Category:** Trivial-coverage; sole coverage of module
**Hypothesis:** Suite is accepted-trivial but is the only coverage of `browserRecordingScope`.
**Evidence:** Area audit accepted it as trivial sole coverage. Deleting drops the only net on this module; improving (assert real scope lifecycle / cleanup) is preferred if the module stays load-bearing. Related Keep: `browserRecording` + `desktopTabLifetime` stay.
**Covered elsewhere by:** None.

#### WEB-D15. `createDebouncedStorage` — relocate to storage suite

**Verdict:** Delete after relocate / Merge-into
**Location:** web storage helper test (createDebouncedStorage)
**Category:** Redundant placement
**Hypothesis:** Belongs in `lib/storage.test.ts` with sibling storage coverage.
**Evidence:** Relocate into `tests/apps/web/lib/storage.test.ts` (create if needed), then drop the orphan file — do not lose debounce timing/flush asserts.
**Covered elsewhere by:** Target storage suite after relocate.

#### MOB-M1. Mobile filePath preview wrappers → shared

**Verdict:** Merge
**Location:** mobile filePath preview wrapper tests → `filePreview.test.ts`
**Category:** Redundant / thin wrapper
**Hypothesis:** Mobile wrappers re-test shared filePreview behavior.
**Evidence:** Fold into shared `filePreview.test.ts`. **Preserve** path-escape and SVG cases (called out as keep-within-merge).
**Covered elsewhere by:** Shared filePreview survivor (plus PKG-S8 trim of ext matrix separately).

#### SRV-S2. imageMime alphabet — trim, keep security regressions

**Verdict:** Simplify
**Location:** server imageMime tests
**Hypothesis:** Alphabet cluster is exhaustive noise; stack-overflow and prototype-pollution cases are real.
**Evidence:** Trim alphabet permutations. **Do not touch** stack-overflow or prototype-pollution cases (also listed under Keep).
**Trim to:** Representative MIME happy-path + the two security regressions.

### Deferred Low Simplifies (not in main table rows)

Sampled megafile / Low-confidence trims deferred unless a later pass expands them:

- Server megafile scaffolding (SRV-S7–S9 Low)
- Residual unnamed web Simplifies completing the ~14 count
- Package mid-value permutation trims already listed as PKG-S\* at Med — execute after Deletes/Merges
- Appearance / theme cosmetic pins beyond MOB-S1/S2

---

## Keep / Verified-Valuable

_Questionable-looking tests checked (in area audits) against code and confirmed to protect real, breakable behavior. Do not re-litigate next audit without new evidence._

### Server

- **ProjectionPipeline stale approval vs user-input** — distinct stale paths; not duplicates.
- **CheckpointReactor imported vs native** — dual import/native paths matter.
- **ProviderRegistry `binaryPath` re-probe** — known flake surface; still protects probe ordering (do not Delete for flakiness alone).
- **GitManager PR metadata** — known timeout flake; protects cross-repo PR metadata.
- **Cursor ↔ Grok lineage** — provider lineage invariant.
- **cliAuthFormat** — auth format contract.
- **PersistenceDecodeError** — decode/error boundary.
- **imageMime stack-overflow (+ prototype pollution)** — security regressions; keep when trimming alphabet (SRV-S2).

### Web

- **useImportSessions** — import session orchestration / state.
- **requestLatencyState** — latency state machine.
- **ImportSessionsPanel** — panel behavior (plural copy may Simplify; core stays).
- **ConnectionsSettings WSL** — WSL connection path.
- **session-logic** — core session logic.
- **GitActions scenarios** — real git action scenarios (menu pairing sample may Simplify).
- **composerDraft persist / sanitize** — persist + sanitize invariants (clear/sticky may Merge).
- **keybindings** — core bindings (mega permutations may Simplify).
- **auth / pairing / DPoP** — auth critical path.
- **wslPaths** — WSL path correctness.
- **browserRecording + desktopTabLifetime** — recording/tab lifetime (distinct from WEB-D8 scope suite).
- **markdown** — ChatMarkdown / rendering behavior.
- **modelSelection** — model selection logic.
- **SafeDocumentRenderer / explorer** — document safety / explorer.
- **QR default contrast** — contrast regression (custom color may Simplify).
- **branding** — brand asset/behavior.
- **ThreadStatusIndicators `.ts` + `.tsx`** — both layers earn keep (branch mismatch may Merge within).
- **ComposerPrimaryActions** — sole coverage; **improve**, do not Delete.
- **AppRoot** — do **not** Delete; root wiring is load-bearing even if heavy.

### Packages

- **filesystem / project legacy errors** — legacy error contracts.
- **ModelSelection migration** — migration correctness.
- **DPoP scheme** — security scheme.
- **semver stringifiable** — stringifiable edge.
- **Chrome preset order** — preset ordering invariant.
- **preview concurrency key** — concurrency keying.
- **nextTerminalId** — id allocation.
- **secret redaction** — redaction safety.
- **thread reducers** — reducer invariants.
- **effect-acp / effect-codex / ssh** — package integration surfaces (sampled; treat as Keep unless a later pass proves otherwise).

### Other (mobile / desktop / scripts / oxlint)

- **ThreadComposer blocked notice** — blocked UX; **improve** if thin, do not Delete.
- **reviewState atoms** — review state machine.
- **scrollEdgeEffects regression** — hard-won scroll/edge regression.
- **DesktopDetachedActionErrors** — detached action error surface.
- **WebviewPreferences security string** — security-sensitive preference string.
- **WSL / layout / adaptive-nav / oxlint / release scripts** — keep; not flagged for removal.

---

## Safety Check

_Does any Delete or Merge drop the only coverage of important behavior, or break a coverage gate?_

| ID                | Removal                              | Risk     | What it would drop                                  | Resolution                                                                                                                                                |
| ----------------- | ------------------------------------ | -------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WEB-D14           | Bare-delete `assetUrls`              | **High** | Only web-local coverage of shared asset URL helpers | **Block bare-delete.** Relocate to `tests/packages/client-runtime/` first, then remove web copy.                                                          |
| WEB-D8            | Delete `browserRecordingScope`       | Med      | Sole coverage of `browserRecordingScope` module     | Accepted-trivial tradeoff: Delete only knowingly, or Keep-or-improve with real lifecycle asserts. Related browserRecording/desktopTabLifetime Keeps stay. |
| WEB-D15           | Bare-delete `createDebouncedStorage` | Med      | Debounce/storage helper coverage                    | Relocate into `lib/storage.test.ts` first.                                                                                                                |
| SRV-D1            | Delete non-negative integer case     | Low      | Coverage of **unused** helper only                  | Safe — does not drop live command-invariant coverage. Optional follow-up: delete dead helper in source (separate change).                                 |
| MOB-M1            | Merge mobile preview wrappers        | Low      | Thin wrapper cases                                  | Safe if path-escape + SVG preserved in shared `filePreview.test.ts`.                                                                                      |
| PKG-D1–D3         | Delete settings/fork duplicates      | Low      | Duplicate decode/reject paths                       | Named covering tests: ConfigMap multi-instance / slug reject; sibling ProviderInstanceRef.                                                                |
| WEB-D1–D7, D9–D10 | Trivial/tautology Deletes            | Low      | No important sole paths                             | Safe — covering or higher-level suites named in area audit.                                                                                               |
| SRV-D2, MOB-D1–D2 | Trivial Deletes                      | Low      | One-liners / ternary / label normalize              | Safe.                                                                                                                                                     |
| —                 | Coverage gate                        | None     | N/A                                                 | **No coverage gate** in Vite configs or AGENTS.md.                                                                                                        |

_No other Delete/Merge drops the only coverage of important live behavior. ComposerPrimaryActions and AppRoot stay Keep (improve / do not Delete)._

---

## Recommended Removal Sequence

_Lowest-risk, self-contained removals first. Each group is approve-able on its own. Re-run the affected package/files after each group (`vp test run <paths>`)._

### Group 1: Trivial Deletes — other + server + packages (Lowest risk)

- Findings: **MOB-D1, MOB-D2, SRV-D1, SRV-D2, PKG-D1, PKG-D2, PKG-D3**
- One-liners, dead helper, trivial label normalize, settings/fork duplicates with named covering tests.
- Delete outright; re-run the touched test files / packages.

### Group 2: Clearest web tautologies / type-guard smokes (Low risk)

- Findings: **WEB-D1, WEB-D2, WEB-D3, WEB-D4, WEB-D5, WEB-D6, WEB-D7, WEB-D9, WEB-D10** (+ residual WEB-D11–D13 if approved by name from area audit)
- Entire `diffCollapse` file, max-width helper, Schema/typeof smokes, LRU miss, hash/revision tautologies, timestamp mirror, listening duplicate.
- Re-run `tests/apps/web` focused paths after.

### Group 3: Relocate-gated web moves (Med risk — gate for go-ahead)

- Findings: **WEB-D14, WEB-D15**
- Relocate `assetUrls` → client-runtime tests; relocate `createDebouncedStorage` → `lib/storage.test.ts`; only then delete orphans.
- Re-run web + client-runtime after relocate.

### Group 4: Optional sole-coverage tradeoff (Med — explicit approval)

- Findings: **WEB-D8**
- Delete `browserRecordingScope` only if accepting loss of sole trivial coverage, or replace with a stronger lifecycle test (Keep-or-improve).

### Group 5: Merges — densify without dropping asserts (Med risk)

- Findings: **SRV-M1–M5, WEB-M1–M12, PKG-M1–M6, MOB-M1**
- Preserve union of real assertions; table-drive where noted (Claude version-gate sextet, LocalStorage errors).
- MOB-M1: keep path escape + SVG in shared filePreview.
- Re-run per package after each sub-batch (server / web / packages / mobile).

### Group 6: High/Med Simplifies (Lower urgency)

- Findings: **SRV-S1–S6, WEB-S1–S12, PKG-S1–S12, MOB-S1–S2**
- Behavior-preserving trims (simplification-review mechanics once approved). Always preserve listed Keep islands (imageMime security, Ghostty, QR contrast, ImportSessions core, etc.).
- Deferred Low Simplifies only if Groups 1–5 are done and appetite remains.

### Group 7: Do not touch without re-audit

- All **Keep** rows above; flaky-but-valuable ProviderRegistry / GitManager; AppRoot; ComposerPrimaryActions (improve only); anything already removed in the **2026-07-26** server prune.

---

## Approval Request

Pick which to remove. Nothing is deleted, merged, or trimmed until you approve.

Suggested approval phrases:

- `do Group 1` — safest Deletes (MOB + SRV + PKG)
- `do Groups 1–2` — add clearest web Deletes
- `do Groups 1–3` — include relocate-gated WEB-D14/D15
- `delete the D's except WEB-D8 and WEB-D14` — Deletes with safety exclusions
- `merges only` / `do Group 5`
- `simplifies after deletes` / `do Group 6`
- `hand Groups 1–5 to phased-implementation`

For many removals across packages, hand approved groups to **phased-implementation** with this doc as the living source of truth; re-run affected suites between groups.

---

## Verification Performed

- Framework / runner detected from package Vite configs + AGENTS.md (`vp test run`, `test.dir` → `tests/…`); **no coverage gate** found in Vite configs.
- Four area audits merged: server residual post-2026-07-26 prune, web, packages, other (mobile/desktop/scripts/oxlint).
- File existence spot-checked for key Delete targets (`commandInvariants`, `Attributes`, `diffCollapse`, `PreviewPanelShell`, `browserRecordingScope`, `assetUrls`, `native-glass-capability`, `git-overview-navigation`, Metrics, ServerEnvironmentLabel, ProviderRegistry).
- Global ID scheme applied: `SRV-*`, `WEB-*`, `PKG-*`, `MOB-*`.
- Covering tests / relocate gates recorded for every High Delete and Merge called out in area summaries.
- Keep sections from all four areas merged and deduped.

## Not Run / Limitations

- **Read-only synthesis** — tests were not re-executed as part of this merge; area audits supplied the evidence. Re-run after any approved removal is mandatory.
- Area audits were thorough; **some megafiles were sampled** (server scaffolding, web keybindings mega, large package catalogs) — Low Simplifies deferred rather than forced.
- Web Delete count in the area audit was ~19; the highest-confidence named Deletes are ID'd above (WEB-D1–D10, D14–D15). Residual WEB-D11–D13 should be confirmed by name from the web area audit notes before deletion if those names were not carried into this merge.
- Exact `file:line` anchors for every Merge/Simplify were not re-derived in this synthesis pass — locations are file- or suite-level from area findings; open the named suite before editing.
- This audit does **not** claim the surviving suite is well-shaped beyond the candidates judged.
- Missing-test / gap work is out of scope (test-coverage-audit). In-place trim mechanics after approval belong to simplification-review / phased-implementation.
