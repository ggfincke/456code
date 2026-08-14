<!-- .plans/26-cartographer-absorption.md -->
<!-- preserves the cartographer absorption plan, implementation record, and review closeout -->

# Plan: Cartographer Monorepo Absorption

## Status

IMPLEMENTATION COMPLETE AND COMMITTED — P0-P5, release-boundary closeout, and F1-F21 remediation
are integrated into `fix/session-postmortem` at
`756068c1e0fd70b99985053abb32b8c22570f5a7`. Focused acceptance, the bounded web integration pass,
and the remaining acceptance limits are recorded below. This document does not assert that the
branch has been pushed or released.

### Historical supersession note (2026-08-09)

This plan remains the implementation record for absorbing Cartographer into the monorepo. Its
browser-presentation outcome is no longer the current product contract. The later native
architecture integration replaced `apps/atlas`, embedded iframes, authenticated Atlas context
URLs, desktop bearer interception, and packaged browser assets with ordinary 456code Proposal
Impact, Repository Atlas, and Architecture Scope resources backed by authorized bounded RPC
projections. Standing-project and current-worktree analysis lifecycles remain headless server
owners, and the core analysis/query engine plus CLI and MCP entry points remain supported.

Removal of the Cartographer `serve` and `embed-server` browser commands and the browser package
surface is an intentional breaking change. The phase-by-phase Atlas and presentation details below
are preserved as historical provenance; use
[`docs/integrations/cartographer.md`](../docs/integrations/cartographer.md) for the maintained
architecture and operator contract.

The verified integration train is:

- `7b0ad1da2` foundation stack
- `199d8ea12` standing project Atlas
- `dbfb8b3a0` diff-analysis stack, followed by `1bdb3ecbf` trust hardening
- `374755747` and `d6d4f3c68` project/diff lifecycle retention
- `32f829258`, `0bb3858a0`, `a9eaef465`, and `756068c1e` architecture tools, proposal links,
  release closeout, and final session-integration reconciliation

The 2026-08-08 M1-M5 performance matrix was instrumented and attempted but stopped before an
admissible cell at the user's wrap-up boundary; those candidates remain unmeasured and do not
change the On-demand default.

Produced by orchestrate run `carto-phase-plan-k4w9` (2026-08-06): per-phase pyramid of 8 luna
evidence sourcers -> 4 sol drafters -> 2 fable adversarial verifiers -> lead reconciliation.
Decided direction: `dev-docs/cartographer-first-class-scout-2026-08-06.md`.

Integration note (2026-08-08): the former `orch/carto-absorb-t6p2` worktree, protected-path counts,
and unstaged-tree statements below are historical execution provenance. They describe how the work
was isolated before integration, not the current branch state. This status section, the implemented
lifecycle reconciliation, the committed integration train, and the remaining acceptance limits are
authoritative.

### Historical execution record (2026-08-07)

- 456code base `40a2b10267bf9df970eadc45d69f14e6b45229aa`; live tree carries 114 uncommitted paths (incl. the 15 protected tray/menu-bar paths) — all ignored, never staged; work happens in a clean worktree on `orch/carto-absorb-t6p2`.
- Cartographer source `887eb8b64b3e57ea72ee15af5b2601921f7c6b53` + 58 dirty paths; import manifest + drop ledger + aggregate digests recorded by the p0-scout worker (run t6p2, broker job evidence).
- Safety refs cut: branch `safety/pre-cartographer-import-2026-08-07`, synthetic full-tree tag `snapshot/cartographer-import-p0-2026-08-07` (tree 39a84d6c9f2df92c8c5dcd2ae36b08b77c4b2220).
- Commit-1 deviation: `.plans/README.md` row deferred — the file is user-dirty in the live tree (protected); the row lands after the owner commits their work.

### Historical evidence baseline

- Cartographer source: `/Users/ggfincke/Projects/Applications/cartographer` @ `887eb8b` (+58 uncommitted paths; capture full 40-char SHA + dirty manifest with digests at execution time)
- 456code base: `40a2b10267bf9df970eadc45d69f14e6b45229aa` (+15 protected user-owned dirty paths: tray/menu-bar work incl. `.plans/README.md` — see coexistence protocol)
- Safety refs at execution: branch `safety/pre-cartographer-import-<date>`, synthetic full-tree tag `snapshot/cartographer-import-p0-<date>` built via temporary `GIT_INDEX_FILE` (read-tree base -> add -A -> write-tree -> commit-tree -> tag; never merged/pushed). Precedents: `safety/pre-megacore-fix-2026-08-03`, `split-safety-snapshot`.

## Intended outcome

Cartographer ends as a standalone project and becomes: `packages/cartographer-core` (analysis/store/emit/contracts + working standalone CLI and stdio MCP bins) and `apps/atlas` (the atlas SPA), absorbed into the server runtime (P1), a standing per-project Architecture surface (P2), on-demand git-diff architecture analysis (P3), hardened proposal/orchestrate linkage (P4), and native agent tools + auto-compute (P5). Mobile deferred.

## Implemented lifecycle contract (reconciled 2026-08-08)

The phase sections below preserve the approved design and execution provenance. Where their
forward-looking or phase-local wording conflicts with the final implementation, this reconciliation
is authoritative.

| Target | Implemented ownership and lifecycle |
|---|---|
| Current thread worktree | One exact on-demand capture owned by a thread; it shares the thread Atlas slot with proposal previews, expires after 8 idle hours, and is recaptured once after a typed missing-context response. It is not a filesystem watcher. |
| Proposal generation | One active generation per thread and one immutable retained revision target; a newer request supersedes the prior request. Startup abandons in-flight rows and removes partial roots. After a 24-hour grace, retention keeps the newest ready and newest restart-abandoned row per revision and prunes other old generation rows/roots. A ready target rebinds its sealed artifacts after reconnect instead of recomputing. |
| Standing project | One last-good publication and one standing Atlas slot per project. A status subscriber retains the context; otherwise the handle expires after 24 idle hours while verified publication metadata remains reusable. Rebuilds are single-flight and atomically published with startup repair; failure preserves the prior good atlas. Root changes invalidate and project deletion removes the binding through the durable reactor. |
| Diff analysis | One exact Git tree-pair row plus a separate Atlas slot per thread/project owner. Terminal failures remain observable for five minutes. Ready rows use 512 MiB per environment/repository and 2 GiB global LRU caps; monotonic touches, open leases, and conditional state/timestamp deletion prevent racing eviction. A retained row rebinds after reconnect; a pruned row requires Re-analyze. |

Additional implemented boundaries:

- Losing the active workspace drops Architecture together with Files, individual file, and Explorer
  surfaces. A surviving non-workspace panel becomes active; restoring the workspace does not
  resurrect Architecture, and reopening it performs a fresh project ensure.
- `architecture_blast_radius` and `architecture_graph_diff` query already-analyzed targets;
  `architecture_propose_patch` performs a bounded, ephemeral structural evaluation during an active
  turn. None of the tools triggers analysis or gains worktree-edit authority.
- Architecture analysis defaults to **On demand**. **Automatic** requests only the newest ready
  checkpoint pair and does not backfill; **Off** and **On demand** both leave manual Diff analysis
  available.
- Context and diff orphan reconciliation is age-gated to 24 hours and bounded to 256 directories or
  250 ms per pass. The context scan atomically persists its versioned, validated cursor in
  `stateDir/cartographer/orphan-sweep-cursor.json`, advances it even for protected/young/unreadable
  or removal-failed candidates, and resumes across server restarts. Missing, corrupt, or unreadable
  cursor state safely falls back to the beginning while live/age protection remains authoritative.
- The published `456code` archive physically bundles the private Cartographer core and its pinned
  production closure. The release gate installs that exact archive alone in clean npm and pnpm
  consumers, exercises its server/CLI/MCP/Atlas/worker surfaces, starts the installed server, and
  sends the same archive to `npm publish` only after validation.
- Web Atlas uses the authenticated server origin. Packaged desktop injects bearer auth only for
  exact-primary-origin `/atlas/ctx/*` `GET`/`HEAD` requests. Interceptor-refresh failure no longer
  blocks a ready main window and is retried on a later backend-ready cycle. A WSL-only primary is
  covered; secondary remote and secondary WSL backends, plus DPoP saved-environment iframe
  navigation, remain deferred.

## Historical execution invariants

These constraints governed the isolated absorption worktree. They are retained to explain the
commit provenance and must not be read as a claim that the implementation is still uncommitted.

1. No behavior changes in P0; each phase gates green before the next.
2. The 15 protected dirty paths are never staged, reverted, or reformatted. No `git add -A/.`, `commit -a`, `reset`, `checkout --`, `restore`, `stash`, or `clean` against the live index; explicit pathspecs only; status+digest assertions between steps.
3. The cartographer source repo is never modified.
4. No push/publish/release during any phase; public push is the only irreversible boundary.
5. Existing external-sidecar flow (`T3CODE_CARTOGRAPHER_CLI/NODE`) keeps working until P1 replaces it (verified: no path/env collision with the new workspaces).

## Dependency graph

P0 import -> P1 runtime absorption -> P2 standing Architecture surface -> P3 diff analysis -> P4 hardening/orchestrate linkage -> P5 agent tools/auto-compute. P2 and P3 depend on P1's main-origin serving + in-runtime analysis; P4 is mostly independent of P2/P3 (can interleave after P1); P5 depends on P1 (tools call core directly) and P3 (auto-compute).

---

## Phase 0 — squash import & workspace conformance (VERIFIED PLAN)

Lead-fixed contract: single package `@t3tools/cartographer-core` at `packages/cartographer-core` + private app `@t3tools/atlas` at `apps/atlas`. Squash import (no private history; public repo accepted). CLI + stdio MCP remain working standalone surfaces.

### Package surface (verifier-corrected)

- Exports: `.` -> `./src/index.ts` (node facade: contracts + analyze + store + emit barrels), `./contracts` -> `./src/contracts/index.ts` (regrouped `src/contracts/{types,atlasContract,atlasIndexCodec}.ts`), `./browser` -> `./src/browser.ts` (exact analyzeBridge set: roles `computeRoles`/`HUB_MIN_FAN_IN`/`FileRole`; aggregate `graphGroups`; glob `matchesRule`; diff `summarizeApiChanges`/`GraphDiff`; edgeIdentity `edgeIdentityKey`/`formatEdgeEndpoints`/`EdgeEndpoints`; moves types `MovedNode`/`MoveFlow`; patch types `GraphPatchMeta`/`GraphPatchOp`/`PatchIssue`/`PatchValidation`; systemHierarchy `selectSystemHierarchy`/`SelectedSystemHierarchy`/`SystemHierarchyCandidate` — verified zero `node:` imports in closure), all `{types, import}` -> src. **`./server` -> BUILT dist (`./dist/server.js` + `./dist/server.d.ts`)** — required because `patchPreviewRunner` spawns a sibling `patchPreviewWorker.js` (breaks from TS source outside vitest) and Vite's config loader externalizes bare imports (no transpilation; Node type-stripping not guaranteed). `src/server.ts` facade re-exports `serveAtlasHttp`+DTO types (store/atlasHttp), `createAtlasServer`/`AtlasServerOptions` (cli/commands/serve — verified side-effect-free on import), `injectRuntimeConfig`/`serveStaticFile`/`EmbeddedRuntimeConfig` (cli/lib/staticServer).
- Bins: `cartographer` -> `./dist/cli/index.js`, `cartographer-mcp` ->
  `./dist/mcp/bin.js` (package-manager-safe shim; `dist/mcp/server.js` remains side-effect-free and
  importable). The standalone stdio server exposes 8 tools: graph_repo, graph_diff, list_snapshots,
  blast_radius, annotate_files, propose_patch, get_patch, and list_patches. Release smoke invokes the
  installed declared package-manager shim through `initialize` and `tools/list`.
- Build: `tsconfig.build.json` (extends package tsconfig; noEmit false, rootDir src, outDir dist, declarations+maps, allowImportingTsExtensions false), run via package-local `typescript-7` alias (`node node_modules/typescript-7/bin/tsc -p tsconfig.build.json`); repo-standard `tsc --noEmit` (TS6 catalog) for typecheck; runtime dep `typescript: catalog:` (compiler API in analyze/symbols.ts). Deps: copy cartographer ranges byte-for-byte (@dagrejs/dagre, @modelcontextprotocol/sdk, dependency-cruiser, zod); `@types/node`/`vite-plus` catalog.
- **Engines: `>=24.10` in P0** (true today; the `^22.16||^23.11` floor-drop is P1 work WITH compat changes+tests). Root engines untouched.
- Atlas: mirrors apps/web anatomy (module Preserve, moduleResolution Bundler, composite, react-jsx, `~/*` paths + explicit `/^~\//` vite alias + tsconfigPaths, dedupe react/react-dom; plugins react() + @rolldown/plugin-babel w/ reactCompilerPreset + tailwindcss() — all already live in apps/web). **Atlas vite build outputs to `../../packages/cartographer-core/dist/web`** (standalone artifact contract: `resolveWebDir` is module-file-relative from dist/cli/lib -> dist/web; standaloneAcceptance requires dist/web/index.html). Declare `run.tasks.build.dependsOn: ['@t3tools/cartographer-core#build']` (precedent: apps/server dependsOn @t3tools/web#build). Ordering invariant: root `clean` wipes packages/*/dist -> always core build then atlas build.
- Atlas imports only `@t3tools/cartographer-core/contracts` + `/browser` (vite.config may use `/server`). Lint enforcement: root `vite.config.ts` `lint` block has NO overrides mechanism (verified) — P0 adds only global `no-restricted-imports` patterns that don't collide with P1 (restrict deep `packages/cartographer-core/**` relative escapes + non-{contracts,browser,server} subpaths); atlas-scoped root-import restriction requires verifying vp lint overrides support in an installed checkout, else the generated-oxlint-config pattern from `scripts/check-js-comments.ts`.

### Relocation table (essentials; full table in drafter record)

src/analyze|store|emit|cli|mcp -> packages/cartographer-core/src/* unchanged internally; types/atlasContract/atlasIndexCodec -> src/contracts/ (33 files/43 statements rewrite in core, verified counts); src/web/** -> apps/atlas/src/** (`~/` alias retargeted; 147 files/850 statements keep spelling); analyzeBridge.ts deleted -> 12 files/13 statements rewrite to `/browser`; 6 files/11 statements web-relative contract imports -> `/contracts`. scripts/{three acceptance}.mjs -> packages/cartographer-core/scripts/ (KEEP .mjs; `../dist` imports resolve; `repoRoot = new URL('..', import.meta.url)`; LICENSE must land at package root; symlink audit becomes package-subtree-scoped via cwd — acceptable, note it). gen-material-icons.mjs -> apps/atlas/scripts/ (update outFile + generated header template + regen command). dev.mjs DROP (only referenced by old dev script). templates/architecture-check.yml -> packages/cartographer-core/templates/ (adapt acquisition later). standalone-distribution.yml -> adapted bounded CI job (below). tooling/*, package-lock.json, packages/mdx-forge, .agents symlink, ignored dirs: DROP. `.claude-plugin/` and root `.cartographer.json`: CREATE at 456code (do not "merge" — they don't exist); root `.mcp.json` exists (xcodebuildmcp only) — add cartographer entry pointing at `packages/cartographer-core/dist/mcp/bin.js`.

### Headers & self-atlas (verifier-critical)

`headerPathStale` uses EXACT equality of canonical header path vs node id relative to the analyzed root (`describe.ts`). Therefore: every moved file's line-1 header is rewritten to its monorepo-root-relative destination (456code two-line rule: path + lowercase purpose, no terminal period, shebang above); the self-atlas convention becomes root = monorepo root with a NEW root `.cartographer.json` whose systems/rules/runtimes/journeys/groups patterns are rewritten from `src/**` to `packages/cartographer-core/**` + `apps/atlas/**`. Acceptance smoke uses temp fixtures (unaffected). Post-move check: build self-atlas at repo root, assert zero `headerPathStale` under the two new trees.

### Tests (verifier-corrected split)

21 of 24 test files + `tests/helpers/customLayoutHarness.ts` import `../src/web` -> they are ATLAS tests: relocate to `tests/apps/atlas/**` w/ imports rewritten to `../../../apps/atlas/src/...`; remaining core tests -> `tests/packages/cartographer-core/**` w/ `../../../packages/cartographer-core/src/....ts` (direct-relative-source per repo precedent: tests/packages/shared/git.test.ts). Runner imports rewrite `vitest` -> `vite-plus/test` (verified low-risk: only canvasNudgeStore.test.ts uses vi.* APIs — stubGlobal/spyOn; NO vi.mock anywhere). tests/package.json: add only actually-imported bare deps after inventory (react/react-dom 19.2.6 already declared). Package wiring per shared/web patterns: core vite.config `mergeConfig(base, {test:{dir:'../../tests/packages/cartographer-core'}})`; atlas simple test block (deviation from web's named-'unit'-project shape is intentional); tsconfig includes of the mirrored trees. Environment: Node only (no jsdom); port DOM-needing tests via manual global stubs / react-dom/server per existing web-test precedent.

### CI

New bounded `cartographer` job in ci.yml (ubuntu-24.04, 20m, setup-vp): core build -> atlas build -> package-local `vp test run` x2 -> three acceptance scripts (package cwd). Main 25-min Test job switches from `vp run test` to the verified positive filter list (13 packages, enumerated by verifier — exact 1:1) so the new suites run only in the bounded job; root recursive `test` script unchanged for local use; add a drift-warning comment in the workflow (new packages must be added explicitly). Conformance: prettier reformat (80->100 col) + header/comment pass BEFORE the check job runs them; directive checker only inspects modified files (new files uncovered — review directives at import). Release-workflow enrollment was deferred in P0 and completed by the 2026-08-08 release-boundary remediation described above.

### Execution: 6 commits, gated

1. `docs(plans): define cartographer monorepo absorption` — this file + `.plans/README.md` row. BLOCKER: `.plans/README.md` is user-dirty; owner must commit/hand off first. Gate: header/format checks on the doc.
2. `feat(cartographer): import core and atlas snapshot` — rsync from frozen temp snapshot honoring drop ledger into the two roots; raw bytes, no wiring. Gate: staged paths = the two roots only; manifest/digest parity; no .git/secrets/generated state; protected paths untouched.
3. `refactor(cartographer): conform boundaries, exports, and style` — contracts regroup, browser/server facades, import rewrites, header rewrites, prettier reformat. Gate: `pnpm run comments:check -- packages/cartographer-core apps/atlas`; `pnpm run fmt:check`; `vp lint <new paths>`.
4. `build(cartographer): wire workspace packages` — manifests, tsconfigs, vite configs, root .mcp.json entry, root .cartographer.json, lockfile (`pnpm install` then `--frozen-lockfile` re-run; no pnpm-workspace.yaml edit needed — globs cover; allowBuilds already permits esbuild; treat any blocked-build warning as a stop). Gate: `vp run --filter @t3tools/cartographer-core --filter @t3tools/atlas typecheck` + `build`.
5. `test(cartographer): relocate imported suites` — moves, rewrites, tests/package.json, wiring. Gate: both focused suites green; typecheck green; no test files left under the two source roots.
6. `ci(cartographer): add bounded gates` — ci.yml job + Test-job filter change + `scripts/smoke-cartographer-mcp.ts` (direct-node launch; initialize -> tools/list -> assert 8 tools -> clean shutdown). Gate: full P0 acceptance below.

Rollback: reverse-order `git revert` per commit; no local point of no return (lockfile reproducible); stop conditions: source manifest mismatch, protected-path change, any gate needing a behavior change, secret/generated artifact discovered.

### P0 acceptance (final)

```sh
pnpm install --frozen-lockfile
pnpm run fmt:check && pnpm run comments:all:check
vp check && vp run -r --concurrency-limit 2 typecheck
vp run --filter @t3tools/cartographer-core build && vp run --filter @t3tools/atlas build
(cd packages/cartographer-core && vp test run) && (cd apps/atlas && vp test run)
(cd packages/cartographer-core && node scripts/standaloneAcceptance.mjs && node scripts/proposalConcurrencyAcceptance.mjs && node scripts/patchPerformanceAcceptance.mjs)
node packages/cartographer-core/dist/cli/index.js --help
node scripts/smoke-cartographer-mcp.ts
node packages/cartographer-core/dist/cli/index.js build . --out .cartographer-phase0  # then assert zero headerPathStale under the two new trees
git status --short  # only the 15 protected paths
```

### P0 open items (execution-time)

- `.plans/README.md` dirty-file ownership handoff before commit 1.
- Verify vp lint path-scoped overrides in an installed checkout (atlas boundary rule mechanism).
- Record exact cartographer 40-char SHA + 58-path dirty manifest + full drop ledger in this doc at execution start.

---

## Phase 1 — runtime absorption (VERIFIED PLAN)

Goal: cartographer analysis + atlas serving become native server capabilities; sidecar/ticket/proxy and `T3CODE_CARTOGRAPHER_*` retire. Five gated commits.

### Architecture (lead-fixed, verifier-corrected)

- **Analysis**: stays a child process of the server's own runtime. New `apps/server/src/cartographer/CartographerAnalyzer.ts` Effect service resolves `@t3tools/cartographer-core/package.json` via createRequire (export `./package.json` from core), validates `bin.cartographer -> dist/cli/index.js`, spawns `process.execPath <cli> analyze-trees ...` with today's exact args/manifest contract, NO env override (ProcessRunner omitting env inherits server env incl. `ELECTRON_RUN_AS_NODE=1` — verified: only terminal PTY paths scrub env; never use bare `node`). Fingerprint = `@t3tools/cartographer-core@<version>:dist-sha256:<hex>` over sorted dist files. The built core `./server` facade is a startup prerequisite; a missing analyzer CLI or Atlas web asset instead degrades the affected Architecture surface to `unsupported`/unavailable while the server continues to boot. Deletes ProposalGenerationService env-config (~654-729), keeps materialization/sealing/semaphore-2/supersession/freshness/abandonment verbatim (anchors verified: resolver sites 894/965/1091; spawn 966-986; manifest 994-1007; abandonment 636-652; containment 518-527). Clean cut, no env fallback.
- **Server bundling/packaging**: exact-match exclusion for `@t3tools/cartographer-core` in `apps/server/vite.config.ts` `shouldBundleCliDependency` (:10-20; @t3tools/* currently always bundled) so the worker sibling `dist/store/atlasHttp/patchPreviewWorker.js` stays a real file; core added as the FIRST workspace package in server production deps. Desktop staging: NEW code in `scripts/build-desktop-artifact.ts` — pack core to .tgz, copy into stage, rewrite the staged dependency entry (insertion point: stageDependencies literal ~1370-1389; `workspace:*` passes through resolveCatalogDependencies untouched and would break `vp install --prod`). asarUnpack already covers `**/node_modules/**`. Packaged smoke `scripts/smoke-packaged-cartographer-analysis.mjs` runs analyze-trees under packaged Electron (`ELECTRON_RUN_AS_NODE=1`) as a build gate.
- **Atlas serving**: main-origin per-context routes mounted BEFORE the static catch-all in `makeRoutesLayer`: `GET /atlas/ctx/:id` -> 308 to trailing slash; `GET|HEAD /atlas/ctx/:id/` -> atlas index.html with cartographer's exact runtime-config injection ({version:1, apiBase:'./', embedded:true, readOnly:true, storageNamespace:'456code.<ctx>', theme, initialTaskLens:'changes' when comparison-bound, parentOrigin=<main origin>}); `/atlas/ctx/:id/api/*` + `/graph.json` -> env-authenticated (read scope) -> URL-rewrite -> `serveAtlasHttp(req,res,{root,outDir,fixedRoot:true,readOnly:true,trustedHost:true})` via `NodeHttpServerRequest.toIncomingMessage/toServerResponse` (verified present in @effect/platform-node 4.0.0-beta.78); other paths -> public static from `<staticDir>/atlas` w/ traversal checks, index no-store, hashed assets immutable. **Node-only**: the raw accessors are unguarded casts and the server selects Bun when `typeof Bun !== 'undefined'` (server.ts:132-160) — atlas routes must gate on Node runtime (clear 501 under Bun). Hosted mode NEVER reuses `createAtlasServer` (its outer loopback guard at serve.ts:52 would 403 proxied hosts) — own-shell mounting only.
- **AtlasContextRegistry** (replaces broker sessions): in-memory; contexts at `<stateDir>/cartographer/contexts/<24-char-id>`; `createForThread({threadId, source: current-worktree|generation, theme})` -> {contextId, url}; per-thread replacement under semaphore; expose-after-prepare; 8h idle expiry w/ reaper; closeThread on deletion; startup and periodic sweep of orphaned context dirs (bounded 256/250ms, contexts dir only — never generations). Review remediation later made the sweep cursor restart-durable through an atomic sibling `orphan-sweep-cursor.json`; invalid cursor state falls back to the start without bypassing live/age protections. Binding: fresh per-context outDir; generation contexts verify via `resolveEmbedTarget` then core's new `bindComparisonArtifacts` (lifted from embedServer.ts prepareEmbeddedGraphPair 232-281 + loadPrebuiltGraph/Impact + assertExternalOutDir + isWithin helper; MUST retype off CliValues to explicit path params) = saveGraph(proposed) + recordSnapshot(base); current-worktree contexts capture via CurrentWorktreeSnapshot then build the graph by SPAWNING the workspace CLI (never in-process `buildGraph` — it mutates global cwd via graph.ts cwdLock). Pre-warm invariant: graph.json + atlas-index.json + graph.db all exist before publish (read-only GETs otherwise write on first hit — ensureAtlasIndex rebuild + openDb creating WAL).
- **cartographer-core hosted mode**: new `AtlasHttpOptions.trustedHost?: true` wraps exactly guardLoopbackRequest (router 72-77), guardSameOriginWriteRequest (83-90), hasCapability (91-100) — readOnly hiding (78-82) stays unconditional; vite dev middleware + standalone serve/embed-server keep all guards (no caller passes the flag). Land the missing foreign-origin-POST rejection test BEFORE this refactor. New exported eviction hooks in all four module-private caches (workingTree delete-by-root; atlasIndex by recomputed path key; patches prefix-scan by dir; preview QUEUED-task purge only — active-preview cancellation CUT from P1 as over-engineering since readOnly contexts 404 all patch routes incl. preview, pinned by embedServer.test 221-241). `disposeAtlasContext(root,outDir)` composes them. Engines -> `^22.16 || ^23.11 || >=24.10` + sqlite capability error in snapshots.ts openDb (structure verified 68-82); CI: 22.16 + 24.10 full lanes, 23.11 smoke gates advertising `^23.11` (dependency-cruiser engines exclude 23). SPA: ZERO changes needed for /atlas/ctx/<id>/ depth (verified: base './', atlasHttpUrl baseURI, pathname-preserving history, relative worker URL, no window.location.origin anywhere, auto-baseline picks the sole non-current snapshot — fresh outDir makes it unambiguous).
- **Contracts/clients**: add `AtlasContextId`, `CartographerOpenAtlasInput/Result {threadId, generationId?, theme} -> {contextId, url}`, `CartographerCloseAtlasInput {threadId, contextId}`, atlas-neutral `CartographerError` (failures: unsupported | workspace_context_not_found | generation_not_found | snapshot_failed | context_start_failed | context_not_found) — migrate CurrentWorktreeSnapshot + ProposalGenerationService off CartographerEmbedError BEFORE deleting it; capability `atlas: Schema.Boolean withDecodingDefault(false)` (pattern verified at environment.ts:44), always true; keep `cartographerEmbed: true` through commits 1-4. Full consumer checklist (verifier-completed): ConnectedExplorerPanel (drop releaseIssuedSession/EmbedRequestState/embedTargetKey; keep generation state machine + polling), ExplorerPanel (expectedOrigin = env HTTP origin; rejecting code456: schemes is SAFE — verified unreachable today since embed URLs are always http(s)), explorerIntegration (new /atlas/ctx validator, no ticket), explorerBridge unchanged, **ChatView.tsx:1316 + ProposedPlanCard.tsx:70 capability reads**, **client-runtime projectCommands.ts:177-190 commands** (new openAtlas latest-keyed / closeAtlas serial-keyed on proposalScheduler; deprecate old), **serverRuntimeStartup embed-reconciliation phase + its budget tests rewired**, **cli/config.ts:136-145 reconciliation env keys removed**, ThreadDeletionReactor dual effect-kind executor (`cartographer-embed.close` + `atlas-context.close` — durable replay verified version-filter-free; keep legacy case indefinitely), docs/integrations/cartographer.md rewrite + env-var upgrade note. Mobile verified clean (zero cartographer usage).
- **Desktop iframe auth**: scoped default-session `webRequest.onBeforeSendHeaders` (none exists today — new, narrow: backend origin + `/atlas/ctx/*` GET/HEAD only) injecting bearer from `DesktopLocalEnvironmentAuth.getBearerToken` (verified :47-53). Web uses ambient `t3_session` cookies. P1 limitation (documented): packaged-desktop Atlas supports the active primary backend, including a WSL-only primary; secondary remote and secondary WSL backends plus DPoP saved-environment iframe navigation are deferred.

### Commit sequence (each gated)

1. `feat(cartographer): add atlas context runtime surface` — contracts/RPCs/registry/routes/client commands added; everything old intact. Gate: new contract + registry + route-auth tests.
2. `refactor(cartographer): absorb analysis into the server runtime` — CartographerAnalyzer + service conversion + bundling/staging changes + retention sweep (newest-ready-per-revision retained; 24h grace; startup orphan sweep; rows deleted before dirs). Gate: generation suite + packaged smoke.
3. `refactor(web): migrate Explorer to atlas contexts` — web + client-runtime migration, capability reads. Gate: focused web tests + test-t3-app pass.
4. `refactor(cartographer): migrate durable thread cleanup` — registry into ThreadDeletionReactor, dual effect kinds. Gate: seeded legacy-row replay test.
5. `refactor(cartographer): retire embed sidecar` — delete broker/proxy/reconciliation/RPCs/schemas/commands/capability/env-vars; docs. Compatibility window ends. Gate: full P1 acceptance.

### P1 acceptance

Focused suites (AtlasContextRegistry, AtlasHttp, CartographerAnalyzer, ProposalGenerationService, ThreadDeletionReactor, ServerEnvironment, web explorer suite) green; `rg 'T3CODE_CARTOGRAPHER'` returns only historical plans; hosted smoke (current-worktree + generation contexts via browser); packaged-desktop analysis + iframe smokes; core standalone suites still green (guards unweakened); engines matrix green (23.11 lane decides `^23.11` advertising).

### P1 closeout and follow-ups

- Bun posture: 501-gate implemented; Node-only documented.
- Secondary remote and secondary WSL desktop Atlas navigation, plus DPoP saved-environment iframe
  navigation: deferred and documented.
- Resolved after P1: the released `456code` archive stages Cartographer core as a physical bundled
  dependency with a complete pinned production closure, then validates that exact archive in clean
  npm and pnpm consumers before dry-run publication.

### P1 execution record (2026-08-07, run t6p2)

Landed as 9 commits (8d3a03a59 surface, fcd690671 absorption, 25357ed74 web, 359dc7db9 desktop, 9afa15d75 reactor, 062f53e14 retirement, c27f7d0de ci lanes, 504281522 gate fixes + earlier docs commit). Gate verifier bd740c50 PASSed consumer coverage/no-createAtlasServer-reuse/replay/extraction-fidelity/semaphore/hygiene; four FAILs all remediated: hosted GETs made write-free via core `immutableArtifacts` mode (load-only index, read-only sqlite, typed 503) + `disposeAtlasArtifacts` cache eviction on close (worker 54cd34e9); engine-floor CI lanes 22.16/23.11/24 on the cartographer job; foreign-origin POST guard test + Node-only/Bun-501 docs note; staged-contract smoke script (esm facade probe, trimmed tgz, CLI spawn, worker sibling). Lead-found runtime bug during integration: eager `published ?` ternary in the registry ensuring-path deleted every published context dir (fixed w/ Effect.suspend + comment). Live boot smoke: absorbed server boots w/o T3CODE_CARTOGRAPHER_*, /atlas/ctx/* auth-gated 401 on root/deep/HEAD. Deviations recorded in commit bodies; CLI --help exit-1 is original upstream behavior. Deferred: integrated browser pass batched to the P2/P3 UI boundary; packaged-Electron manual pass.

## Phase 2 — standing Architecture surface (VERIFIED PLAN)

Goal: a first-class per-project Architecture panel (live atlas, rules/journeys/runtime lenses), host-driven navigation + deep-linking, and a real 456code dogfood config.

### Server: project contexts + rebuild service (verified design)

- AtlasContextRegistry gains PROJECT-scoped contexts keyed `(environmentId, projectId)` (never repositoryIdentity — remote-derived): root = project.workspaceRoot LIVE (no snapshot; /api/source staleness works), outDir = `<stateDir>/cartographer/projects/<projectId>`, 24h unleased TTL + ref-counted retention while a status subscriber is active (VcsStatusBroadcaster pattern), restart reuse when persisted graph/index + `.project-atlas.json` metadata validate (env/project/root/analyzer-fingerprint), lazy context-id recreation.
- AtlasRebuildService: per-project single-flight + 300ms debounce + dirty-rerun (watch.ts pattern), global build semaphore 1, spawns the workspace CLI `build . --out <staging>` via CartographerAnalyzer resolution (cwd=workspaceRoot, snapshot/register off), staging-dir publication: validate `atlas-index.sourceGeneratedAt === graph.generatedAt`, prewarm graph.db, atomically publish graph -> index -> metadata w/ `.publish.json` recovery marker + startup repair; failure keeps last generation + bounded `lastBuildError {code, message, occurredAt}`. `generation = sha256(graph bytes)`.
- AtlasRebuildSuggestionService: consumes the hot non-replayed `streamDomainEvents` (verified OrchestrationEngine.ts:49-52; dispatch projects before publish :263-317); suggests only while a subscriber retains the context; prefers `thread.turn-diff-completed` (status ready + files; payload verified) w/ IDEMPOTENT turnId dedup (placeholder 'missing' diff events fire mid-turn), fallback `thread.session-set` leaving 'running' (projector.ts:913-950 verified).
- Status broadcaster + 3 RPCs: `cartographer.openProjectAtlas {projectId, theme} -> {contextId, url}` (operate; pure idempotent ensure — schedules a build only when no reusable generation), `cartographer.rebuildProjectAtlas {projectId} -> {state: accepted|running}` (operate; the panel's Rebuild button), `cartographer.subscribeAtlasStatus {projectId}` stream (read). Status payload v1: `{state: idle|building, generation, generatedAt, freshness (server-computed — verifier fix; ProposalGenerationFreshness precedent), lastBuildError, contextId, url}`. Wiring mirrors vcsHandlers observeRpcStream + EnvironmentSubscriptionRpcTag (closed union — must be extended) + createEnvironmentRpcSubscriptionAtomFamily (all anchors verified).
- ProjectAtlasLifecycleReactor (durable; DurableReactorRunner verified event-type-agnostic — plans from project.* events; copy ThreadDeletionReactor's snapshot-sequence bootstrap to avoid full-history replay): `project.meta-updated` w/ root change -> rebind (binding-revision fencing; stale publishers discard staging), `project.deleted` -> close + containment-checked cleanup (retryable). Startup reconciliation via ProjectionProjectRepository.listAll (returns soft-deleted rows — filter). Decision: NO new sqlite table (registry ephemeral; projection owns identity; artifacts are derived cache).

### Web surface (verified design)

- rightPanelStore: append `'atlas'` kind + payload-free singleton `{id:'atlas', kind:'atlas'}`; version 8 -> 9 w/ explicit atlas migration validation (strip extras, reject spoofed ids); generic open/toggle fallthrough; add atlas to the reconcile-drop predicate; two-step rollback note (v8 catch-all would pass atlas through). All line anchors verified.
- AtlasPanel (sibling of ConnectedExplorerPanel minus all proposal machinery): openProjectAtlas on mount/[env,project] change (idempotent ensure; NEVER closeAtlas on unmount — standing context is server-owned); Rebuild -> rebuildProjectAtlas; iframe origin-checked/sandboxed, kept mounted, remount key = `${url}:${generation}` (verifier fix — url can change on rebind); theme via resolvedTheme (ocean->dark) on load + change; banner precedence: fatal > error > stale(freshness) > building > local mayHaveChanged; hint tracker is ChatView-owned + project-keyed (session leaving 'running'), cleared on newer ready generation.
- Gating: `capabilities.atlas === true && activeProject !== null` (draft threads OK — verified they carry scoped refs and open panels today; deliberate divergence from explorer's isServerThread gate). Entry points: plus-menu/empty-state card, SidebarV2 per-member Architecture button (exact-project match; disabled copy per cause), command palette root action `action:architecture` (disabled without thread/project/capability; never falls back to recent threads).
- client-runtime: openProjectAtlas command (latest, key [environmentId, projectId]), rebuild command, subscribeAtlasStatus atom family; conventions verified against projectCommands + preview subscription precedents.

### SPA deep-linking + bridge navigation (verified design; all dispatch targets confirmed)

- `df` URL param: `s:<positive-int>` | `p:<encoded-patch-id>`; typed diffFocus in ParsedLocation/UrlNavigationRestore w/ malformed-vs-absent distinction; restoreUrlState keeps VALIDATED focus (currently unconditionally nulls — verified quote); pending-focus lives in new `useSpaNavigation` coordinator (sequence-stamped, NOT in zustand); AtlasApp enables useChangesData/useProposalsData on pending focus (fixes the verified hook-enablement deadlock); snapshot catalog gains a pending-seek (mirror useProposalsData's pendingSeekRef — verified present there, absent in changes); final gates = catalog membership + validateDiffIdentity (verified checks); read-only mode rejects patch focus; deterministic failure semantics (absent clears; malformed preserves prior; rejected clears + canonicalizes).
- Bridge `navigate` command, ADDITIVE in v1 (parseHostMessage returns null on unknowns — old atlas ignores new hosts safely): payload union select-file | open-snapshot-diff | open-patch | set-lens | focus-layer | focus-block; parser does envelope+bounds only (keys<=512 chars, patch ids safe-64, baselines positive safe ints, lens in TASK_LENSES); SPA handler validates against model/catalogs and dispatches via verified actions (gotoFile, selectBaseline+onShowOnCanvas, selectPatch+onOpenProposal, setTaskLens, openLayer, openBlockDirs/openBlock); one-entry sequence-stamped inbox for pre-ready commands; fire-and-forget v1 (no ack — success observable via navigation-changed).
- Outbound additive events: `navigation-changed {canonicalUrl}` (relative only, deduped, coalesced via the existing microtask encoder) and `graph-status {phase, generatedAt, root, fileCount, refreshing, staleReason?}` (pure resolver over verified lifecycle emission points; refreshing = replacement-model work only). Host stores canonicalUrl for future launches (no echo loop — not an inbound type). Sizing: ~15-18 files, ~780-1080 LOC incl. tests.

### Dogfood config + authoring loop (verifier-corrected)

- **BLOCKING FIX APPLIED**: cartographer globs have NO brace support (verified: matchesRule treats `{},` as literals; silently matches nothing). Config rewritten brace-free: one entry per alternative for groups/systems (duplicate names collapse — live dogfood precedent), rules split into cross-products w/ distinct ids. NEW core work item: `allowVia` accepts string OR array (semantically required — allow-only rules cannot be split; matchesAllowVia = some()) + zero-match staleness warnings for groups/systems/rules patterns (journeys/runtimes already have staleness).
- Config content (validated against schema caps; rank ties verified safe — equal ranks generate no pairwise rules): 13 groups (one per workspace incl. mirrored tests), 9 systems (rank 0: Client Surfaces + Test Suites + Repository Tooling; 1: Server Runtime + Client Runtime; 2: Platform Adapters + Cartographer Core; 3: Shared Runtime; 4: Contracts — matches verified real import direction), 7 curated rules (packages-never-import-apps, clients-never-import-server-source, contracts-stay-schema-only, client-runtime subpath allow-only [needs allowVia array], contracts entrypoints allow-only, atlas-core-public-surface, cartographer-core-stays-standalone), 1 'agent-turn' journey (10 stops w/ timings; stops are pattern-multi-match, zero-match -> stale not error — verified), 6 runtimes (cap is inclusive — verified). Scope '.', groupDepth 2 (authored groups override heuristic — verified first-match precedence). Smoke script asserts: named systems, zero headerPathStale, rules ledger populated, journeys resolve, runtime lenses non-trivial, no vendor/output nodes.
- Authoring loop: second NON-recursive root-dir watcher for `.cartographer.json` + `.cartographer.annotations.json` (extension filter excludes .json — verified; non-recursive avoids node_modules; dir-watch survives atomic rename); lastBuildError through the status broadcaster (invalid config -> panel error banner, last good atlas stays usable); seed-rules one-time reviewed pass (repo's only no-restricted-imports quoted; ESLint available only for the seed run); sparse annotation campaign (~20 files max; two-line headers already feed descriptions); AGENTS.md maintenance convention. Three independent commits: core watch inputs -> status/error -> config/docs/smoke.

### P2 commit sequence

1. core: allowVia array + zero-match staleness + watch inputs + df/navigate/bridge events (cartographer-core + apps/atlas).
2. server: registry extension + rebuild service + broadcaster + RPCs + lifecycle reactor.
3. web: store/panel/controller/entry points + client-runtime.
4. dogfood: root .cartographer.json + smoke + docs.
Each gated on its focused suites; final gate = test-t3-app pass (open Architecture from all three entry points, rebuild, staleness banner, failed-rebuild survival) + dogfood smoke green.

### P2 execution record (2026-08-07, run t6p2)

Landed as 5 commits (12f09875d core/SPA bridge, ea92fc7bf server contexts+rebuild, c2fe5db1b web surface, 6d7f1d3fe dogfood config+smoke, 5dbdb7027 gate fixes). Gate verifier PASSed allowVia array normalization end-to-end; ten FAIL/CONCERN items closed by remediation worker 8fce583f + lead repairs (commit 5dbdb7027): atomic publication via staging mutex + staged metadata w/ interrupted-publication discard; startup orphan reconciliation in the lifecycle reactor; 64-turn LRU turnId dedup; `cartographer.rebuildProjectAtlas` RPC end-to-end (contracts -> authorization -> ws -> client-runtime -> panel Rebuild); send-side navigate validation in explorerBridge; lifecycle-bound non-recursive authoring watchers (`.cartographer.json` edits rebuild while a context is retained); dead-API cleanup (isBuilding, closeProject); exclude tests + docs. Lead repairs over the worker patch: consume/consumeRetention are Effects not Streams (Stream.merge was a category error — fork each), tagged errors for watcher-start/orphan-scan catches, NodeServices layer ordering in the reactor test, await-in-generator via Effect.promise. Dogfood deviations (recorded in commit bodies): 17->11 first-match systems collapse under the 16-entry cap; NEW core config `exclude` segment feature (.repos vendor containment); authored-subset smoke assertions. Census baselines held: apps/server tsc 124 pre-existing (+1 explained: the new rebuild-RPC test inherits server.test.ts's file-wide requirements-channel diagnostic), vp check 8 pre-existing. DEFERRED (binding follow-ups, not silently dropped): `graph-status` outbound bridge event; project-keyed canonicalUrl future-launch store; status-schema enrichment (generatedAt, flattened contextId/url, structured lastBuildError); ChatView-owned project mayHaveChanged hint; `thread.session-set` fallback trigger (intentionally excluded in v1 — ready turn diffs are the sole trigger, pinned by comment+test); durable 2,899-file census baseline. Integrated browser click-through remains batched to the P3 UI boundary (preview broker unavailable this session; compensated w/ protocol-level verification: authenticated typed-404 matrix + live RPC exercise against the dev stack).

## Phase 3 — on-demand git-diff analysis (VERIFIED PLAN)

Goal: any git diff 456code shows (turn checkpoints, working tree, branch range) gets an on-demand architecture-impact view, cached by tree-OID pair.

### Contracts + persistence (verified; corrections applied)

- `packages/contracts/src/cartographer.ts`: `DiffAnalysisId`, `DiffAnalysisSource` union ({checkpoint: threadId+fromTurnCount+toTurnCount} | {review: cwd+kind+baseRef?} | {treePair: cwd+baseTreeOid+headTreeOid}), `DiffAnalysisState` (038 lifecycle), 21-code error enum, `DiffAnalysisGeneration` result (opaque artifact refs, `sourceCurrent` boolean, byte length). RPCs `cartographer.requestDiffAnalysis` (operate) + `cartographer.getDiffAnalysis` (read) + `cartographer.openAtlasForDiff {owner: {threadId}|{projectId}, diffAnalysisId, theme, labels?} -> {contextId, url}` (operate).
- Migration 059 (integration reconciliation) `diff_analysis_generations`: 038-style columns + UNIQUE on the full effective cache key (environment_id, repository_key, base_tree_oid, head_tree_oid, analyzer_version, analysis_policy_version, config_digest, scope_digest, tsconfig_digest) + two LRU indexes. The Cartographer worktree originally used branch-local 052, which collided with the session-postmortem branch's `ProjectionThreadsInteractionOrchestrate`. Migration 059 idempotently ensures both the diff-analysis schema and the interaction-orchestrate column so either historical branch-local 052 meaning converges safely; 056/057/058 remain reserved. repository_key per ProposalGitEngine precedent (normalized remote URL | `local-git:sha256(gitCommonDir)`). `source_descriptor_json` = first-writer provenance, never identity. SQL idiom (verifier-corrected): `INSERT ... ON CONFLICT DO NOTHING RETURNING` + transactional refetch — live precedent CheckpointRevertOperations.ts:145.
- Digests (verifier-corrected): declared-candidate-set from git objects — `ls-tree <treeOid> -- .cartographer.json .cartographer.annotations.json tsconfig*.json` blob OIDs hashed as (path -> blobOID) tuples (blob OIDs ARE content digests; no cat-file/materialization; GIT_LITERAL_PATHSPECS precedent at ProposalGitEngine.readTreeEntry). No core resolver export; accepts benign over-invalidation. `DIFF_ANALYSIS_POLICY_VERSION = 'diff-analysis-v1'` owns resolution/digest/sealing rules.

### DiffAnalysisService (verified design)

- Request flow: validate + resolve BEFORE row creation (review/tree-pair cwd through assertWorkspaceBoundCwd-style containment); per-kind resolution: checkpoint via ProjectionSnapshotQuery.getThreadCheckpointContext (verified :2159-2203; arbitrary turn pairs; refs deleted on revert cleanup — CheckpointReactor.ts:1399 — missing ref = deterministic `checkpoint-ref-missing`); working-tree = HEAD^{tree} base (matches `git diff HEAD` text-diff baseline; unborn HEAD -> empty tree — verifier fix) vs captureExactGitSnapshot head; branch-range = NEW `git merge-base` helper in GitVcsDriverCore (verified: none exists) w/ default-base selection reuse; tree-pair = cat-file -t verified tree OIDs.
- Analyzer refs = full commit SHAs; tree-only sources get DETERMINISTIC synthetic commits: `git commit-tree` w/ the checkpoint identity env (GitVcsDriver :867-874) PLUS fixed `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` (epoch +0000) + fixed message (verifier fix — without fixed dates OIDs churn); unreferenced label commits may be GC'd (acceptable — recreatable identically).
- Generation: materialize both verified OIDs (ProposalGenerationService.materializeTree precedent + 25k/256MiB limits), spawn analyze-trees via CartographerAnalyzer (120s/1MiB), validate manifest + `repoRoot:'.'` + labels, seal 038-style w/ head-root digest in the sealed name, DELETE base materialization, RETAIN head materialization + trio. Failure taxonomy per the 21 codes; startup abandonment; terminal rows keep a 5-min observation window then purge.
- **One shared cartographer build semaphore** (P1/P2 amendment applied): owned at the CartographerAnalyzer boundary, capacity 1 initially; proposal analyze-trees + project builds + diff analyses all acquire it for the child-process lifetime; materialization/sealing outside the permit.
- Retention: ready-only LRU by last_accessed_at, per-repo 512MiB then global 2GiB caps (v1 constants), rows deleted before roots, leased rows excluded; `retainReadyTarget` scoped lease held for context lifetime (acquire under the row lock eviction shares).
- `sourceCurrent`: call-time re-resolution of the persisted descriptor per kind (never stored; immutable pairs never stale); failures return sourceCurrent:false, not RPC errors.

### Serving + contexts (verified design; slot fix applied)

- AtlasContextSource += `{kind:'diff-analysis', diffAnalysisId}`. **Two ephemeral slots per owner** (verifier-adjudicated necessary+sufficient): proposal/current-worktree slot + diff-analysis slot, keyed (owner, kind) in the registry AND in client command keys — prevents Explorer<->Architecture teardown churn + cross-kind open/close races (web renders only the ACTIVE right-panel surface; ConnectedExplorerPanel releases on unmount — verified).
- Owner validation: thread via getThreadShellById->project; project via getProjectShellById; effective cwd repository_key must equal the row's key (worktrees sharing a repo reuse cache). `diff_analysis_not_found` masks wrong-owner probes.
- Binding: row lock -> refcount lease -> per-artifact sealed-hash verification + head-root digest -> fresh context outDir -> P1 binding helper (prepareEmbeddedGraphPair-derived export; P1 dependency — artifacts bound UNMODIFIED so the impact deep-equal passes; epoch-everything verified to pass ALL FOUR validateDiffIdentity checks + defaultBaseline fallback) -> prewarm -> publish -> swap slot. Close/expiry/thread-delete/project-delete release leases but never delete cache artifacts; retention is the only artifact deleter.
- Context roots (three cases, decided): historical pairs -> retained head root (mtimes are materialization-time — never feed modifiedSinceAnalysis to freshness UI); working-tree pairs -> recorded live cwd (real drift visibility; containment + repo-key revalidated at open); branch-range -> retained head-commit root.
- stateDir layout: `contexts/` (registry-owned) | `diff-analyses/` (cache-owned) | `generations/` (proposals) | `projects/` (P2) — reconciliations never cross-traverse.

### Web UI (verified design)

- Architecture tab INSIDE DiffPanel: rename headerRow->changesToolbar; accessible tablist below the shell header; both panels stay mounted (hidden toggling); activeView transient. Request construction per source: turn = threadId + selectedCheckpointRange counts (verified :189-198); review = `branchDiffPreview.data.cwd` (the RESOLVED result cwd incl. env-cwd retry — verified :249-270) + kind + resolved baseRef; identity NEVER uses source.id/patch/truncation/whitespace. Truncated-preview disclosure: analysis uses complete exact trees.
- diffPanelStore: one-shot `requestedViewByThreadKey` intent w/ requestId consumption (quoted shape verified); NOT persisted; removeThread cleans it.
- ChangedFilesCard: secondary ghost `Architecture impact` action (lucide `Network` — live precedent ExplorerPanel.tsx:100) -> selectTurn + open diff singleton + requestView('architecture'). Capability-gated.
- client-runtime `state/workspace/diffAnalysis.ts`: normalization + keys shared w/ future mobile (fixes the verified web/mobile target-construction duplication); requestDiffAnalysis command singleFlight-keyed by target; getDiffAnalysis polling via the STATE-GATED component setInterval precedent (ProposedPlanCard :180-193 — verifier-corrected; refreshIntervalMs cannot stop on terminal states); openAtlasForDiff latest-keyed per generation.
- States: idle CTA w/ cost copy -> queued/preparing/analyzing progress (Changes tab usable) -> ready (P2 AtlasPanel iframe machinery, key `${url}:${generationId}`; cached pairs open instantly) -> failed (retry; keep last-good) -> sourceCurrent=false (re-analyze affordance). Mobile UI deferred; GitOverviewSheet noted as a future mobile entry point.

### cartographer-core/SPA follow-ups (verified; epoch fixes added)

- ChangesView violation-delta sections: `New violations`/`Resolved violations` EvidenceSections + `Rule violations` AnalysisStats item (parsers/invariants already exist — verified diffPayloadParsers 116-385; CHANGE_VIOLATION_CAP=28 in thresholds + data.ts re-export; chip tones flag/hyg/neutral verified in Chip.tsx); rule-id action -> setTaskLens('rules') (direct-subscription precedent).
- Comparison display labels via runtime config `comparisonLabels {base, head}` (per-field defensive parse verified; host injects; standalone gets --base-label/--head-label embed-server flags): consumed at AnalysisWorkspace workspaceContext, ChangesView SnapshotRail + Baseline AnalysisStats (SUPPRESS the year-less epoch formatDate in chips/select/stat detail when labeled — verifier catch: 'Dec 31' TZ bug), AtlasApp snapshot diffOverlay baseLabel producer at :236 ONLY (:262 is the proposal producer — don't clobber), BlocksOverlays pill (existing prop chain). Insights gitRef surface noted, unchanged.
- Read-only comparison contexts: suppress the working-tree staleness 'rebuild' banner when readOnly (meaningless there — verifier catch); ready-state read-only regression test (fixture needs at least {files: []} — `{}` crashes ChangesView :333).

### P3 commit sequence

1. core: violation-delta sections + comparisonLabels + readOnly banner suppression + ready-state test (cartographer-core/atlas).
2. server: contracts + migration 059 + DiffAnalysisService + merge-base helper + semaphore unification + registry diff slot + openAtlasForDiff.
3. web: DiffPanel tab + intent + card action + client-runtime atoms.
Gates: focused suites per commit; final = test-t3-app pass (analyze a turn diff, cached reopen, source-changed re-analyze, truncated-preview disclosure) + a real-repo analysis cost measurement recorded in the plan (informs P5 auto-compute).

### P3 execution record (2026-08-07, run t6p2)

Landed as 5 commits (23705ecb9 core labels/violation-deltas/read-only suppression, 5d03ed05a contracts, b4a3d7e1a server cache+service+transport+diff contexts, 743a7ee9e web Architecture tab + client state, 2105ce7d0 gate fixes). Gate verifier PASSed the branch-local migration 052 identity/index design, later renumbered to integration reconciliation 059, and the eager-Effect-ternary sweep (no new instances); it FAILed eleven items, all closed by remediation worker 6004a6b5 (commit 2105ce7d0): declared-family error taxonomy w/ casts removed + logged terminal-update failures; owner workspace root restored as a REQUIRED authorization input on request/get/open; one indistinguishable diff_analysis_not_found shape; flat source union in the web construction sites; owner in RPC payloads/keys/admission; diff-context close releasing leases; working-tree live-root revalidation; hosted comparison-label injection; reachable stale sourceCurrent:false; dead-helper adoption; normalizer cast removal; partial terminal-cutoff index.

**Lead reconciliation (binding for later phases):** the four P3 workers disagreed on `DiffAnalysisSource` — one emitted a nested-key wrapper (`{checkpoint:{...}}`), another assumed `{_tag:'treePair'}`. The lead reshaped it to a flat `Schema.Union` discriminated on `sourceKind`, matching the house literal-discriminant precedent in `orchestration.ts`, and threaded it through server, ws, client-runtime, web, and tests. The review variant keeps its own `kind` (working-tree | branch-range) per the plan text.

Real defects the lead found and fixed while integrating the worker patches: `publicGeneration` built a non-contract object hidden behind an `as` cast; the interrupt path wrote errorCode `'cancelled'`, which is a STATE, not a member of the error family; `runRetention` is an `Effect.fn` thunk that was piped instead of called, so retention never ran; the base/head tree roots were never created, so `materializeExactGitTree` failed EVERY generation as materialization-failed; a shape-sniffing normalizer cast through `Record<string, unknown>`; and `get()` was id-only, violating the P5 target-identity amendment (fixed with `repository.getByIdentity` + a `readRowByTarget` guard requiring any supplied id to match the resolved identity). `retainReadyTarget` stays id-addressed deliberately: open is operate-scoped and always follows a request/get. Two test-fixture defects: non-hex tree OIDs, and a shared in-memory database where both persistence cases used one cache identity, so the second admit silently exercised the dedup path instead of inserting.

Censuses held: apps/server tsc 126 (125 baseline, +1 from the new RPC row inheriting server.test.ts's file-wide diagnostic), vp check 8 pre-existing. Suites green except the 4 PRE-EXISTING `importedSessionWorkLog` failures. Note for future runs: the atlas suite runs from `apps/atlas` under its own config, not from the tests root.

DEFERRED (recorded, not silently dropped): the plan's integrated `test-t3-app` browser gate (plan P3 acceptance) and the real-repository analysis cost measurement remain open — the preview automation broker is unavailable this session.

## Phase 4 — pillar-A hardening & orchestrate linkage (VERIFIED PLAN)

Status: pyramid complete (8 sourcers -> 4 drafters -> 2 verifiers -> lead check-off). Four sub-areas; can interleave after P1, with sub-area D also gated on P2 (right-panel v9) and P3 (the diff-analysis schema now reconciled by migration 059), and sub-area C's full acceptance gated on P2/P3 surfaces existing.

### Lead decisions (binding)

- D1: orchestrate<->proposal linkage is a separate link relation (option B); `ProposalRevision.planId` + `findLatestByPlan` untouched; a link means the exact committed `(sourceThreadId, runId, revision)`, never latest-for-run.
- D2: stream fix is the minimal predicate expansion (two literals only); U-171/U-168 stay deferred (documented 8-test subscribe regression on the prior attempt); the remaining 17-event filter delta is recorded follow-up, not claimed coverage.
- D3: proposal MCP gate widens to plan|orchestrate in the same landing unit as the instruction widening; sequencing contract: `orchestrate_plan_upsert` -> committed `(runId, revision)` -> `proposal_preview_upsert` + link -> emit the `orchestrate-plan` fence (the fence is the orchestrate finalization anchor).
- D4: ProposedPlanCard auto-start = one automatic attempt per revisionKey, then manual retry only; no timers/backoff; terminal failures surface in the card with Retry; polling stays active-states-only @1.5s.
- D5: atlas context recovery = typed `context_not_found` + one automatic reopen per (connection generation, semantic context identity); reopen failure -> persistent banner + Retry; abandoned generations never auto-recompute.

### Adjudications (stale mega-review claims; regression tests, not re-fixes)

- SRV3-11 FIXED in live source: orchestrate handler reads `readEvents(dispatchResult.sequence - 1, 1)`, validates the committed event (`sequence === dispatchResult.sequence`), returns the committed plan (handlers.ts:208/:222).
- DR-1 FIXED: client revert filters `orchestratePlans` by retained turn IDs and mirrors server retention (`turnId === null || retainedTurnIds.has(turnId)` on both sides).
- WEB1-3 partially fixed but over-corrected: failure branch clears the auto-start guard (ProposedPlanCard.tsx:144-145), re-enabling repeat auto-starts — completed by sub-area B.
- U-215 order CORRECTED (overrides the mega-review "corrected" assertion): live `consumeOnSuccess` runs `use(grant)` (SessionStore.issue -> clientUpserted) before `consumeUnlocked` (pairingLinkRemoved); the shared revision counter numbers events in arrival order. The test must assert `['snapshot','pairingLinkUpserted','clientUpserted','pairingLinkRemoved']`, revisions [1,2,3,4], new client `current === false`.

### Sub-area A — WS/stream + revision delivery

- Edit only `orchestrationThreadStreamHandlers.ts:isThreadDetailEvent` (Extract type + runtime boolean): add `thread.orchestrate-plan-upserted` and `thread.orchestrate-plan-response-requested`. Shared predicate covers live + bounded replay automatically; client `applyItem` sequence fence and 16ms/128-item coalescer unaffected; reducer cases already exist (threadReducer.ts:758/:778). UX result: live card supersession + approve/reject badges without snapshot reload.
- Tests stay in `tests/apps/server/server.test.ts` ('server router seam'; no new handler unit file): (a) snapshot-race sibling publishing a plan-upsert during snapshot load (snapshot then event); (b) bounded-resume with `afterSequence: 1`, asserting replay args `[1,1]` and event-before-synchronized. Reducer tests (baseThread/baseEventFields): upsert supersession, approve/reject transitions, orchestratePlans-filtered-on-revert.
- U-215 test with the corrected order above; seed via owner cookie -> POST /api/auth/pairing-token -> `exchangeAccessToken`; single session so the WS adds no extra client event.
- New `tests/apps/server/mcp/OrchestrateToolkit.test.ts` (mirror ProposalToolkit makeLayer/invocation; `McpHttpServer.OrchestrateToolkitRegistrationLive` confirmed at :248): revision derivation above persisted/projected maxima, dispatch payload, committed-event readback ({sequence:42} -> readEvents(41,1)). Simulated readback coverage only — not a true concurrency test.
- Deferred (constraints for any future redesign: snapshot-first, attach-before-read, RESUME_MAX_EVENT_GAP=1000, marker ordering, live-tail continuity): U-171, U-168, U-167, U-184, U-189, and the 17 remaining filter events.

### Sub-area B — card + generation UX hardening

- Replace `generationStartRef` with a keyed external start store (new `apps/web/src/components/chat/proposedPlanGenerationStart.ts`): `{status: idle|starting|started|failed, error, generation, attemptId}` keyed by `[environmentId, threadId, proposalId, revision]`. External store is required — cards remount under LegendList virtualization (confirmed by orchestratePlanStore's own comment) — but NO LRU eviction for failure tombstones (eviction would re-enable auto-start). One auto attempt from `idle` only; `failed` never auto-eligible; manual Retry bumps `attemptId`; stale key/attempt completions ignored.
- Card error surfacing: one inline `role="alert"` block in the preview-identity area + `Retry analysis`; shared failure formatter extracted from Explorer's `generationFailureMessage` so card/Explorer copy cannot drift; `abandoned`+`server-restarted` gets sub-area C's copy. `ProposalGeneration` has `errorCode` only (no errorMessage) — fall back to humanized codes; no parallel persistence.
- ConnectedExplorerPanel retry completion (all confirmed live symbols): generation-detail failure (polling stops on `queryFailed` — retry invalidates embed identity then `generationQuery.refresh`), embed issuance failure, malformed embed URL (`resolveCartographerEmbedLocation` null branch). Every retry bumps `embedRequestSequenceRef` and installs a new `{key, requestId}` before reissue so late one-use successes fail `isCurrentEmbedRequest` and are released. NO manual retry on the latest-generation lookup — it self-polls @3s even on failure (interval gated only on enabled/cartographerAvailable).
- Shared idiom for P2 AtlasPanel + P3 DiffPanel: authoritative message + exactly one Retry + identity invalidation before reissue + late results fenced. P1 rebase boundary: if P1 lands first, port the retry states + monotonic fence onto `openAtlas`; do not resurrect ticket/session code.
- Tests: SSR markup cases in ProposedPlanCard.test.tsx (error copy, alert role, Retry presence — SSR runs no effects); pure-helper transitions in new `tests/apps/web/components/chat/proposedPlanGenerationStart.test.ts`; ConnectedExplorerPanel logic tests for the three retries + fence ordering. Note: ProposalGenerationService startup-recovery assertions live inside the single it.effect 'analyzes retained trees, terminalizes superseded work, and reports drift' (~:700-756).

### Sub-area C — session/restart durability

- Typed missing-context contract (amends P1, which names `context_not_found` but assigns no status/schema/recovery): all `/atlas/ctx/:id/*` routes for an absent id return 404 JSON `{"version":1,"code":"context_not_found","message":"Atlas context is no longer available."}` with `Cache-Control: no-store`; HEAD bodyless; 308 only after existence check; never synthesized for analysis/artifact failures. Host-owned authenticated probe `GET /atlas/ctx/:id/api/host/context` (host-prefixed to avoid colliding with cartographer-core SPA routes — verify no `/api/context` collision at implementation start) -> 200 `{"version":1,"contextId":id}`. Auth transport split: web = `t3_session` cookie via `credentials:'include'` (EnvironmentAuth accepts cookie ?? bearer ?? dpop); desktop = P1's webRequest bearer injection (covers /atlas/ctx/* GET/HEAD for the active primary backend, including a WSL-only primary); scope = `orchestration:read`; probe sits behind P1's Bun 501 Node-runtime gate. Client recovery triggers only on 404 + decoded typed body.
- Recovery controller (new `apps/web/src/components/cartographer/atlasContextRecovery.ts`) scoped to P1 Explorer + P3 diff views only; P2 recovery is status-stream-driven (subscribeAtlasStatus resubscribes on new generation and carries contextId+url — the probe would be double machinery; status stream takes precedence for P2). Once-guard: `useRef<Set>` keyed `${connectionGeneration}:${semanticIdentity}`, cleared on generation change; probe/open aborted + sequence-fenced; reopen swaps iframe via `key={contextId}`. Connection generation goes in the guard key, NOT open/context target keys (would reopen healthy contexts and re-run P1 worktree capture+analysis on every reconnect). Banner on reopen failure: "456code couldn't reopen this architecture view after reconnecting." + Retry (manual Retry may bypass the once-guard).
- Restart matrix (full table in drafter record): P1 thread/worktree context -> reopen recaptures+reanalyzes once; P1 ready-proposal context -> `resolveEmbedTarget` rebinds sealed artifacts, no recompute; P2 standing context -> persisted graph/index + `.project-atlas.json` validate -> lazy id recreation without build; P3 diff slot -> ready row + retained cache rebind via `openAtlasForDiff`, pruned cache -> explicit unavailable/re-analyze state (a P4 ADDITION, not existing P3 spec); in-flight generations -> abandoned/server-restarted, partial roots removed, never auto-restarted (auto-start already blocked because `latest` returns the non-null abandoned row).
- server-restarted affordance (durability owns semantics; sub-area B owns layout): copy "The server restarted before architecture analysis finished. Retry to start a new analysis." + `Retry` invoking `startProposalGeneration` with the same thread/proposal/revision. P3 parallel copy for diff analyses is observable within the five-minute terminal-row window. Proposal generation retention now applies a 24-hour grace while preserving the newest ready and newest restart-abandoned row for each revision.
- Desktop: 500ms-10s backoff + 1-min readiness window are transient states, never terminal Explorer errors. Real packaged-desktop restart pass is manual-only.

### Sub-area D — orchestrate linkage + gate widening (verifier-amended)

- Contracts (packages/contracts/src/proposal.ts): `ProposalOrchestratePlanTarget {runId, revision}`, `ProposalOrchestratePlanLink {proposalId, proposalRevision, sourceThreadId, runId, revision, createdAt}`, lookup input/result; `ProposalPreviewUpsertInput` gains optional `orchestratePlan` (no authority fields — scope stays derived from McpInvocationContext). New RPC `proposals.findByOrchestrateRevision` (input exact triple; success NullOr(result); errors ProposalError|EnvironmentAuthorizationError).
- Migration 053_ProposalOrchestratePlanLinks remains the durable-link migration; the integration-only diff-analysis reconciliation is 059. Its PK is `(proposal_id, proposal_revision)`, with UNIQUE `(source_thread_id, run_id, orchestrate_revision)` (also the exact-lookup index) and an FK to `proposal_revisions(proposal_id, revision)` ON DELETE CASCADE. There is NO FK to `projection_thread_orchestrate_plans` — projection state is derived: the live revert path delete+reinserts thread rows and `bootstrapProjector` replays from sequence 0 when projection_state is absent; either would cascade-destroy durable links. Instead, on revert, the projection transaction explicitly deletes link rows for the pruned `(thread, run, revision)` keys (and switches projection-row deletion to targeted pruned-key deletes); a lookup whose projection row is absent returns null (not an invariant violation).
- Server flow: `proposal_preview_upsert` branches on `thread.interactionMode` — plan: reject `orchestratePlan` input, derive `planId` via `proposedPlanIdForTurn` unchanged; orchestrate: require `orchestratePlan`, no planId, validate the exact projected revision (active turn, `source === 'tool'`; status not an identity constraint) then recheck + insert revision and link atomically inside `ProposalRepository.append`'s existing transaction; default mode rejected. Failure codes: missing input/wrong turn/fence-sourced -> identity-mismatch; missing exact row -> not-found; SQL -> persistence-failed. Supersession leaves the link pointing at the exact (now superseded) revision; UI shows status.
- Instructions: move `T3_CODE_PROPOSAL_TOOL_INSTRUCTIONS` (currently non-exported in CodexDeveloperInstructions.ts) into CollaborationModeInstructions.ts; compose into Plan + Orchestrate blocks once (`CODEX_ORCHESTRATE_MODE_DEVELOPER_INSTRUCTIONS` stays the shared alias); generalized wording carries the D3 sequencing + "fence, not <proposed_plan>, is the orchestrate anchor" + failure-report rule. Delivery matrix unchanged in mechanism (Codex native; Claude dual-channel; Cursor/Grok/OpenCode wrapped; OpenCode external-server code456 injection stays UNCERTAIN). Pinned tests to update: ProviderService 'delivers orchestrate mode instructions to non-Codex lead providers', ClaudeAdapter 'switches orchestrate system instructions on and off between turns', CodexSessionRuntime plan/orchestrate substrings. Gate widening + instruction widening are one indivisible commit.
- Web: rightPanelStore Explorer target becomes discriminated `{kind:'plan',planId} | {kind:'orchestrate',threadId,runId,revision}` (storage v10 atop P2's v9; migrate legacy planId into the plan arm). `OrchestratePlanActions` gains `threadRef` (ScopedThreadRef from ChatView's activeThreadRef). Architecture strip between OrchestratePlanCard header and stage table (ProposedPlanCard previewIdentity precedent); states: no persisted revision -> omit; pending/no-link/linked+generation-states/terminal; rendered on superseded cards too; never retargets. View-only linkage — the strip never calls `startProposalGeneration` (Explorer keeps its existing start-on-open; auto-compute is P5). ConnectedExplorerPanel branches by discriminator with no orchestrate->plan fallback.

### P4 commit sequence

1. server: `isThreadDetailEvent` expansion + snapshot-race/bounded-replay regressions.
2. tests: client-runtime reducer lock (supersession/approve-reject/revert) — may fold into 1.
3. tests: U-215 corrected-order auth-access feed.
4. tests: OrchestrateToolkit committed-readback regression.
5. web: keyed generation-start store + card error/retry surface.
6. web: ConnectedExplorerPanel retry completion (rebase onto P1 atlas-open if landed).
7. cartographer/server: typed context_not_found + host probe + route/registry tests.
8. tests: client-runtime reconnect revalidation proofs.
9. web: atlas context recovery controller + P1/P3 adapters; P2 stays status-stream-driven.
10. proposals/web: server-restarted copy + manual retry (coordinate with 5).
11. contracts: link/target/lookup schemas + RPC.
12. server: migration 053 + explicit link pruning + atomic append + exact lookup + supersession/revert tests.
13. server: proposal gate widening + shared instruction relocation + provider matrix tests + OrchestrateToolkit gate cases (indivisible).
14. web: Explorer target v10 + card strip + routing.

### P4 acceptance

Per-package focused suites (canonical form; web needs `--project unit`; apps/server config enforces fileParallelism:false):
`(cd apps/server && ../../node_modules/.bin/vp test run server.test.ts mcp/ProposalToolkit.test.ts mcp/OrchestrateToolkit.test.ts proposal/ProposalMigration.test.ts proposal/ProposalService.test.ts orchestration/Layers/ProjectionPipeline.test.ts provider/Layers/ProviderService.test.ts provider/Layers/ClaudeAdapter.test.ts provider/Layers/CodexSessionRuntime.test.ts cartographer/ProposalGenerationService.test.ts cartographer/DiffAnalysisService.test.ts)`;
`(cd packages/client-runtime && ../../node_modules/.bin/vp test run state/threadReducer.test.ts state/runtime.test.ts rpc/client.test.ts connection/supervisor.test.ts)`;
`(cd packages/contracts && ../../node_modules/.bin/vp test run proposal.test.ts)`;
`(cd apps/web && ../../node_modules/.bin/vp test run --project unit rightPanelStore.test.ts components/chat/ProposedPlanCard.test.tsx components/chat/proposedPlanGenerationStart.test.ts components/chat/orchestrate-plan/OrchestratePlanCard.test.ts components/explorer/ConnectedExplorerPanel.test.ts components/explorer/ExplorerPanel.test.tsx components/cartographer/atlasContextRecovery.test.tsx components/atlas/DiffAnalysisPanel.test.tsx components/atlas/ConnectedAtlasPanel.test.ts state/environmentHttp.test.ts)`.
Note: sub-area C's web/server lists reference P2/P3 surfaces (AtlasPanel/DiffPanel/AtlasRebuildService/DiffAnalysisService tests) — those cases only exist once P2/P3 land; a P1-only subset applies otherwise. `vp lint <files>` positional form unverified — check `vp lint --help` or use `vp check` (CI gate; not a routine local step per AGENTS.md). `fmt:check -- --staged <files>` means explicit-file mode, not git staging.
Integrated: one test-t3-app pass covering live card supersession + approve/reject without reload; one auto-attempt + persistent failure + manual retry; server restart -> reconnect -> typed context recovery with no duplicate reopen; orchestrate revision -> linked proposal -> card strip -> exact Explorer routing -> supersede without retarget -> revert prunes link. Packaged-desktop restart pass manual-only.

### P4 open items

- U-171/U-168 redesign (deferred; constraints recorded in sub-area A).
- cartographer-core `/api/context` route-collision check before finalizing the probe path.
- Whether P2's status stream needs an explicit precedence rule vs the probe if a P2 surface ever embeds via the P1 path (currently moot — controller scoped to P1/P3).
- 17-event filter/reducer parity delta (follow-up hardening ledger).

## Phase 5 — agent tools & auto-compute (VERIFIED PLAN)

Status: pyramid complete (8 sourcers -> 4 drafters -> 2 verifiers -> lead check-off). Depends on P0-P4 (contracts/toolkit need the absorbed package + P1/P2/P3 context machinery; instructions compose on P4's relocated proposal block). Four sub-areas.

### Lead decisions (binding)

- E1: one new `architecture` MCP capability (added to McpCapability + the McpSessionRegistry.issue set); toolkit-local typed capability error — `requireMcpCapability` is narrowed to `preview | proposal` explicitly (its current `Exclude<...,'orchestrate'>` signature would silently admit new union members its error schema cannot encode).
- E2: `architecture_blast_radius` + `architecture_graph_diff` are read-only, SESSION-scoped (no active turn, no mode gate — preview read-only precedent, idle-session invocation pinned by test). `architecture_propose_patch` is ACTIVE-TURN-BOUND (proposal/orchestrate predicate copied exactly) but allowed in default|plan|orchestrate — it mutates only turn-scoped evaluation state, never the worktree or the Proposal system.
- E3: no tool ever triggers analysis/builds; queries run over already-analyzed artifacts; missing/unready contexts return typed `context-not-ready` with a recovery action enum (open_current_worktree_atlas | complete_proposal_analysis | build_project_atlas | complete_diff_analysis).
- E4: auto-compute = new durable reactor `ArchitectureAutoAnalysisReactor` on `thread.turn-diff-completed` status ready only; checkpoint pair [max(0,n-1), n]; never worktree/HEAD; checkpoint-ref-missing terminal no-op; `files: []` still requests (ambiguous: empty diff vs summary failure — P3 cache answers cheaply).
- E5: no new fence card; tool calls render via existing MCP work-log rows; auto results surface through P3 polling; the "impact available" cue is DEFERRED (no durable consumed-state exists; follow-up recorded).
- E6: one shared `T3_CODE_ARCHITECTURE_TOOL_INSTRUCTIONS` (~1.17k chars, full text in drafter record) composed into Plan (Codex-only in v1) + Orchestrate (all providers); default mode unchanged everywhere; composition order pinned browser -> architecture -> proposal (amends P4's unpinned proposal placement).

### Verifier-forced reconciliations (applied)

- Contracts module = `packages/contracts/src/architectureTools.ts` (both sub-areas; test `tests/packages/contracts/architectureTools.test.ts`).
- ONE frozen bound policy for the whole toolkit: 200-class caps (lists 200, API 100 files/50 exports/25 consumers, blast paths 400/direction, patch issues 200, validation 20/50/200) — cartographer's HTTP boundDiff 500-class caps stay HTTP/SPA-internal. `{items, total, omitted}` everywhere.
- Selector kinds kebab-case: `current-thread-worktree` | `proposal-generation` (+ graph base|proposed) | `standing-project` | `diff-analysis` (+ graph base|head). No caller-supplied env/thread/project/root/path/context-id — authority from McpInvocationContext only; graph_diff comparisons address exactly proposal-generation or diff-analysis identities (no arbitrary pairs).
- Unified kebab error family: capability-unavailable | identity-mismatch | not-found | context-not-ready | target-not-found | unsupported | invalid-patch | limit-exceeded | evaluation-failed | persistence-failed (matches live proposal/orchestrate handler codes).
- `ArchitectureQueryService` (apps/server/src/cartographer/) gains an explicit `resolveContext` contract returning a leased ready `{root, outDir, liveRoot?}` handle — required by propose_patch's patchNodeResolver/staleness path.
- Upstream amendments now explicit (were silent in drafts): P1 AtlasContextRegistry needs read-lease acquisition + stored-source-kind query + published-graph-path accessors (new API, was never planned); P2 needs a read-only last-good project-generation accessor exposing root+outDir; P3's `retainReadyTarget` lease is already planned (no amendment); P3 FIRM EDIT: `cartographer.getDiffAnalysis` (or sibling read RPC) must accept TARGET identity, not just ID — otherwise an open panel can only rediscover an auto-created analysis via the operate RPC, which would initiate compute on a cache miss.

### Sub-area i — architecture query toolkit

- Package core (new exported modules in the absorbed cartographer package; Node facade only, no ./browser): `analyze/graphRelations.ts` (createGraphRelationIndex — adjacency built once per loaded graph; today rebuilt per computeBlastRadius call), `analyze/impactProfile.ts` (bounded typed blast query over a prebuilt index; preserves file + file#export modes, deterministic order; legacy function delegates), `query/contextQuery.ts` (load + normalize + v4-validate + query; typed core failure codes). CLI/stdio-MCP can adopt later; standalone tool names/behavior unchanged.
- Server: ArchitectureQueryService — resolution table per selector (P1 read lease for current-worktree; ProposalGenerationService.get + resolveEmbedTarget for generation sides; P2 last-good accessor; P3 row + retainReadyTarget for diff sides; pairs resolved atomically under the owning service's lease). Wrong-owner/nonexistent -> not-found masking; unfinished/pruned -> context-not-ready + recovery. Graph cache keyed by canonical path + file stamp (ino/mtimeNs/size — fileStamp precedent), stat-before/after with retry, 4 entries / 128 MiB, graph+relation-index cached together; never calls ensureAtlasIndex/analyzers/semaphore.
- Toolkit: `architecture_blast_radius` / `architecture_graph_diff`, Tool.Readonly + Idempotent + non-Destructive + closed-world; handlers = capability check + service call only (no turn/mode/session reads); standard `McpServer.toolkit(...)` registration merged into McpHttpServer.layer.
- Tests: contracts decode/bounds-invariant/pin tests; package impactProfile + contextQuery determinism/truncation/v4-rejection; service resolution-table + masking + eviction + no-compute; toolkit descriptor/schema test (no root anyOf/oneOf, described params) + behavior test w/ idle-session (no activeTurnId) case; capability-set pin test updated.

### Sub-area ii — architecture_propose_patch

- Input: cartographer GraphPatch v1 ops verbatim (add_file/remove_file/move_file/add_import/remove_import; 1..2,000 ops; 1 MiB canonical serialization; path 512/notes 500/symbols 200 caps; typeOnly only `true`; paths repo-relative POSIX, rejected-not-normalized — rules stated in the tool description). Context: current-thread-worktree or standing-project only (diff-analysis pairs are incoherent patch baselines).
- Evaluation: server-derived metadata -> parseGraphPatch -> canonical size gate -> patchNodeResolver(context root .cartographer.json; brace-free globs) -> evaluatePatch (50k nodes/100k edges/3M work, verbatim; limit -> typed limit-exceeded with kind/scope/actual/limit) -> patchToDiff (apiChanges ALWAYS [] by design — documented in DTO) -> 200-class bounds -> staleness (generation-mismatch|ref-mismatch|dirty-tree; workingTreeState only when a live git root exists). Skip-and-record per-op issue semantics preserved (indexed issues + totals) so the model can self-correct; all-skipped is still success. No worker thread in v1 (3M work cap + duration metric; adopt cartographer's patchPreviewRunner pattern only if measured).
- Persistence: EPHEMERAL (option a). Hosted contexts serve readOnly — cartographer 404s all patch routes and hides ProposalsRail in readOnly, so a saved catalog entry would be invisible. Result lives in the turn's tool.completed activity data. No patchId/paths returned. Prerequisite core work: export patchToDiff/applyPatch/validatePatchStructure/PatchEvaluationLimitError via the analyze barrel + serializePatch/PatchSizeError from the store (currently private/non-barrel).
- Explicit non-goals: no ProposalService.upsert, no Proposal/ProposalRevision rows, no retained refs/materialized trees/generations, no P4 link-table writes, no worktree edits. Agent flow prose (feeds sub-area iv): explore with blast_radius/graph_diff -> sanity-check structure with propose_patch -> author the real plan/proposal via existing tools (P4 sequencing unchanged in orchestrate mode).

### Sub-area iii — auto-compute reactor + setting

- `ArchitectureAutoAnalysisReactor`: new ReactorId literal `architecture-auto-analysis` (Schema.Literals edit in persistence/Services/OrchestrationReactorDelivery.ts is a required code change; migration 045 stores reactor ids as TEXT — no SQL migration). Action target `[threadId, turnId, checkpointTurnCount]` (physical id still includes sourceSequence per makeReactorActionId — replay-stable per event, not cross-sequence). plan() = event type + status==='ready' only (missing/error -> []); no filesystem reads at plan time. execute() = decode -> settings check (`architectureAutoAnalysis !== 'auto'` -> terminal setting-not-auto; execution-time, so mid-flight flips terminalize cleanly) -> getThreadCheckpointContext (none -> thread-deleted) -> supersession check (latest ready checkpointTurnCount > payload's -> terminal superseded; claimed-then-settle is the ONLY viable coalescing — FIFO claimAction admits earliest-unresolved; skipStaleByTarget exists but is exact-target and cannot express cross-turn supersession) -> DiffAnalysisService.request(owner thread, checkpoint source [max(0,n-1), n]) -> accepted/cache-hit/equal-tree all success. Failure table: transient -> retryable (runner 1s->5min, manual after 8); setting-off/checkpoint-ref-missing (refs deleted by CheckpointReactor.ts:driveCheckpointRevertPhase cleanup arm)/thread-deleted/non-git/P3-not-ready -> terminal no-op; invalid payload -> poison. Registered in makeOrchestrationReactor (after CheckpointReactor) + server ReactorLayerLive; first-install seeds at current snapshot sequence = NO-BACKFILL invariant (enabling 'auto' never replays history; standard shadow-to-durable cutover).
- Setting: `architectureAutoAnalysis: 'off' | 'on-demand' | 'auto'` default on-demand in ServerSettings/-Patch (scalar; flows through packages/shared applyServerSettingsPatch with no atomic-key case); v1: 'off' === 'on-demand' behaviorally (only disables auto; manual P3 affordance untouched — stated in copy). Full pipeline per the automaticGitFetchInterval precedent (ServerSettingsService semaphore/cache/publish + 100ms watcher; serverUpdateSettings/subscribeServerConfig; applyServerConfigProjection; useEnvironmentSettings). UI: new EXPORTED `ArchitectureAutoAnalysisSettings` component file rendered from SourceControlSettings' Version Control git item below GitFetchIntervalSettings (the precedent component is non-exported — new file keeps the cited test path satisfiable), + GeneralSettingsPanel restore integration.
- Metrics: `t3_architecture_auto_analysis_actions_total` + `_action_duration` via Metrics.withMetrics; low-cardinality actionResult labels; reactor measures admission latency — P3's worker keeps compute-duration metrics (optionally + trigger=auto|on-demand label).
- Live surfacing: NO new thread event in v1 (analysis is an evictable cache; an event would outlive purged rows); P3 state-gated polling converges on the reactor-created row via the target-identity read RPC (the firm P3 amendment above).

### Sub-area iv — instructions + surfacing + integrated validation

- One shared block (~1.17k chars; full text in drafter record): when-to-use (blast_radius before invasive/cross-boundary changes in plan; before gating shared-interface plans in orchestrate), graph_diff for analyzed states only, propose_patch after the edit set is decision-complete ("analysis, not authority to edit"), sequencing before the mode's plan/proposal anchor, conditional exposure wording, never-invent-authority, fail-open-to-repo-evidence. Composed: Codex Plan (browser -> architecture -> proposal, insertion point exists today) + ORCHESTRATE_MODE_INSTRUCTIONS (order pinned browser -> architecture -> proposal, post-P4). Plan-mode delivery = Codex-only in v1 (option a): non-Codex plan modes have NO shared text channel today; building one means a new cross-provider wrapper + Claude subprocess-restart costs — recorded follow-up, asymmetry explicit. Orchestrate coverage reaches all providers via the existing wrapper (+ Claude dual-channel).
- Pinned tests: ProviderService exact-equality + ClaudeAdapter deep-equality both build expectations from the imported constant (growth auto-propagates — verified); add semantic /architecture_blast_radius/ assertions; CodexSessionRuntime plan/orchestrate substring additions + default `doesNotMatch(/architecture_/)`.
- Surfacing: zero new client code — MCP lifecycle rows render on web (WorkTimelineRows) + mobile (worklog rows). DEFECT + fix folded into P5: Claude/OpenCode classifiers check 'patch' before 'mcp', so `architecture_propose_patch` would classify as file_change (wrong row kind, no data.item extraction) — reorder the 'mcp' check first in ClaudeToolProjection.classifyToolItemType and OpenCodeAdapter.toToolLifecycleItemType (one line each; names containing 'mcp' are always MCP calls, native file tools never contain it). Cursor/Grok ACP -> dynamic_tool_call rows (accepted v1; fixture follow-up). Cue/badge deferred (no consumed-state contract exists; follow-up: readyAt/consumedAt keyed by the P3 cache identity).
- Integrated acceptance (test-t3-app): plan-mode turn with blast_radius + graph_diff visible as work-log rows; orchestrate turn obtaining impact before orchestrate_plan_upsert -> proposal+link -> fence (P4-consistent) with one non-Codex provider; setting -> auto, ordinary turn auto-creates the P3 analysis, DiffPanel Architecture tab shows it with NO Analyze click (opening observes, never initiates); no toast/badge/panel beyond P2/P3; revert to on-demand stops the next turn's auto request.

### P5 commit sequence

1. contracts: architectureTools.ts v1 DTOs (selectors, results, unified error family, bounds constants).
2. cartographer package: graphRelations + impactProfile + contextQuery core exports + patch-helper barrel exports.
3. server: ArchitectureQueryService (resolveContext handle, resolution table, bounded cache) + P1/P2 accessor amendments.
4. mcp: architecture toolkit (2 read-only tools) + capability plumbing + requireMcpCapability narrowing.
5. mcp: architecture_propose_patch (turn-bound handler, evaluation flow, ephemeral result).
6. settings: architectureAutoAnalysis end-to-end + ArchitectureAutoAnalysisSettings UI + restore integration.
7. cartographer/server: ArchitectureAutoAnalysisReactor + metrics + P3 target-identity read amendment.
8. provider: shared instruction block + composition + pinned-test updates + classifier 'mcp'-first reorder.
9. tests wave per sub-area (contracts/package/service/toolkit/reactor/settings) — may fold into 1-8 per repo convention.

### P5 acceptance

Per-package focused suites: `(cd packages/contracts && ../../node_modules/.bin/vp test run architectureTools.test.ts settings.test.ts)`; `(cd packages/cartographer-core && ../../node_modules/.bin/vp test run analyze/impactProfile.test.ts query/contextQuery.test.ts graphPatch.test.ts)`; `(cd packages/shared && ../../node_modules/.bin/vp test run serverSettings.test.ts)`; `(cd apps/server && ../../node_modules/.bin/vp test run mcp/McpSessionRegistry.test.ts mcp/ArchitectureToolkit.test.ts mcp/toolkits/architecture/tools.test.ts cartographer/ArchitectureQueryService.test.ts orchestration/Layers/ArchitectureAutoAnalysisReactor.test.ts serverSettings.test.ts observability/Metrics.test.ts provider/Layers/ProviderService.test.ts provider/Layers/ClaudeAdapter.test.ts provider/Layers/CodexSessionRuntime.test.ts orchestration/ActivityPayloadProjection.test.ts)`; `(cd packages/client-runtime && ../../node_modules/.bin/vp test run state/server.test.ts)`; `(cd apps/web && ../../node_modules/.bin/vp test run --project unit components/settings/ArchitectureAutoAnalysisSettings.test.tsx)`; per-package `vp run typecheck`; targeted comments:check/fmt:check over changed files. Integrated: the sub-area iv test-t3-app scenario. `vp check` remains the CI gate.

### P5 definition of done

- Toolkit: three architecture_* tools live with frozen v1 contracts, unified error family, capability + correct turn/mode scoping, bounded results, zero compute triggering; toolkit/service/package tests green.
- Auto-compute: on-demand stays default; 'auto' requests exactly the newest eligible checkpoint pair per thread through P3's cache/semaphore with no backfill and no retry storms; visible via P3 polling without user action.
- Instructions: block present in Codex Plan + all-provider Orchestrate, absent in default; pinned tests updated; work-log rows show calls on web+mobile (incl. the classifier fix).
- Closeout: focused suites + integrated pass recorded; OpenCode external-server MCP gap and Cursor/Grok dynamic-row limitation recorded as known, not resolved.

### P5 open items / follow-ups

- Cross-provider plan-mode instruction delivery (new wrapper machinery; deliberate v1 asymmetry).
- "Architecture impact available" cue (needs readyAt/consumedAt consumed-state design).
- Cursor/Grok ACP MCP-classification fixtures; Claude/OpenCode data-envelope normalization for full result expansion.
- Worker-thread adoption for propose_patch evaluation if duration metrics justify it.
- P3/M1-M5 cost measurement still gates 'auto' default reconsideration. Runtime-control v2 and the
  bounded harnesses passed review, but no cell completed validation/finalization before wrap-up; no
  retained raw attempt is admissible for a performance conclusion.

### Local implementation closeout (2026-08-07)

Focused acceptance on the final local tree:

| Scope | Result |
|---|---|
| P4 server | 12 files / 273 tests passed on the first run |
| P5 server | 11 files / 176 tests passed |
| Web P4/recovery + settings | 11 files / 85 tests passed; web typecheck passed |
| Cartographer core + Atlas patch | 4 files / 55 tests passed; core typecheck and build passed |
| Contracts + client runtime + shared | 9 files / 141 tests passed; all three typechecks passed |

The bounded `test-t3-app` pass changed Architecture analysis to Automatic, reloaded to prove persistence, built the real standing atlas for this repository (2,941 files, 8,361 imports, 10 systems, 17 blocks), and then restarted the backend. Recovery replaced context `WdUJQmdySIGN-yBeoL93CHvZ` with `BT2uF5FrSzfr9z-cKoKkzpCm` while retaining the ready frame; the browser console had zero errors. The isolated browser tabs and task-owned dev processes were closed afterward.

An adversarial final audit found no remaining concrete in-scope correctness gap. Security was not
assessed by that workflow. The strict v4 loader now also enforces nonempty journey/runtime
resolution evidence, real import-edge hop paths, authored hop endpoints, and compatibility with
bounded witness lists. Architecture MCP failures retain their structured error code/recovery/limit
envelope; proposal and diff admissions are shutdown-fenced; Atlas recovery uses exact-origin
cookie/Bearer/DPoP request preparation.

### Review remediation (2026-08-08)

A follow-up review raised five issues against this tree; all five are addressed.

| Issue | Resolution |
|---|---|
| Architecture MCP defects returned `Cause.pretty` to the client | masked behind `ARCHITECTURE_TOOL_UNEXPECTED_FAILURE_TEXT`; detail logged server-side; interrupt-only causes propagate |
| Retry recorded a null generation baseline after query eviction | `proposalGenerationStartBaselineGenerationId` falls back to the retained `state.baselineGenerationId` |
| `lookupPending` conflated revalidation with initial load | `EnvironmentQueryView.hasSettled` added; the orchestrate strip keys its null branches off settled, not pending |
| Plan/Orchestrate rows and auto-reactor flow not driven end to end | partially closed — see the acceptance limits below |
| Strict loader accepted fabricated resolution evidence | journey `resolved` must match its stop's `at`; runtime `resolved` must match an authored `roots` pattern |

The revalidation fix carries a controlled browser result. Against a seeded orchestrate plan card, the `proposals.findByOrchestrateRevision` poll was confirmed live at 3002/2998/3001 ms, and the architecture strip held a single state with zero transitions across 51s (~17 poll cycles). Reverting the fix in place reproduced the defect immediately — six transitions in 8s, flipping to "Checking linked architecture analysis." at 1947 / 4942 / 7943 ms — and restoring it returned the strip to zero DOM mutations over a further 35s. The server log had zero errors for the run.

### Group I lifecycle reconciliation (2026-08-08)

The broader remediation review found two final maintained-contract gaps:

| Issue | Resolution |
|---|---|
| F14: maintained integration documentation described only one thread generation/context and omitted standing-project and diff ownership, retention, tools, settings, and packaging | `docs/integrations/cartographer.md` now documents all four target families, their independent slots, replacement/TTL/restart behavior, proposal and diff retention, bounded orphan recovery with restart-durable context progress and corrupt-state fallback, the three architecture tools, automatic-analysis policy, exact packed-consumer gate, and desktop limitation/recovery. |
| F15: the P2 plan required workspace loss to drop Architecture, but the live right-panel store retained it | `reconcileFileSurfaces(ref, false)` now drops Atlas with Files, individual file, and Explorer surfaces. The transition regression proves a surviving Plan panel becomes active and that workspace restoration does not resurrect Atlas. |

This reconciliation does not rewrite the phase-by-phase sourcing and execution record. It promotes
the implemented lifecycle contract near the top of this tracked plan and keeps the original design,
deviations, gate evidence, and remaining acceptance limits below as provenance.

Focused Group I validation: `rightPanelStore.test.ts` passed 32/32 tests. Exact-file lint,
JavaScript/TypeScript comment checks, Prettier, Cartographer-doc formatting, and `git diff --check`
passed. The web TypeScript check exited zero; it reported only 17 existing finite-number schema
suggestions outside the Group I files.

Remaining acceptance limits and follow-ups:

- The packaged-desktop restart pass remains manual-only.
- Live provider Plan/Orchestrate architecture-tool rows and an ordinary-turn auto-reactor flow are still not driven end to end; focused provider/toolkit/reactor suites cover their contracts and routing. The 2026-08-08 attempt was blocked on provider quota (Codex rate-limited, Claude weekly budget largely spent), not on a code or environment defect. **This phase's client verification is therefore incomplete for those two flows.**
- Secondary remote and secondary WSL Atlas iframe navigation, DPoP saved-environment iframe
  navigation, and production-browser secondary-environment probe origins remain deferred; the
  authenticated probe works on the accepted primary-desktop/dev origins, including a WSL-only
  primary.
- U-171/U-168, the 17-event parity ledger, cross-provider Plan instruction delivery, and the consumed-state Architecture cue remain follow-ups.
- The real-repository P3 cost measurement and full `vp check` remain CI/manual gates. Server full-package typecheck remains baseline-red at the previously measured 169 existing diagnostics; no P5-added line/path diagnostic remained after the core build.

### Performance closeout (2026-08-08)

M1-M5 remain measurement candidates, not confirmed optimization findings. The final runtime-control
manifest is `0a72055800033417eb1ddf10f94b806541c551b11a6bc2b1bb40c931cc2a72fe`;
the M1/M3, M2/M5, and M4 harnesses passed bounded lifecycle, identity, cleanup, synthetic, and
independent source review. Real M2/M5 execution never produced an admissible cell: one attempt was
discarded in host preflight, one stopped at monitor construction before measurement, and one wrote
17 raw samples but failed wrapper cleanup before validation. The user requested wrap-up before a
further retry. No threshold was evaluated, no candidate was promoted, and no speculative
performance optimization was added.

## Risk & rollback matrix (running)

| Risk | Phase | Mitigation |
|---|---|---|
| headerPathStale/self-atlas poisoning on root/header mismatch | P0 | monorepo-root convention + zero-stale acceptance check |
| TS-source ./server export breaks worker spawn + config load | P0 | dist-based ./server export + dependsOn build order |
| CI positive-filter drift (new packages silently skip CI) | P0+ | workflow comment + review checklist |
| Engines floor advertised before compat proven | P0->P1 | keep >=24.10 until P1 lands compat + tests |
| Package-manager shim bypasses the MCP executable | release | dedicated `dist/mcp/bin.js` shim plus clean installed-package `initialize`/`tools/list` handshake |
| Link table FK to projection state cascades durable links on revert/bootstrap replay | P4 | no projection-side FK; explicit pruned-key link deletion; dangling lookup -> null |
| U-215 asserted with the stale mega-review order | P4 | corrected order snapshot/pairingLinkUpserted/clientUpserted/pairingLinkRemoved (live causal order, verifier-adjudicated) |
| Stream-filter change reintroduces the 8-test subscribe regression | P4 | predicate-only edit; full server.test.ts run; U-171/U-168 untouched |
| Auto-start loop on permanent generation failure | P4 | keyed failure tombstones, no LRU eviction, manual-retry-only after one attempt |
| Reconnect recovery re-runs worktree analysis on healthy contexts | P4 | connection generation in guard key only; typed-404-gated single reopen |
| Architecture tools trigger compute on model whim | P5 | tools query analyzed artifacts only; typed context-not-ready + recovery enum; propose_patch capped at 3M work units |
| Auto-compute backfills history or storms retries on enable | P5 | reactor seeds at current snapshot sequence; execution-time setting gate; claimed-then-settle supersession; P3 cache/semaphore is the cost floor |
| propose_patch renders as file_change on Claude/OpenCode | P5 | reorder 'mcp' classifier check before 'patch' (one line per adapter) |
| Silent P1/P2/P3 API drift from P5 needs | P5 | amendments made explicit: P1 read-lease/source-kind/path accessors, P2 last-good accessor, P3 target-identity read RPC |

## Appendix A — P0 import provenance (gate-required, self-contained)

Source: cartographer @ `887eb8b64b3e57ea72ee15af5b2601921f7c6b53`. Aggregate digests (reproducible; commands in the p0-scout record): included-set `f9fbf6a284a3b268c2ba5d3101b7b8c5070bdd9787135d6bf880c2a706e3d698`, whole-snapshot `62f8d83ba54f045617c52a82e155e134c03381d0f5afd1bd92690ad3fa4cbdd9`. Snapshot inventory: 362 files, 308 imported after drops (310 tracked incl. the two lead-retained icon assets).

### 58-path dirty manifest (git status --porcelain at import time)

```
 M .github/workflows/standalone-distribution.yml
 M AGENTS.md
 M README.md
 M src/analyze/diff.ts
 M src/analyze/graph.ts
 M src/analyze/journeyHops.ts
 M src/cli/commands/serve.ts
 M src/cli/index.ts
 M src/cli/lib/args.ts
 M src/cli/lib/staticServer.ts
 M src/cli/lib/usage.ts
 M src/emit/architectureMarkdown.ts
 M src/emit/pr-summary.ts
 M src/store/atlasHttp/httpUtil.ts
 M src/store/atlasHttp/router.ts
 M src/store/atlasIndex/persist.ts
 M src/store/graphJson.ts
 M src/store/snapshots.ts
 M src/types.ts
 M src/web/app/Atlas.tsx
 M src/web/app/AtlasApp.tsx
 M src/web/app/CanvasRegion.tsx
 M src/web/app/main.tsx
 M src/web/features/analysis/lib/journeysData.ts
 M src/web/features/analysis/ui/AnalysisWorkspace.tsx
 M src/web/features/analysis/ui/ChangesView.tsx
 M src/web/features/analysis/ui/JourneyView.tsx
 M src/web/features/analysis/ui/ProposalEditor.tsx
 M src/web/features/bootstrap/hooks/useAtlasIndex.ts
 M src/web/features/bootstrap/hooks/useAtlasQuery.ts
 M src/web/features/canvas/hooks/useArrangeShortcuts.ts
 M src/web/features/canvas/hooks/useCanvasNodeDrag.ts
 M src/web/features/changes/hooks/useChangesData.ts
 M src/web/features/changes/hooks/useProposalDraft.ts
 M src/web/features/changes/hooks/useProposalsData.ts
 M src/web/features/chrome/ui/Breadcrumb.tsx
 M src/web/features/inspector/lib/useFileSource.ts
 M src/web/shared/hooks/useGraphJson.ts
 M src/web/shared/hooks/useProjects.ts
 M src/web/shared/hooks/useUrlNavigation.ts
 M src/web/shared/lib/graphJson.ts
 M src/web/shared/lib/graphSignals.ts
 M src/web/shared/lib/urlNavigation.ts
 M src/web/shared/state/useAtlasViewStore.ts
 M src/web/shared/state/useCanvasNudgeStore.ts
 M src/web/shared/state/useUiPrefsStore.ts
 M templates/architecture-check.yml
 M tests/latestGeneration.test.ts
 M vite.config.ts
?? src/cli/commands/analyzeTrees.ts
?? src/cli/commands/embedServer.ts
?? src/web/app/atlasEmbedLifecycle.ts
?? src/web/shared/lib/embedBridge.ts
?? src/web/shared/lib/runtimeConfig.ts
?? tests/analyzeTrees.test.ts
?? tests/atlasEmbedLifecycle.test.ts
?? tests/embedReadOnly.test.ts
?? tests/embedServer.test.ts
```

55/58 included in the import (48 src, 5 tests, 1 templates, 1 vite.config.ts); 3 dropped (.github/workflows/standalone-distribution.yml, AGENTS.md, README.md).

### Full drop ledger (top-level verdicts)

IMPORT: src (split: web -> apps/atlas/src, rest -> packages/cartographer-core/src), tests -> packages/cartographer-core/tests (relocated to root tests/ mirror in commit 5), scripts/{standaloneAcceptance,proposalConcurrencyAcceptance,patchPerformanceAcceptance}.mjs -> core scripts/, scripts/gen-material-icons.mjs -> apps/atlas/scripts/, templates/architecture-check.yml -> core templates/, LICENSE + package.json + tsconfig.json + vitest.config.ts -> core root (references; rewritten in commit 4), vite.config.ts -> apps/atlas (reference; rewritten).
DROP: .git, node_modules, dist, .cartographer state, .agents (external symlink + skill), .claude, .claude-plugin (standalone plugin metadata), .codex, .github, .gitignore, .mcp.json, AGENTS.md, CLAUDE.md, README.md, dev-docs (26 files), eslint.config.mjs, package-lock.json, packages/ (empty mdx-forge), scripts/dev.mjs, tooling (9 files).
LEAD OVERRIDE: src/web/shared/assets/materialIcons.ts + MATERIAL_ICON_THEME_LICENSE imported despite the scout's generated-output drop verdict — the SPA imports the tables at runtime (gate-verifier confirmed sound).

### P0 gate-fix records (verifier f7cd5327 adjudications)

- `.claude-plugin/` CREATE is AMENDED TO DEFERRED: cartographer's plugin metadata references `.agents/` skills that were dropped (external symlink, machine-local); creating metadata for absent skills would be broken. Revisit if/when the skills are brought into the monorepo.
- Test inventory corrected: actual split is 20 atlas / 4 core (not 21/3); vi.* APIs appear in canvasNudgeStore, analyzeTrees (vi.spyOn), latestGeneration (module reset/mock) — all pre-existing, no assertion changes.
- Actual execution was 7 commits (the planned 6 + a separate namespace-conformance sweep; relocation and style merged into commit 5) — recorded, content verified mechanical by the gate's three-point audit.
- Baseline exceptions: 8 `no-manual-effect-runtime-in-tests` errors (tests/apps/server, pre-existing on main, untouched) and the `comments:native` packages-arg failure (pre-existing on main) are recorded as base-line failures, not P0 regressions. Atlas tsconfig uses ESNext without composite (deviation from the plan's Preserve/composite wording; gate-adjudicated sound).

## Document control

Created 2026-08-06 by orchestrate run carto-phase-plan-k4w9 (lead: Claude Fable session; workers: gpt-5.6-luna sourcing, gpt-5.6-sol drafting, claude-fable-5 verification). The six-phase implementation plan completed locally on 2026-08-07; F1-F21 review remediation completed on 2026-08-08; the reconciled stack was committed into `fix/session-postmortem` through `756068c1e` on 2026-08-08. Performance measurement remains an explicit manual gate as recorded above. Worker evidence persists under ~/.local/state/worker-broker/jobs/. Execution order: P0 -> P1 -> {P2, P3, P4(A/B partial after P1; C full acceptance and D after P2+P3)} -> P5.
