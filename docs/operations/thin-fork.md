# 456code thin fork: ownership and update record

This replacement is T3 Code plus personal appearance, desktop isolation, Coral, and Cartographer. It lives on `codex/t3-thin-fork`. Main, the installed application, old databases, and the reconciliation, Cartographer-review and selective-port worktrees were not replaced or migrated.

## Base and local change groups

- Starting upstream base: `e816064945144957b6eb9b268912a98b0555644b`.
- Rehearsed/final upstream base: `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`.
- Recovery branch: `codex/backup-t3-thin-fork-before-rehearsal` retains the exact pre-rebase implementation.
- Keep separate commits for desktop isolation, appearance, Coral, the engine, and application integration. Follow-up fixes belong to their corresponding concern.

The runtime patch inventory below contains **56 modified upstream paths**. In addition, 100 files are locally owned extension modules/assets/tests (before this document). This is still a substantial engine/provider port, but upstream conversation orchestration, ProviderService, persistence/migrations, Git implementations, shared client runtime and every `apps/mobile` file are unchanged. Tests stay in upstream locations. Root formatting, package names, Effect, TypeScript and Vite+ versions remain upstream-owned.

## Product and ownership boundaries

**Appearance:** `assets/fincke`, web `src/fincke`, and desktop `src/fincke/FreshProfile.ts`. Fincke Ocean is an imported environment theme with ID `fincke-ocean`; it does not replace T3's built-in Ocean. Only a profile with neither settings nor a conversation database is seeded. Later starts respect its existing selection. The icon and wave use T3's standard asset/backdrop entry points. Setup and other upstream product copy remains T3-owned.

**Desktop:** explicit build identity `com.ggfincke.456code.thin`, profile `456code-thin`, default backend home `~/.456code-thin`, protocol `code456-thin` (development variants append `-dev`). An explicit `T3CODE_HOME` is treated as a parent and receives a `456code-thin` suffix; the original environment value is removed from the backend child so it cannot override that bootstrap identity. Native and server self-updates are disabled; publication metadata is private and artifact publishing is null. Hosted release/deploy workflows are upstream-repository gated. No signing, release destination or deployment was configured.

**Coral:** one driver, adapter, settings/probe module, text-generation adapter and ACP support module under existing provider/text-generation directories. Coral uses supervised text turns, native approvals, cancellation, model changes and `session/resume`. Attachments, rollback, provider replacement/import, and app-MCP access are not advertised. The only shared ACP behavior patch is optional authentication when no auth method is advertised. Other drivers retain their existing authentication path.

Coral requires an executable that implements `coral acp`. The regular local Coral 0.15.0 installation did not include that command during verification. The existing `coral-456code-integration` worktree's built CLI was verified with local Ollama; neither that worktree nor the installed launcher was changed. Configure that compatible executable and a fresh `CORAL_HOME` in T3's **Add provider instance** dialog. Probes do not create sessions. Model inventory is discovered from native session setup; the initial default is `qwen3.8:27b-mlx`.

**Engine:** `packages/cartographer-core` is private. It exposes only immutable snapshots and its analysis worker. Resolver/export/alias/coverage fixes and graph-navigation support were selected from the Cartographer review; old proposal modules, standalone MCP/CLI entry points and proposal acceptance scripts were removed. Private analyzer support and its major resolver tests remain. Dependency-cruiser needs its own TypeScript 6 runtime API; this does not replace T3's root TypeScript 7 toolchain.

**Integration:** server `src/cartographer`, `src/mcp/toolkits/cartographer`, web `src/cartographer`, and `packages/contracts/src/cartographer.ts`. Four namespaced RPCs and two bounded read-only MCP tools use upstream session authorization. Agent requests use the credential's task, cannot request another task, never start analysis and return a clear preparation action when missing. No new conversation events, migrations, turn reactors or plugin framework exist.

Analysis captures the selected task's actual worktree, resolves comparison commit identities first, and checks the displayed diff hash/root before and after analysis. Source reads come exclusively from the captured base/target. Failed refreshes leave the previous complete capture accessible. Returning to the app checks freshness; explicit Refresh rebuilds. Existing results retain their capture identity and visible stale state.

The extension cache is `userdata/cartographer` beneath that backend home. Work is limited to 8,000 source/config files, 2 MiB/file, 64 MiB/capture, two concurrent analyses and a 90-second worker deadline. Responses cap graph, edge, dependency and source sizes. Captured source is project data. Generations remain for immutable navigation; the cache is rebuildable and may be removed while the app is stopped. There is no periodic analysis or automatic turn-completion analysis.

## Verification record

Focused checks passed on the rehearsed base:

- 70 server tests: real child ACP fixture (multi-turn, approval, cancellation, model change, restart/resume, auth compatibility, no-session probes, attachment rejection), upstream ACP support, MCP access, RPC authorization and update rejection.
- 31 engine tests: resolver/export/alias/coverage truth, repeat-dirty fingerprints, actual comparisons, task/root isolation, immutable source, bounded output and failed-refresh preservation.
- 67 upstream theme/boot/artwork tests. 43 focused desktop tests passed after replay, including identity, fresh-profile preservation, protocol and backend configuration. Packaging identity tests also passed.
- Server, web, desktop and scripts package type checks; engine compilation; targeted formatting/lint and desktop build (including engine, server/worker, web and Electron). Existing lint warnings remain; no lint errors. Frozen installation passed without upgrading existing upstream resolutions. Full-workspace tests were deliberately left to CI; nothing was pushed, so hosted CI has not run.

Live verification used disposable backend homes and a tiny Git fixture, without importing old sessions:

- A normal Codex task returned `THIN_FORK_OK`. The actual Coral ACP build returned `CORAL_THIN_OK`; after backend restart it retained that response and returned `RESUME_OK`.
- Fincke Ocean remained selected through reloads. Personal icon/name and wave rendered in the stock sidebar.
- Map -> incoming import evidence -> captured source -> back retained navigation. Editing an already-dirty file a second time marked the cached map stale again. Refresh produced a new content identity.
- Switching to a T3-created worktree produced a separate, correctly rooted map. Actual Diff Impact matched the displayed one-line Git change; base source was `value = 1` and captured target was `value = 42`.
- Desktop boot reached the fresh setup screen on `code456-thin://app/` with a connected local backend. Open-file/process inspection confirmed the isolated Electron profile and database. Startup, shutdown and a second start were exercised; owned verification processes were stopped.

Two bugs found during desktop verification were fixed: asynchronous theme seeding before Electron protocol registration, and an inherited backend home overriding the isolated bootstrap path. Exact personal renderer origins were added to the existing HTTP policy.

**Observed upstream limit:** in standalone development, T3's ReviewService only permits its configured workspace root and managed worktrees. Its diff UI can fall back to the server working directory for an outside project. Cartographer refuses that mismatched comparison rather than analyzing another repository. The positive diff check used a T3-managed worktree. No local Git-service fork was added.

## Six-commit update rehearsal

Replayed the seven concern-separated local commits over these exact upstream changes:

1. `4a4c6dd2a` open-source license notices.
2. `ca6416ec2` reduced repeated sorting/date formatting.
3. `4fed6cfb3` inline file previews and attachment chips.
4. `57b23a09f` offscreen SnapShot text preservation.
5. `b1e223e2b` pull-request loading without workspace scans.
6. `d1d15c67f` sidebar project scope in the search row.

**Zero textual conflicts, zero rebase-resolution edits.** `git range-diff` marked all seven replayed patches equal. Final compatibility review then disabled Coral's unsupported Auto permission choice in the existing compact menu; this was a missed local restriction, not a change introduced by these six commits. The packaging type check also moved personal identity constants into the existing scripts/lib boundary shared by both TypeScript projects, avoiding an out-of-project source import. No additional upstream integration point was needed. This rehearsal is evidence for this update only, not a guarantee about future rebases.

Preservation receipts matched old HEADs, staged/unstaged diffs and all recorded dirty/untracked bytes: main 25 files, Cartographer review 89, selective port 24, reconciliation 83,786. The initial reconciliation status discrepancy was only collapsed versus expanded untracked-directory output. `apps/mobile` has no diff against the final upstream base.

## Routine future update

1. Record the current upstream SHA and local HEAD. Preserve dirty state and create a backup branch before rewriting this replacement stack.
2. Fetch upstream into an explicit ref, inspect the new range, and replay only the thin-fork commits. Do not merge the old fork or its selective-port batch.
3. Keep upstream changes in orchestration, provider lifecycle, persistence, mobile, Git, tooling and layout. Adapt the named extension modules or their narrow registration points instead.
4. Review every path from `git diff --name-status <new-upstream> HEAD`. Update this inventory for any modified upstream file; do not count locally owned extension files as upstream patches.
5. Run the affected package's colocated tests, package type checks and targeted formatting/lint/builds. Recheck real Coral resume, theme persistence, actual worktree scope and displayed-diff identity when the relevant seams change. Use one isolated app environment; stop it afterward.
6. Keep main cutover, release publication, signing, installed-app replacement and deletion of recovery work as explicit separate decisions.

For an isolated web development session, run `vp run dev --home-dir /absolute/path/to/new-state`. For the desktop, run its existing start command with `T3CODE_HOME` pointing to a disposable parent; the personal build adds its suffix. Never point a standalone server at the old app's database.

## Modified upstream files

| Path                                                           | Group                            | Why this patch is necessary                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/deploy-relay.yml`                           | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/desktop-macos-preview.yml`                  | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/mobile-eas-preview.yml`                     | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/mobile-eas-production.yml`                  | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/publish-aur.yml`                            | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/release.yml`                                | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/web-preview.yml`                            | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `apps/desktop/scripts/electron-launcher.mjs`                   | Desktop isolation                | Separate local app bundle identity and protocol registration; preserves the old installed app.                                                 |
| `apps/desktop/src/app/DesktopAssets.ts`                        | Appearance                       | Resolve the personal icon through the existing asset entry point.                                                                              |
| `apps/desktop/src/app/DesktopEarlyElectronStartup.ts`          | Desktop isolation                | Use the same isolated early-start settings path and Linux identity as the runtime.                                                             |
| `apps/desktop/src/app/DesktopEnvironment.ts`                   | Desktop isolation                | Resolve personal display name, profile and identity behind the build flag; no legacy profile migration.                                        |
| `apps/desktop/src/app/DesktopStatePaths.ts`                    | Desktop isolation                | Use .456code-thin, or append 456code-thin to an explicit T3CODE_HOME.                                                                          |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts`      | Desktop isolation                | Clear inherited T3CODE_HOME for the personal backend child so the isolated bootstrap home wins.                                                |
| `apps/desktop/src/electron/ElectronProtocol.ts`                | Desktop isolation                | Register code456-thin/code456-thin-dev and use that exact scheme in the renderer policy.                                                       |
| `apps/desktop/src/main.ts`                                     | Appearance / isolation           | Seed the preset after Clerk protocol registration and before starting the application.                                                         |
| `apps/desktop/src/updates/DesktopUpdates.ts`                   | Desktop isolation                | Disable native automatic updates for the personal build.                                                                                       |
| `apps/desktop/vite.config.ts`                                  | Desktop isolation                | Define the personal build flag only in the desktop build.                                                                                      |
| `apps/server/package.json`                                     | Cartographer / isolation         | Add the isolated engine and external scanner; move dev to a task with an engine build prerequisite; mark publication private.                  |
| `apps/server/scripts/acp-mock-agent.ts`                        | Coral verification               | Add an opt-in real child-process Coral fixture profile; preserve existing fixture behavior.                                                    |
| `apps/server/scripts/cli.ts`                                   | Desktop isolation                | Preserve private:true when assembling npm publication metadata.                                                                                |
| `apps/server/src/auth/RpcAuthorization.ts`                     | Cartographer                     | Assign the four namespaced methods to existing read/operate authorization scopes.                                                              |
| `apps/server/src/environment/ServerEnvironment.ts`             | Cartographer                     | Advertise the optional map/impact availability capability.                                                                                     |
| `apps/server/src/http.ts`                                      | Desktop isolation                | Accept the two exact personal renderer origins using existing authenticated HTTP/CORS handling.                                                |
| `apps/server/src/mcp/McpHttpServer.ts`                         | Cartographer                     | Register the read-only toolkit alongside upstream app MCP tools.                                                                               |
| `apps/server/src/mcp/McpInvocationContext.ts`                  | Cartographer                     | Name the Cartographer credential capability.                                                                                                   |
| `apps/server/src/mcp/McpSessionRegistry.ts`                    | Cartographer                     | Grant the capability to existing app-MCP sessions; default test options remain unchanged.                                                      |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts`            | Coral                            | Permit omitted authentication only for an empty advertised auth-method list; otherwise fail before session creation.                           |
| `apps/server/src/provider/builtInDrivers.ts`                   | Coral                            | Register one driver through the upstream driver registry.                                                                                      |
| `apps/server/src/server.ts`                                    | Cartographer / isolation         | Provide the extension service and replacement update policy at the composition root.                                                           |
| `apps/server/src/ws.ts`                                        | Cartographer                     | Wire namespaced RPC handlers through the existing authenticated RPC path.                                                                      |
| `apps/server/vite.config.ts`                                   | Cartographer                     | Build the analysis worker and require engine compilation before server dev/build.                                                              |
| `apps/web/public/apple-touch-icon.png`                         | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                                    |
| `apps/web/public/favicon-16x16.png`                            | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                                    |
| `apps/web/public/favicon-32x32.png`                            | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                                    |
| `apps/web/public/favicon.ico`                                  | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                                    |
| `apps/web/src/branding.ts`                                     | Appearance                       | Set the personal display-name constants.                                                                                                       |
| `apps/web/src/components/ChatView.tsx`                         | Cartographer                     | Mount lazy map/impact panels and expose Map only for capable environments and Git-backed tasks.                                                |
| `apps/web/src/components/DiffPanel.tsx`                        | Cartographer                     | Send the displayed comparison identities, cwd and diff hash to Analyze Impact.                                                                 |
| `apps/web/src/components/RightPanelTabs.tsx`                   | Cartographer                     | Add Map/Impact descriptors and a Map launcher to upstream panel controls.                                                                      |
| `apps/web/src/components/SidebarStageBackdrop.tsx`             | Appearance                       | Add Fincke wave artwork through the existing backdrop hook.                                                                                    |
| `apps/web/src/components/chat/ChatComposer.tsx`                | Coral                            | Reject attachments consistently and show only Coral-supported permission modes.                                                                |
| `apps/web/src/components/chat/CompactComposerControlsMenu.tsx` | Coral                            | Disable unsupported permission options in compact controls.                                                                                    |
| `apps/web/src/components/chat/providerIconUtils.ts`            | Coral                            | Resolve the Coral icon through upstream provider presentation.                                                                                 |
| `apps/web/src/components/settings/providerDriverMeta.ts`       | Coral                            | Expose the driver in the standard Add provider instance flow.                                                                                  |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`            | Appearance                       | Use the existing header branding/artwork entry point; retain the upstream sidebar layout.                                                      |
| `apps/web/src/rightPanelStore.ts`                              | Cartographer                     | Add two singleton panel kinds to upstream panel state.                                                                                         |
| `apps/web/src/themePalette.ts`                                 | Appearance                       | Recognize the personal artwork identifier while preserving T3 theme storage and rendering.                                                     |
| `packages/contracts/src/environment.ts`                        | Cartographer                     | Add an optional availability capability for version-skew tolerance.                                                                            |
| `packages/contracts/src/index.ts`                              | Cartographer                     | Export the new schema-only contract module.                                                                                                    |
| `packages/contracts/src/model.ts`                              | Coral                            | Supply the initial default model slug; native session inventory supplies available models.                                                     |
| `packages/contracts/src/rpc.ts`                                | Cartographer                     | Include four namespaced RPC schemas in the existing group.                                                                                     |
| `packages/contracts/src/settings.ts`                           | Coral                            | Describe executable, Ollama endpoint and per-instance home settings using upstream form schemas.                                               |
| `pnpm-lock.yaml`                                               | Cartographer engine              | Lock only extension dependencies/importers; retain existing upstream resolutions.                                                              |
| `pnpm-workspace.yaml`                                          | Cartographer engine              | Scope TypeScript 6 to dependency-cruiser 18.2.0, whose parser loader cannot use the root TypeScript 7 compiler API.                            |
| `scripts/build-desktop-artifact.ts`                            | Desktop isolation / Cartographer | Use personal artifact identity, icons and publish:null; preserve scanner runtime dependencies in staged artifacts.                             |
| `scripts/lib/cli-external-packages.ts`                         | Cartographer                     | Keep dependency-cruiser external so its dynamic parser loading works in the packaged worker.                                                   |
