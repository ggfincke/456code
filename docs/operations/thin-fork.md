# 456code thin fork: ownership and update record

This replacement is T3 Code plus personal appearance, desktop isolation, Coral, and Cartographer. Its rebase stack lives on `codex/t3-thin-fork`; PR #111 installs that tree on remote main through the reviewed replacement merge described below. The dirty local main checkout, installed application, old databases, and reconciliation, Cartographer-review and selective-port worktrees remain preserved.

## Base and local change groups

- Starting upstream base: `e816064945144957b6eb9b268912a98b0555644b`.
- First rehearsed upstream base: `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`.
- Previous upstream base: `9375c779707fb95c06670db6da87441720b2d2e2` (83 further commits).
- Current upstream base: `5ea6439816470288d3f2b6b43635fea41fbbb101` (26 additional commits from September 14).
- Previous recovery branch: `codex/backup-thin-fork-before-9375c779` at `2f634894544b4ccb02638d60e2b6d624e3617975`.
- Current recovery branch: `codex/backup-thin-fork-before-6dbea7ed` at `158ba6655cf62df4c16e2428af06adc78f63bdcf`; it preserves the published stack before this update.
- Intermediate recovery refs: `codex/backup-thin-fork-before-5ea64398` and `codex/backup-thin-fork-before-coauthors-20260914`.
- Initial recovery branch: `codex/backup-t3-thin-fork-before-rehearsal` retains the exact pre-rebase implementation.
- Keep separate commits for desktop isolation, appearance, Coral, the engine, and application integration. Follow-up fixes belong to their corresponding concern.

The patch inventory below contains **62 modified upstream paths**, including the PR size workflow fix. In addition, 101 files are locally owned extension modules/assets/tests (excluding operations documents). This is still a substantial engine/provider port, but upstream conversation orchestration, ProviderService, persistence/migrations, Git implementations, shared client runtime and every `apps/mobile` file are unchanged. Tests stay in upstream locations. Root formatting, package names, Effect, TypeScript and Vite+ versions remain upstream-owned.

## Product and ownership boundaries

**Appearance:** `assets/fincke`, web `src/fincke`, and desktop `src/fincke/FreshProfile.ts`. Fincke Ocean is an imported environment theme with ID `fincke-ocean`; it does not replace T3's built-in Ocean. Only a profile with neither settings nor a conversation database is seeded. Later starts respect its existing selection. The icon and wave use T3's standard asset/backdrop entry points. Setup and other upstream product copy remains T3-owned.

**Desktop:** explicit build identity `com.ggfincke.456code.thin`, profile `456code-thin`, default backend home `~/.456code-thin`, protocol `code456-thin` (development variants append `-dev`). An explicit `T3CODE_HOME` is treated as a parent and receives a `456code-thin` suffix; the original environment value is removed from the backend child so it cannot override that bootstrap identity. Native and server self-updates are disabled; publication metadata is private and artifact publishing is null. Hosted release/deploy workflows are upstream-repository gated. No signing, release destination or deployment was configured.

**Coral:** one driver, adapter, settings/probe module, text-generation adapter and ACP support module under existing provider/text-generation directories. Coral uses supervised text turns, native approvals, cancellation, model changes and `session/resume`. Attachments, rollback, provider replacement/import, and app-MCP access are not advertised. The only shared ACP behavior patch is optional authentication when no auth method is advertised. Other drivers retain their existing authentication path.

Coral now runs from the current-main ACP finish worktree through the repaired normal launcher. A four-second initialization-only probe checks protocol compatibility, native resume and authentication requirements, then closes its process without creating or resuming a session. A separate four-second, 1 MiB metadata-only Ollama request populates the initial picker with exact model names (up to 512 entries). Transient failures retain the last known inventory; an empty server reports an error and clears it. Native setup can also update that inventory. See [Coral local setup and validation](coral-setup.md) for the exact build, isolated homes and launcher recovery.

**Engine:** `packages/cartographer-core` is private. It exposes only immutable snapshots and its analysis worker. Resolver/export/alias/coverage fixes and graph-navigation support were selected from the Cartographer review; old proposal modules, standalone MCP/CLI entry points and proposal acceptance scripts were removed. Private analyzer support and its major resolver tests remain. Dependency-cruiser needs its own TypeScript 6 runtime API; this does not replace T3's root TypeScript 7 toolchain.

**Integration:** server `src/cartographer`, `src/mcp/toolkits/cartographer`, web `src/cartographer`, and `packages/contracts/src/cartographer.ts`. Four namespaced RPCs and two bounded read-only MCP tools use upstream session authorization. Agent requests use the credential's task, cannot request another task, never start analysis and return a clear preparation action when missing. No new conversation events, migrations, turn reactors or plugin framework exist.

Analysis captures the selected task's actual worktree, resolves comparison commit identities first, and checks the displayed diff hash/root before and after analysis. Source reads come exclusively from the captured base/target. Failed refreshes leave the previous complete capture accessible. Returning to the app checks freshness; explicit Refresh rebuilds. Existing results retain their capture identity and visible stale state.

The extension cache is `userdata/cartographer` beneath that backend home. Work is limited to 8,000 source/config files, 2 MiB/file, 64 MiB/capture, two concurrent analyses and a 90-second worker deadline. Responses cap graph, edge, dependency and source sizes. Captured source is project data. Generations remain for immutable navigation; the cache is rebuildable and may be removed while the app is stopped. There is no periodic analysis or automatic turn-completion analysis.

## Verification record

Focused checks passed on the rehearsed base:

- 70 server tests: real child ACP fixture (multi-turn, approval, cancellation, model change, restart/resume, auth compatibility, no-session probes, attachment rejection), upstream ACP support, MCP access, RPC authorization and update rejection.
- 31 engine tests: resolver/export/alias/coverage truth, repeat-dirty fingerprints, actual comparisons, task/root isolation, immutable source, bounded output and failed-refresh preservation.
- 67 upstream theme/boot/artwork tests. 43 focused desktop tests passed after replay, including identity, fresh-profile preservation, protocol and backend configuration. Packaging identity tests also passed.
- Server, web, desktop and scripts package type checks; engine compilation; targeted formatting/lint and desktop build (including engine, server/worker, web and Electron). Existing lint warnings remain; no lint errors. Frozen installation passed without upgrading existing upstream resolutions. Full-workspace tests were deliberately left to CI. This paragraph records the original local rehearsal; publication and the later rebase are recorded below.

Live verification used disposable backend homes and a tiny Git fixture, without importing old sessions:

- A normal Codex task returned `THIN_FORK_OK`. The actual Coral ACP build returned `CORAL_THIN_OK`; after backend restart it retained that response and returned `RESUME_OK`.
- Fincke Ocean remained selected through reloads. Personal icon/name and wave rendered in the stock sidebar.
- Map -> incoming import evidence -> captured source -> back retained navigation. Editing an already-dirty file a second time marked the cached map stale again. Refresh produced a new content identity.
- Switching to a T3-created worktree produced a separate, correctly rooted map. Actual Diff Impact matched the displayed one-line Git change; base source was `value = 1` and captured target was `value = 42`.
- Desktop boot reached the fresh setup screen on `code456-thin://app/` with a connected local backend. Open-file/process inspection confirmed the isolated Electron profile and database. Startup, shutdown and a second start were exercised; owned verification processes were stopped.

Two bugs found during desktop verification were fixed: asynchronous theme seeding before Electron protocol registration, and an inherited backend home overriding the isolated bootstrap path. Exact personal renderer origins were added to the existing HTTP policy.

**Observed upstream limit:** in standalone development, T3's ReviewService only permits its configured workspace root and managed worktrees. Its diff UI can fall back to the server working directory for an outside project. Cartographer refuses that mismatched comparison rather than analyzing another repository. The positive diff check used a T3-managed worktree. No local Git-service fork was added.

## Coral finishing pass (2026-09-12)

The runtime finishing changes stay in the locally owned `CoralProvider.ts` and
`CoralDriver.ts` modules. `CoralProvider.test.ts` adds compatibility, timeout,
child cleanup and metadata-only discovery regressions; `CoralAdapter.test.ts`
retains its five child-process lifecycle tests and drops the obsolete
version-only check. No new modified upstream runtime path is introduced.

Coral itself is selectively adapted onto current main in its own worktree;
the normal launcher now points directly to that verified Node 24 build. Native
snapshots and exclusive leases replace the earlier branch's extra ledger.
Current TUI and session improvements remain intact. See the
[setup record](coral-setup.md) for acceptance results and exact provenance.

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

## Rebase onto 9375c779 (2026-09-14)

The 11 local commits were replayed from `d1d15c67f4` onto the pinned upstream
`9375c779707fb95c06670db6da87441720b2d2e2`, incorporating all 83 commits in that
range. This is a pinned update, not a claim that upstream has stopped moving.
Eight patches replayed unchanged; three needed contextual or compatibility
resolutions. The backup above preserves the complete published pre-rebase stack.

Textual conflicts occurred in eight paths: desktop ElectronProtocol and
DesktopBackendConfiguration; server package.json, scripts/cli.ts, server.ts and
vite.config.ts; contracts/index.ts; and build-desktop-artifact.ts. Imports and
registrations were combined. Upstream executable/archive packaging, hoisted
Windows sidecars, Node paths and native preview serving were retained.

Follow-up adaptations remove the duplicated server dev script, keep the scanner
external through the server bundler and desktop staging hooks, and restore
`scripts/lib/cli-external-packages.ts` exactly to upstream. The new CLI update
entry point and npm archive publisher reject before downloads, service changes
or publication. No provider-service, orchestration, migration, mobile or shared
client-runtime patches were added.

**Optional archive limit:** standalone CLI executables do not include the separate
Cartographer worker. Their optional analysis capability is false and direct
analysis requests return an explicit desktop/Node preparation action. Node server
and Electron analysis remain supported. CLI archive distribution, remote runtime
provisioning and fork release destinations remain unconfigured; archive/WSL
Cartographer support requires a separate packaging decision.

Validation on this base:

- Frozen dependency installation and the seven-task desktop build passed.
- 28 focused server tests passed, covering Coral fixtures/probes, ACP support,
  Cartographer MCP access, RPC authorization, environment identity and update rejection.
- 31 engine tests passed, including resolver/alias/export accuracy, immutable
  comparison capture, repeated dirty fingerprints and last-good refresh behavior.
- 46 desktop isolation/protocol/backend tests, 270 focused web theme/panel/chat
  tests and 89 packaging/external-dependency tests passed. Upstream tests were
  preserved; no tests were added or changed in this rebase.
- Server, web, desktop and scripts type checks passed, with existing Effect
  suggestions. Targeted formatting and lint passed.
- Direct `t3 update --yes` and publisher `--dry-run --packages-dir ...` calls
  rejected before side effects. The build still uses the separate personal
  profile, app ID, protocol and disabled updater.
- In the disposable web app, an ordinary Codex task returned `T3_REBASE_OK`.
  Coral used the normal launcher and exact metadata-discovered models, completed
  text turns, approved a write, declined a write without creating the file, and
  cancelled a streamed response. The model picker switched to `muse-glimmer:30b-mlx`;
  completion after that switch is not claimed.
- Repository Map showed the actual fixture root, two source files and one import.
  Dependency evidence -> captured source -> back worked. After changing a file
  from 1 to 2 and then 3, each edit marked the map stale; stale source retained 1
  and then 2 respectively until explicit refresh. Fincke Ocean was imported via
  the upstream theme command; branding and the wave rendered.

**Acceptance deferred at the user's battery request:** no more Coral inference
or model loads. Clean restart/resume without replay, completion after the model
switch, live worktree switching, actual Diff Impact, explicit theme-selection
persistence and native desktop startup/shutdown were not completed in this pass.
Earlier acceptance results above are historical evidence, not substitutes for
these checks on the new base. Title generation was configured to Coral, but its
new-base completion was not independently verified. The full workspace remains
CI-owned. Do not call the replacement fully acceptance-verified on this record.

Verification state is retained under `.t3/rebase-9375c779/`; its backend and web
processes are stopped, ports 14150/6110 are closed and the Coral lease table is
empty. Resuming this fixture must respect the user's no-local-model constraint:
disable the Coral instance and select another text-generation provider first,
or wait for explicit permission to resume model-based acceptance. Existing main
branches, other worktrees, old application data and installed applications were
not changed.

## September 14 follow-up: 26 more commits

The update now includes upstream `9375c779..5ea6439816470288d3f2b6b43635fea41fbbb101`.
The first 25 commits ended at `6dbea7ed`; the final worktree-setup commit landed
during verification and was included before publication. This brings in the
provider refresh/version fixes, background clones, composer shortcuts, custom
snoozing, async worktree setup, WSL fixes, release/archive changes, and unchanged
upstream mobile updates.

There was one textual conflict, in `desktop-macos-preview.yml`. Upstream split
preview building from trusted signing/publication. The resolution retains that
implementation and applies the existing upstream-repository guard to the new
publisher's eligibility and cleanup jobs. Its dependent build/publish jobs
cannot run when eligibility is skipped. No fork publication was enabled.

Range-diff accounted for all 14 existing patches: 11 replayed identically, two
had context-only changes (desktop observability and the upstream Clerk lockfile),
and the publication patch received the workflow adaptation. The final upstream
commit replayed the resulting 15-patch stack without conflicts or code changes.
The one added test commit changes only the two launcher icon expectations to
Fincke Ocean; upstream test coverage and locations remain intact. On request,
all local commits now include the Codex co-author trailer; every existing
co-author was preserved and the attribution-only rewrite has an identical tree.

Validation:

- Frozen installation and the seven-task desktop build passed at `6dbea7ed`;
  the desktop pipeline passed again after the final upstream commit.
- 279 focused server tests passed on the final base, including Coral child ACP
  fixtures/probes, authorization, provider snapshots, router composition,
  background clones and async/synchronous worktree setup. No Coral model ran.
- 395 web theme/panel/chat/model-picker/keybinding tests passed before the final
  commit; its affected chat/timeline/project-script suites then passed 267 tests.
- 94 desktop isolation/protocol/backend/WSL/release-note tests passed (13
  platform-specific cases skipped), plus 99 packaging/launcher/archive tests
  and 31 engine accuracy/capture/access/last-good tests.
- Server, web, desktop and scripts type checks passed. Server/web type checks
  were repeated after the final commit. Targeted formatting/lint passed.
- `apps/mobile`, orchestration, persistence, ProviderService, shared client
  runtime and native external-dependency classification still match upstream.
  The inventory has 58 modified upstream paths and 101 extension files.

Live checks reused `.t3/rebase-9375c779/`. Coral was disabled before startup and
text generation was set to Codex. On the 25-commit base, a normal Codex task
created a T3-managed worktree, changed the fixture from `value = 1` to `42`,
returned `WORKTREE_6DBEA7ED_OK`, and generated the title “Set Fixture Value To 42”.
Actual Diff Impact matched that displayed Git comparison and retained base `1`
and target `42`. Map -> dependency evidence -> captured import source -> back
worked. Edits `42 -> 43 -> 44` each marked the map stale; explicit refresh
produced a new capture of `43`. Switching between the original checkout and
managed worktree retained their distinct roots and capture identities.
Fincke Ocean was selected; switching to Grove survived reload, and Ocean was
restored afterward.

The built desktop reused that disposable database after the web server stopped.
A temporary bootstrap redirected only the Electron process's home-directory
lookup into the fixture, leaving the host HOME unchanged. A fixture-owned
`desktop-parent/456code-thin` link points to the same disposable backend home;
no live application data was linked. Process/open-file inspection confirmed the
isolated Electron profile, database and personal protocol. The existing Codex
task resumed and returned its previous marker plus `DESKTOP_RESUME_OK`.
Native shutdown completed cleanly, and the final-base build restarted against
the same isolated profile/database. Native mouse input was unavailable during
that last pass, so the built server's web client completed the remaining checks;
the ordinary task returned `FINAL_BASE_5EA64398_OK` after restart.

That built-client check exposed a packaging defect missed by development tests:
the bundled TypeScript parser read `__filename`/`__dirname` without ESM shims.
The Node/desktop pack mode now enables Vite+'s existing shims; standalone
executable mode remains unchanged. The desktop pipeline, 99 packaging tests,
server type check and targeted formatting/lint passed after this fix. The real
built worker then analyzed the displayed `1 -> 42` comparison successfully,
returning captured target `42` while the current worktree held `44`. This is a
packaged-runtime check, not only a source-module test. Direct built CLI update
and publisher dry-run calls rejected before side effects.

All owned verification processes are stopped; ports 3773, 6110 and 14150 are
closed and the Coral lease table is empty. The fixture remains available for
recovery with Coral disabled. No main branch, other worktree, old app data,
installed application or Coral repository was modified by this update.

### Final acceptance on September 14

The user renewed permission to run local models and requested the remaining
checks. The normal Coral launcher, native session runtime and repository were
unchanged. The built desktop backend used the existing disposable fixture:

- Muse resumed native session `f587eab5`, recalled `REBASE_CORAL_9375`, and
  returned `FINAL_RESUME_5EA64398_OK`. All 15 previous non-system messages were
  identical; only a new user/assistant pair was added.
- The model picker switched to `qwen3.8:27b-mlx`; its next turn completed with
  `FINAL_MODEL_SWITCH_OK` in that same session.
- A fresh Coral task completed and the tool-free title helper named it
  “Explain Git Worktrees”. Only that task created another native session.
- Clean desktop shutdown released all leases. After rebuilding and restarting,
  the original session returned `REBASE_CORAL_9375 CLEAN_RESTART_OK`. Its 20
  previous messages were preserved, except the rebuilt system prompt, and
  exactly one new user/assistant pair was appended; no replay occurred.
- An ordinary Codex task returned `FINAL_ORDINARY_TASK_OK` on the final build.
  The built client retained the actual captured Diff Impact after restart.

Full verification found and corrected four integration omissions: two hosted
branding assertions expected upstream names; Knip needed the worker/retained CLI
entry points and explicit external-parser/disabled-updater ownership; and the
release-smoke fixture omitted the Cartographer package manifest. Clean CI also
needed the compiled engine before server tests, so the existing Vite+ task graph
now builds it first. A cold-build check passed 214 server tests. Unused local
Coral exports and a dead canvas helper were removed. No upstream runtime or
mobile files were changed for these checks; existing tests were retained.

The seven-task desktop build, all 16 workspace type checks, full formatting/lint,
Knip and preload verification passed. The non-server package suites passed
11,413 tests (46 platform-specific skips), including all 4,978 web tests. Release,
preview-artifact and nightly checks passed. The complete local server suite
initially passed 4,666 tests and exposed 14 host-sensitive failures: 13 passed
when rerun using canonical `TMPDIR=/private/tmp` (219 tests across eight files).
The remaining upstream Codex text-generation fixture supplies an environment
without PATH and cannot find this host's mise-only Node executable. Its source
was retained unchanged and passed in Linux CI. All three hosted server shards
passed: 4,680 tests, with 10 platform-specific skips.

Hosted validation of application commit `2d4c8bcac8d45e8f46d377a0e4fdc8cb70e169b3`
runs on [`codex/validate-thin-fork-20260914`](https://github.com/ggfincke/456code/actions/runs/34917548400).
Its commit `94e1801d3169989c727f2bbba2f5e577ea3598df` differs only in the CI
workflow: a validation-branch push trigger, standard GitHub runners and longer
timeouts. It executes the existing checks without skipping assertions. The
replacement branch's upstream CI workflow is unchanged. Hosted result: passed.
All 16,138 package tests passed (11 platform-specific skips), along with the
build, type/lint/format checks, Rust and release smoke. Mobile native analysis
passed in the preceding run and was skipped in the final run because those
files were unchanged.

The test-owned desktop and Ollama processes were stopped and the fixture's
previous Coral-disabled settings restored. Native leases are empty and ports
3773, 6110 and 14150 have no listeners. The verification-owned Ollama server
exited; a later unrelated Ollama process was left untouched. During this verification pass, main branches, other worktrees,
old application data,
installed apps and the Coral repository remain untouched.

## Authorized remote-main replacement (2026-09-14)

After full verification, the user authorized fixing the remaining size-label
failure and merging PR #111 despite its legacy-main conflict. The replacement
merge uses legacy main `9719218c1cec0a594c0b9f022c12e7593f8e569d` as its first
parent and the final PR head as its second parent. Its tree is exactly the PR
head's tree. Both histories and all existing co-author trailers survive; new
commits include `Co-authored-by: Codex <codex@openai.com>`. Publishing the merge
advances remote main with an explicit lease against the recorded legacy head.
It does not force-rewrite main or bring legacy commits into the thin-fork branch.

Recovery refs, preserved locally and on origin:

- `codex/backup-legacy-main-before-thin-cutover-20260914` retains legacy main at
  `9719218c1cec0a594c0b9f022c12e7593f8e569d`.
- `codex/backup-thin-fork-before-main-cutover-20260914` retains the verified PR
  head at `53783448c9c349ed41a37cdd1aadbdf0a49b76c2` before the workflow fix.

The PR size action exceeded Node's default 1 MiB synchronous output buffer.
Both numstat reads now allow a bounded 16 MiB. Running the actual inline script
against the failing comparison reproduced `ENOBUFS` without the fix, then read
1,617,685 bytes across 21,171 rows successfully with it. The filtered comparison
also passed (1,236,473 bytes); the script selected `size:XXL`. Label API calls
were stubbed during this local check. Targeted formatting passed. The action
still treats PR commits as passive Git data and executes no code from them.
Because `pull_request_target` reads the base workflow, its historical failed
run uses the old code; the fix becomes active when remote main advances.

The application tree is unchanged from the fully verified head; only this
workflow and the operations record changed. Mobile still matches upstream
`5ea6439816470288d3f2b6b43635fea41fbbb101` exactly. The 25 dirty paths in the
local main checkout are preserved with their existing bytes and index state.
Local checkout cutover, installed applications, old data, Coral and deletion
of recovery work remain outside this merge. To inspect or recover the old tree,
create a separate worktree from its backup ref; do not reset the dirty checkout.

## Routine future update

1. Record the current upstream SHA and local HEAD. Preserve dirty state and create a backup branch before rewriting this replacement stack.
2. Fetch upstream into an explicit ref, inspect the new range, and rebase `codex/t3-thin-fork` from its recorded upstream base. This branch retains only the upstream-based extension stack. Do not rebase main or merge main's legacy ancestry into the thin-fork branch.
3. Keep upstream changes in orchestration, provider lifecycle, persistence, mobile, Git, tooling and layout. Adapt the named extension modules or their narrow registration points instead.
4. Review every path from `git diff --name-status <new-upstream> HEAD`. Update this inventory for any modified upstream file; do not count locally owned extension files as upstream patches.
5. Run the affected package's colocated tests, package type checks and targeted formatting/lint/builds. Recheck real Coral resume, theme persistence, actual worktree scope and displayed-diff identity when the relevant seams change. Use one isolated app environment; stop it afterward.
6. Review any main-only changes before publishing another replacement merge; preserve and port wanted fixes first. Keep the rebase branch separate from main's merge history. Release publication, signing, local checkout/installed-app replacement and deletion of recovery work remain explicit separate decisions.

For an isolated web development session, run `vp run dev --home-dir /absolute/path/to/new-state`. For the desktop, run its existing start command with `T3CODE_HOME` pointing to a disposable parent; the personal build adds its suffix. Never point a standalone server at the old app's database.

## Modified upstream files

| Path                                                           | Group                            | Why this patch is necessary                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/deploy-relay.yml`                           | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/desktop-macos-preview.yml`                  | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/desktop-macos-preview-publish.yml`          | Release isolation                | Gate the new trusted preview publisher and cleanup on the upstream repository; keep signing/publication unconfigured for the fork.             |
| `.github/workflows/mobile-eas-preview.yml`                     | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/mobile-eas-production.yml`                  | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/pr-size.yml`                                | PR metadata                      | Allow bounded 16 MiB numstat output for the replacement diff; retain base-owned passive Git inspection and existing labels.                    |
| `.github/workflows/publish-aur.yml`                            | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/release.yml`                                | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `.github/workflows/web-preview.yml`                            | Release isolation                | Keep the upstream workflow source but restrict deployment/publication jobs to the upstream repository until a fork destination is established. |
| `apps/desktop/scripts/electron-launcher.mjs`                   | Desktop isolation                | Separate local app bundle identity and protocol registration; preserves the old installed app.                                                 |
| `apps/desktop/scripts/electron-launcher.test.mjs`              | Appearance verification          | Adapt the two canonical icon expectations to the retained Ocean artwork; preserve the launcher tests.                                          |
| `apps/desktop/src/app/DesktopAssets.ts`                        | Appearance                       | Resolve the personal icon through the existing asset entry point.                                                                              |
| `apps/desktop/src/app/DesktopEarlyElectronStartup.ts`          | Desktop isolation                | Use the same isolated early-start settings path and Linux identity as the runtime.                                                             |
| `apps/desktop/src/app/DesktopEnvironment.ts`                   | Desktop isolation                | Resolve personal display name, profile and identity behind the build flag; no legacy profile migration.                                        |
| `apps/desktop/src/app/DesktopStatePaths.ts`                    | Desktop isolation                | Use .456code-thin, or append 456code-thin to an explicit T3CODE_HOME.                                                                          |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts`      | Desktop isolation                | Clear inherited T3CODE_HOME for the personal backend child so the isolated bootstrap home wins.                                                |
| `apps/desktop/src/electron/ElectronProtocol.ts`                | Desktop isolation                | Register code456-thin/code456-thin-dev and use that exact scheme in the renderer policy.                                                       |
| `apps/desktop/src/main.ts`                                     | Appearance / isolation           | Seed the preset after Clerk protocol registration and before starting the application.                                                         |
| `apps/desktop/src/updates/DesktopUpdates.ts`                   | Desktop isolation                | Disable native automatic updates for the personal build.                                                                                       |
| `apps/desktop/vite.config.ts`                                  | Desktop isolation                | Define the personal build flag only in the desktop build.                                                                                      |
| `apps/server/package.json`                                     | Cartographer / isolation         | Add the isolated engine and external scanner; move dev/test to tasks with an engine build prerequisite; mark publication private.              |
| `apps/server/scripts/acp-mock-agent.ts`                        | Coral verification               | Add an opt-in real child-process Coral fixture profile; preserve existing fixture behavior.                                                    |
| `apps/server/scripts/cli.ts`                                   | Desktop isolation                | Reject npm publication while the server package is private, before reading archives or spawning npm.                                           |
| `apps/server/src/bin.ts`                                       | Desktop isolation                | Override the upstream update command with the extension rejection before runtime download or service changes.                                  |
| `apps/server/src/auth/RpcAuthorization.ts`                     | Cartographer                     | Assign the four namespaced methods to existing read/operate authorization scopes.                                                              |
| `apps/server/src/environment/ServerEnvironment.ts`             | Cartographer                     | Advertise map/impact analysis only in Node/Electron runtimes, which ship the separate analysis worker.                                         |
| `apps/server/src/http.ts`                                      | Desktop isolation                | Accept the two exact personal renderer origins using existing authenticated HTTP/CORS handling.                                                |
| `apps/server/src/mcp/McpHttpServer.ts`                         | Cartographer                     | Register the read-only toolkit alongside upstream app MCP tools.                                                                               |
| `apps/server/src/mcp/McpInvocationContext.ts`                  | Cartographer                     | Name the Cartographer credential capability.                                                                                                   |
| `apps/server/src/mcp/McpSessionRegistry.ts`                    | Cartographer                     | Grant the capability to existing app-MCP sessions; default test options remain unchanged.                                                      |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts`            | Coral                            | Permit omitted authentication only for an empty advertised auth-method list; otherwise fail before session creation.                           |
| `apps/server/src/provider/builtInDrivers.ts`                   | Coral                            | Register one driver through the upstream driver registry.                                                                                      |
| `apps/server/src/server.ts`                                    | Cartographer / isolation         | Provide the extension service and replacement update policy at the composition root.                                                           |
| `apps/server/src/ws.ts`                                        | Cartographer                     | Wire namespaced RPC handlers through the existing authenticated RPC path.                                                                      |
| `apps/server/vite.config.ts`                                   | Cartographer                     | Build the analysis worker, supply ESM shims for its bundled parser, and require engine compilation before server dev/test/build.               |
| `apps/web/public/apple-touch-icon.png`                         | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                                    |
| `apps/web/public/favicon-16x16.png`                            | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                                    |
| `apps/web/public/favicon-32x32.png`                            | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                                    |
| `apps/web/public/favicon.ico`                                  | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                                    |
| `apps/web/src/branding.test.ts`                                | Appearance verification          | Align existing hosted-name expectations with personal branding; preserve injected-brand tests.                                                 |
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
| `packages/contracts/src/model.ts`                              | Coral                            | Supply the initial default model slug; metadata probes and native setup supply available models.                                               |
| `packages/contracts/src/rpc.ts`                                | Cartographer                     | Include four namespaced RPC schemas in the existing group.                                                                                     |
| `packages/contracts/src/settings.ts`                           | Coral                            | Describe executable, Ollama endpoint and per-instance home settings using upstream form schemas.                                               |
| `knip.jsonc`                                                   | Extension verification           | Declare worker and retained CLI entry points, external parser ownership and intentionally disabled upstream updater source.                    |
| `pnpm-lock.yaml`                                               | Cartographer engine              | Lock only extension dependencies/importers; retain existing upstream resolutions.                                                              |
| `pnpm-workspace.yaml`                                          | Cartographer engine              | Scope TypeScript 6 to dependency-cruiser 18.2.0, whose parser loader cannot use the root TypeScript 7 compiler API.                            |
| `scripts/build-desktop-artifact.ts`                            | Desktop isolation / Cartographer | Use personal artifact identity, icons and publish:null; preserve scanner runtime dependencies in staged artifacts.                             |
| `scripts/release-smoke.ts`                                     | Cartographer verification        | Include the engine manifest in the existing isolated workspace fixture.                                                                        |
