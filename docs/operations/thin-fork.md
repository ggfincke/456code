# 456code fork operations and integration record

456code is my personal agent orchestration platform, derived from T3 Code. The [guiding principles](../principles.md) govern current product scope and upstream updates. This record preserves earlier integration details and evidence; dated verification applies only to the recorded revision. Use Git history for the current upstream integration base. Source updates remain separate from the installed application and existing runtime data.

## Base and local change groups

- Starting upstream base: `e816064945144957b6eb9b268912a98b0555644b`.
- First rehearsed upstream base: `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`.
- Previous upstream base: `9375c779707fb95c06670db6da87441720b2d2e2` (83 further commits).
- September 14 upstream base: `5ea6439816470288d3f2b6b43635fea41fbbb101`.
- October 27 upstream base: stable tag `v0.1.3`, `d2c440312e5f39d59827ed466838a623516454d6`.
- October 8 upstream base: `a4c9494b0e3606775cc5fc929fc138399288bd43` (303 further commits after October 4).
- October 4 base: `efecd3cf8bcec3d1891b5f5a27dc2f6d797c6448` (191 further commits after September 30).
- September 30 base: `bd89c1302026255c62cc09278207bfaf2664da4a` (44 further commits after September 26).
- September 26 base: `679c34c096193446ceed62e633387d91fe2cfff8` (138 further upstream commits after September 23).
- September 23 base: `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc` (361 upstream commits, pinned to the September 23 audit).
- Keep separate commits for desktop isolation, appearance, Coral, the engine, and application integration. Follow-up fixes belong to their corresponding concern.

Earlier integrations minimized changes to upstream V2 conversation orchestration, provider lifecycle, persistence/migrations, Git implementations, shared client runtime and `apps/mobile`. Those historical boundaries are no longer restrictions on changes needed to meet the guiding principles. Regular upstream merges remain the strategy, with an explicit principles review for each update. Preserve my working setup and report deferred upstream changes when adaptation is too costly. Prefer existing boundaries and tooling where they serve my workflow.

Existing upstream tests stay in their original locations. The three September 23 regressions use the root `tests/` tree, with dual discovery in server/web, scoped TypeScript includes, and a private resolution-only workspace package. CI retains code/build checks, Windows tests and advisory mobile fingerprints on standard GitHub runners; automated releases, deployments, previews and upstream administration workflows have been removed.

## Product and ownership boundaries

**Appearance:** `assets/fincke`, web `src/fincke`, and desktop `src/fincke/FreshProfile.ts`. Fincke Ocean is an imported environment theme with ID `fincke-ocean`; it does not replace T3's built-in Ocean. Its role colors come from VS Code's Material Theme Ocean High Contrast (the t3dotgg marketplace build); the app's VS Code importer derives its own colors, so the mapping is maintained by hand. Fork `--fincke-*` accents in `apps/web/src/fincke/oceanTokens.css` apply only while it is selected. Only a profile with neither settings nor a conversation database is seeded. Later starts respect its existing selection. The icon and wave use T3's standard asset/backdrop entry points. Setup and other product copy must follow the guiding principles; retained T3 copy is not a permanent ownership boundary.

Mobile registers `fincke-ocean` locally as a dark-only theme. Do not add it to the shared built-in catalog, which also owns desktop reserved theme IDs. Mobile's palette includes the effective web component overrides, not just the imported JSON. Explicit activation preserves the light selection and switches to Dark atomically; upgrades preserve all existing preferences. Native glass, fonts, retained navigation controllers, and app identifiers stay under their existing owners. Native composer selection tint is optional so other themes keep their platform defaults. Shared ribbon geometry and folder-color hashing live in `packages/shared`; web and native retain separate renderers. Mobile composer controls use the existing provider capabilities and settings sheet across themes, while Ocean decorations remain theme-specific.

**Desktop:** explicit build identity `com.ggfincke.456code.thin`, production Chromium profile `456code-thin-v2` and development profile `456code-thin-dev`, default backend home `~/.456code-thin`, protocol `code456-thin` (development identity, home and protocol variants append `-dev`). An explicit `T3CODE_HOME` is treated as a parent and receives a `456code-thin` suffix; the original environment value is removed from the backend child so it cannot override that bootstrap identity. Managed Codex sign-in returns and desktop handoffs use those personal protocols; callback readers also accept the corresponding upstream schemes. Desktop updates, and the desktop-hosted server's, come only from builds staged on the same machine ([staged updates](release.md#staged-updates)); npm and background-service self-updates stay disabled, publication metadata is private and artifact publishing is null. Local artifact builds remain available through the [packaging runbook](release.md). No signing, release destination or deployment is configured for this fork.

**Coral:** one driver, adapter, settings/probe module, text-generation adapter and ACP support module under existing provider/text-generation directories. Coral uses the shared ACP V2 adapter with supervised text turns, explicit native default mode, approvals, cancellation, model changes and `session/resume`. The V2 server owns queued follow-ups; Coral waits for readiness and never uses active steering or interrupt/restart steering. Structured elicitation remains unsupported. Attachments, rollback, provider replacement/import, and app-MCP access are not advertised. The only shared ACP behavior patch is optional authentication when no auth method is advertised. Other drivers retain their existing authentication path.

Coral now runs from the current-main ACP finish worktree through the repaired normal launcher. A four-second initialization-only probe checks protocol compatibility, native resume and authentication requirements, then closes its process without creating or resuming a session. A separate four-second, 1 MiB metadata-only Ollama request populates the initial picker with exact model names (up to 512 entries). Transient failures retain the last known inventory; an empty server reports an error and clears it. Native setup can also update that inventory. See [Coral local setup and validation](coral-setup.md) for the exact build, isolated homes and launcher recovery.

**Engine:** `packages/cartographer-core` is private. It exposes only immutable snapshots and its analysis worker. Resolver/export/alias/coverage fixes and graph-navigation support were selected from the Cartographer review; old proposal modules, standalone MCP/CLI entry points and proposal acceptance scripts were removed. Dependency-cruiser needs its own TypeScript 6 runtime API; this does not replace T3's root TypeScript 7 toolchain.

**Integration:** server `src/cartographer`, `src/mcp/toolkits/cartographer`, web `src/cartographer`, and `packages/contracts/src/cartographer.ts`. Four namespaced RPCs and two bounded read-only MCP tools use upstream session authorization. Agent requests use the credential's task, cannot request another task, never start analysis and return a clear preparation action when missing. No new conversation events, migrations, turn reactors or plugin framework exist.

Analysis captures the selected task's actual worktree, resolves comparison commit identities first, and checks the displayed diff hash/root before and after analysis. Source reads come exclusively from the captured base/target. Failed refreshes leave the previous complete capture accessible. A branch-range comparison analyzes the working tree against the merge-base, matching the displayed Changes diff. Returning to the app checks freshness by comparing a file-stat fingerprint of the working tree, not a content hash; explicit Refresh rebuilds. Existing results retain their capture identity and visible stale state.

The extension cache is `userdata/cartographer` beneath that backend home. Work is limited to 8,000 source/config files, 2 MiB/file, 64 MiB/capture, two concurrent analyses and a 90-second worker deadline. Responses cap graph, edge, dependency and source sizes. Captured source is project data. The newest two generations per comparison are kept, plus any generation a pointer still names; the cache is rebuildable and may be removed while the app is stopped. There is no periodic analysis or automatic turn-completion analysis.

## October 27 update (v0.1.3)

Merged stable tag `v0.1.3` (`d2c440312e`), 39 commits past the previously merged nightly `6838e31b9c`. Principles review notes:

- Upstream's Vercel `fx` provider is kept, off by default and `featured: false`. 456code only runs the local `fx` CLI (`--version`, `status` and `models` probes, `fx acp` sessions) and adds no network checks or analytics of its own; the CLI's own network use (fx/Vercel login) is outside 456code and unassessed. Coral stays in `DEFAULT_DISABLED_PROVIDER_DRIVERS` and registers beside `fx` in `builtInDrivers.ts` and `model.ts`; GitHub Copilot stays featured.
- `evals/` is kept dormant: its tests are pure graders, and live runs are manual and call paid models.
- Telemetry commit `576a40fa53` was dropped; `AnalyticsService` stays deleted.
- Deferred T3 Connect entry points, not removed this round: Environments page cloud connect rows and empty-state copy, the WelcomeWizard cloud step, `HostedEmptyState`'s `T3ConnectSteps`, `ConnectOnboardingDialog`, ScheduledTasksSettings webhook addresses, the settings sidebar T3 Connect sign-in/avatar (only in builds with cloud config), and mobile's "T3 Account" row with T3 Connect-backed push notifications and Live Activities.

## September 26 update

The 30 commits from `f5ef0ddb9..423380775` were rebased onto `679c34c09`. Range-diff: 21 equal, 9 changed, none dropped. Resolutions:

- Upstream's self-updating Linux .deb keeps its `isDebPackage` check; the personal build still sets `disabledByEnv`, which is evaluated first.
- Upstream removed `resolveSidebarStageFocusRingOffsetClass`; the Fincke branch of it was dropped with it.
- Upstream moved queued-message sending out of ChatView into the root-mounted `QueuedMessageSender`. The Coral guard now lives there: it resolves the queued message's target driver from the environment's server config and passes it to `isQueuedMessageDue`, so Coral messages still wait for a ready session whether or not the thread is open. Send now keeps the `canSendToProvider` check; the `onSend` guard only covers direct annotations, since queued messages no longer pass through it.
- `deploy-relay.yml` gained a manual dispatch with its own `if`; the repository gate is combined into that single condition.
- The lockfile was regenerated from upstream's. Package versions are unchanged; as in the September 23 lockfile, pnpm dedupes the `zod` used by `@tanstack/router-generator` and drizzle's optional peer to the engine's 4.4.3.

Frozen install, scoped web/server/desktop/scripts/engine typechecks, targeted formatting and lint (existing warnings only) passed. Focused tests: 295 web (queue store, root sender, timeline, ChatView logic, backdrop, branding and the root regressions), 484 server (Coral, ACP, MCP, text generation, fork update rejection), 169 desktop (updates, isolation, app and protocol) and 31 engine. `apps/mobile`, shared client runtime, orchestration, persistence and ProviderService still match upstream. No live Coral, desktop or mobile session was run for this update.

## September 23 local candidate

**Status:** implementation and focused checks passed; native client interaction acceptance is incomplete because host automation is unavailable. This branch is not a fully verified release or a replacement for either main branch.

The local branch is `chore/t3-upstream-20260923`, in `/Users/ggfincke/.codex/worktrees/t3-upstream-20260923/456code`. The 24 commits from `5ea643981..61313f6f0` were replayed onto exactly `f5ef0ddb9`; the replay ends at `b2ef3073b`. Order, author identities, author dates, and subjects match all 24 originals. The complete range-diff has 14 equivalent patches and 10 changed patches, with none dropped. Resolutions retain upstream client/title/migration interfaces, current composer primitives, workflow guards and dependency versions while preserving personal identity, artwork, Coral, Cartographer, private metadata and disabled publication/update paths. Four follow-up groups cover Coral server compatibility, composer behavior, graph control styling, and verification/documentation. The subsequently requested logo correction is a separate appearance commit: `CoralIcon.tsx` reproduces Coral’s full pixel grid from `src/tui/shell/welcome.ts` and the Kelp Forest colors in `src/tui/themes.ts`, replacing the placeholder branch drawing. It changes the shared web/desktop provider icon; mobile remains upstream-owned.

Coral uses `ByteSize.bytes(1_048_576)` for metadata response bounds. Title generation forwards linked context and the previous title and retains `needsRefinement`. Coral queued messages dispatch only when ready; active-turn manual actions and the queue shortcut cannot steer them. Normal follow-ups queue regardless of the saved global steering preference, which remains unchanged. Stop behavior remains upstream-owned. Multi-model targets normalize only Coral to supervised/default mode. Any batch containing Coral rejects attachments before send-side uploads or thread/worktree creation. The composer also suppresses background uploads while Coral is in that batch; an upload already staged before adding Coral remains in the draft. Graph controls own their native button styling. Truncated diff analysis remains blocked. No new wire protocol or extension RPC was added.

Node 24.20.0 and project-local pnpm 11.10.0 were used without changing host defaults. The lockfile was regenerated from pinned upstream rather than retaining duplicate keys from the replay merge. All 2,086 upstream package resolution records match; extension dependencies and the private test workspace remain. Frozen installation passed. `apps/mobile`, shared client runtime, orchestration, persistence and ProviderService still match upstream.

Focused checks passed:

- Cartographer built before server checks. The three new regression files cover real fake-CLI title context/refinement, Zustand queue eligibility/one-time take/held messages, and mixed-target preflight/permission normalization/send eligibility. Existing colocated suites remain intact.
- 50 existing server checks plus the corrected title regression; a final title pass ran 37 tests across title context, links, prompts and the Coral regression. The first regression run exposed a test-only branded-ID constructor typo, corrected before the passing rerun.
- 276 web tests across queue, keybindings, composer logic and the new regressions; 32 final upload/policy/queue tests; 31 engine tests; 41 desktop isolation/protocol checks; and 91 packaging tests. Counts overlap across focused reruns and must not be summed.
- Scoped server, web, desktop and scripts typechecks, targeted formatting/lint, and the desktop build passed. Existing lint warnings and Effect suggestions remain. The desktop build was repeated after the background-upload fix. Full workspace checks remain assigned to CI.
- Migrations 052 and 053 ran against a disposable database seeded through migration 051. Existing thread fields and message history remained readable, title state defaulted to null, viewed-file records round-tripped, and a second migration run applied nothing.

Live acceptance used `.t3/upstream-20260923/`, the normal Coral launcher, a separate Coral home, and only installed `qwen3.8:27b-mlx` on confirmed AC power. No model was downloaded. The web client generated a title and returned `CORAL_WEB_OK`. During that turn, a follow-up stayed queued, Send now was disabled, and the queue shortcut had no effect. It dispatched once after readiness and returned `QUEUE_ONCE_OK`. File approval acceptance changed fixture value `1 -> 42`; rejection left `rejected.txt` absent. Stop cancelled a fresh long-response request. After replacing the dev backend with the built desktop backend, the same native session returned `RESUME_AFTER_CANCEL_OK`: all 21 prior native messages were unchanged and exactly two new messages were appended, without replay.

The mixed Codex/Coral attachment draft was rejected intact. Adding a fresh second attachment while Coral was selected created no additional upload, thread or worktree; keyboard submission remained blocked. Unit checks establish per-target permission normalization without invoking an additional model. Map navigation opened captured import source. Edits `42 -> 43 -> 44` each made the last map stale; refresh produced a new capture. Actual turn Diff Impact retained base `1` and target `42` while the live file held `43`. The built worker subsequently refreshed and returned captured value `44`, exercising its packaged parser and worker code.

Native acceptance limits are explicit:

- Upstream's native-client helper built and installed **T3 Code Dev** (`com.t3tools.t3code.dev`) on the initially empty **iPhone 17 / iOS 26.5**, UDID `7F92110A-77CC-4D40-9D04-456166120FA5`, and returned compatible with fingerprint `df5dad9b1179d90de887ed9e84cab6d3b3e11091`. The actual `t3code-dev` scheme opened the development client and serve-sim displayed live frames. XcodeBuildMCP 2.6.2 could neither inspect nor type because Xcode 27 lacks its expected `SimulatorKit.framework` path. The system open confirmation therefore blocked Metro loading and pairing. Connection, transcript, approval, reconnect and diff interactions on mobile are **not verified**. The unused mobile pairing credential was revoked. No coordinate workaround or host-tool modification was used.
- The built desktop rendered personal artwork at `code456-thin://app/` with the fixture profile and database. Native input reported `noWindowsAvailable`; startup/profile evidence is valid, but native interactive flows are **not verified**. A separately paired controlled browser against its bundled backend performed the resume and bundled-worker checks above. This is backend/browser evidence, not a claim that native mouse interaction passed.

The original HEAD, index bytes, status and all 26 dirty paths match the initial preservation receipt. Original local main, remote main, and both thin-fork refs remain at their original OIDs. Owned backend, desktop, Metro, stream and simulator processes were stopped; the orphaned desktop backend was identified by PID and fixture database before termination. Useful isolated data and build artifacts remain, with Coral disabled in fixture settings. No push, PR, installed-app replacement, or live database access occurred. Ignored raw evidence is under the original checkout's `dev-docs/t3-upstream-implementation-20260923/`; this maintained record contains the acceptance decisions needed without those logs.

The remaining acceptance action is to rerun the bounded mobile and native desktop interaction checks when supported input tooling is available. Do not promote this local candidate as fully verified until those checks pass.

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

## Personal design changes

Upstream changes its UI files constantly, so a personal design change belongs where upstream merges do not touch it:

1. **Fork-owned modules.** Fonts, tokens, artwork and setting defaults live in `assets/fincke` and the `src/fincke` directories. Clients save their whole settings snapshot, so a changed default only reaches profiles that have never saved settings; existing clients keep their stored value.
2. **Hooks.** An upstream file only gains the smallest call or import into a fork-owned module.
3. **Replaced components.** When a change needs a different component structure, copy the component into `src/fincke`, switch its import site, and list it below with the upstream commit it was copied from. On each update, review the original's upstream history since that commit and port what is useful; replaced copies receive no upstream fixes automatically.

Fixes that are not personal preference (overflow, truncation, missing affordances) go upstream as T3 pull requests instead, so they cost nothing to keep. Styling upstream components through CSS selectors avoids merge conflicts but breaks silently when upstream renames classes; target design tokens or `data-slot` attributes, never utility classes.

Every upstream file touched for a personal design change is listed here. Earlier appearance hooks are in the [historical inventory](#historical-modified-file-inventory-september-30).

| Upstream path                                                                                                     | Fork module (`apps/web/src/fincke/`)                                       | Kind    | Change                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/main.tsx`                                                                                           | `geistFonts.ts`, `oceanTokens.css`                                         | Hook    | Applies the Linux Geist defaults and loads the Fincke Ocean tokens at startup.                                                                                                                                                                                                                                         |
| `apps/web/src/appearanceFonts.ts`                                                                                 | `geistFonts.ts`                                                            | Hook    | Default sans/code stacks lead with Geist on Linux; default labels drop ` Variable`.                                                                                                                                                                                                                                    |
| `apps/web/src/terminal/ghostty/surface.ts`                                                                        | `geistFonts.ts`                                                            | Hook    | Default terminal stack leads with Geist Mono on Linux.                                                                                                                                                                                                                                                                 |
| `apps/web/vite.config.ts`                                                                                         | `icons/lucide-react.ts`, `icons/lucide.ts`                                 | Hook    | Aliases `lucide-react` and `lucide` to the `icons/` shims: Hugeicons Free glyphs (`icons/hugeiconsMap.ts`) with Lucide fallback.                                                                                                                                                                                       |
| `packages/contracts/src/settings.ts`                                                                              | none                                                                       | Default | Plan mode and the projects sidebar (`legacySidebarEnabled`) default on; adds `sidebarProjectFolderTint` (off).                                                                                                                                                                                                         |
| `apps/web/src/hooks/useSettings.ts`                                                                               | none                                                                       | Default | Before settings load, the sidebar choice waits on the projects default.                                                                                                                                                                                                                                                |
| `apps/mobile/src/state/legacy-plan-mode.ts`                                                                       | none                                                                       | Default | Mobile plan mode is on unless the local preference is explicitly off.                                                                                                                                                                                                                                                  |
| `apps/mobile/src/features/settings/ThreadSettingsSections.tsx`                                                    | none                                                                       | Default | The Plan Mode switch in mobile Labs (`SettingsLabsRouteScreen`) reflects that default.                                                                                                                                                                                                                                 |
| `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx`, `useThreadListV2.ts`, home `HomeScreen.tsx`       | mobile `project-sidebar.ts`, `SidebarViewToggle.tsx`                       | Hook    | Projects view, view toggle and full-bleed wave band (`ProjectSidebarRows.tsx`, `FinckeListHeader.tsx`); the list hook returns the layout input and pending tasks the projects view needs. Home sets `scrollToOverflowEnabled` (upstream bug).                                                                          |
| `apps/mobile/src/features/threads/thread-list-v2-items.tsx`, `threadListV2.ts`, `*-row-appearance*.ts`            | mobile `SidebarThreadRowContent.tsx`                                       | Hook    | Sidebar-pane rows use desktop's compact bodies and keep their time beside status glyphs; the project favicon scales with font size (`projectIconSize`) like upstream rows.                                                                                                                                             |
| `apps/mobile/src/features/threads/threadListV2.ts`, `useThreadListV2.ts`                                          | none                                                                       | Hook    | The Working shelf sits below pinned threads and above active (`workingShelfEndIndex`); the first active row after it draws a hairline (`showWorkingEndDivider`, rendered in `thread-list-v2-items.tsx`, passed by `HomeScreen.tsx` and `ThreadNavigationSidebar.tsx`).                                                 |
| `apps/mobile/src/features/threads/ProposedPlanCard.tsx`, `thread-work-log.tsx`, `ThreadDetailScreen.tsx`          | mobile `implement-plan.tsx`                                                | Hook    | Implement button on the latest active plan card, sent through the outbox in default mode; clears the Plan chip.                                                                                                                                                                                                        |
| `apps/mobile/src/state/thread-outbox-model.ts`, `threadOutboxDelivery.ts`                                         | mobile `implement-plan.tsx`                                                | Hook    | Queued messages carry an optional `sourceProposedPlan` so the server marks the plan implemented.                                                                                                                                                                                                                       |
| `apps/web/src/proposedPlan.ts`, `apps/web/src/session-logic.ts`, `packages/client-runtime/package.json`           | `packages/client-runtime/src/proposedPlan.ts`                              | Hook    | Implement-prompt helpers and latest-plan selection live in client-runtime (shared with mobile) and are re-exported.                                                                                                                                                                                                    |
| `apps/mobile/src/persistence/mobile-preferences.ts`                                                               | mobile `use-sidebar-view.ts`                                               | Hook    | Stores `sidebarProjectsView`; collapsed projects reuse `collapsedProjectGroups`.                                                                                                                                                                                                                                       |
| `apps/mobile/src/features/threads/ThreadSettingsSheet.tsx`, `ThreadComposer.tsx`                                  | mobile `ProviderLimitsLine.tsx`                                            | Hook    | One-line limits under each provider header; the low-limit ring opens thread settings.                                                                                                                                                                                                                                  |
| `apps/mobile/src/features/layout/createWorkspaceStackNavigator.ios.tsx`, `V5StackHeader.ios.tsx`                  | none                                                                       | Hook    | Duo bar: fixed sidebar width; sidebar, new task and search group; thread settings ends the tools group.                                                                                                                                                                                                                |
| `apps/mobile/src/features/keyboard/hardwareKeyboardCommands.ts`, `HardwareKeyboardCommandProvider.tsx`            | none                                                                       | Hook    | `threadSettings` (registered by `ThreadComposer.tsx`) and a dispatched `commandPalette` back the bar buttons.                                                                                                                                                                                                          |
| `apps/mobile/src/features/threads/useThreadHeaderOptions.tsx`                                                     | none                                                                       | Hook    | The Duo drops the header sidebar button and adds thread settings to the bar's tools group.                                                                                                                                                                                                                             |
| `apps/mobile/src/components/CompactBrandTitle.tsx`, `apps/mobile/src/features/home/HomeScreen.tsx`                | mobile `wave-header-edge.ts`                                               | Hook    | Ocean: white brand title; the home list hides UIKit's top edge effect only while the wave band is under the header and restores it once the band has scrolled away, so rows under the title keep a backing.                                                                                                            |
| `packages/contracts/src/keybindings.ts`                                                                           | none                                                                       | Hook    | Adds the `sidebar.toggleView` command.                                                                                                                                                                                                                                                                                 |
| `packages/shared/src/keybindings.ts`                                                                              | none                                                                       | Default | `mod+alt+u` toggles the sidebar view; Esc runs `thread.stop` while a turn runs outside the terminal.                                                                                                                                                                                                                   |
| `apps/web/src/components/ChatView.tsx`                                                                            | `escapeStop.ts`                                                            | Hook    | Esc defers `thread.stop` until open menus, dialogs and fields have had the key.                                                                                                                                                                                                                                        |
| `apps/web/src/components/AppSidebarLayout.tsx`                                                                    | `ProjectSidebar.tsx`                                                       | Hook    | Imports the owned projects sidebar.                                                                                                                                                                                                                                                                                    |
| `apps/web/src/components/Sidebar.tsx`                                                                             | `ActivityThreadRow.tsx`, `ActivityDraftBlock.tsx`, `SidebarViewToggle.tsx` | Hook    | Uses the owned activity and draft rows and the header view toggle.                                                                                                                                                                                                                                                     |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                                                               | `SidebarViewToggle.tsx`                                                    | Hook    | Header `actions` slot; the footer Usage button is removed.                                                                                                                                                                                                                                                             |
| `apps/web/src/components/Sidebar.logic.ts`                                                                        | `oceanTokens.css`                                                          | Hook    | Fincke-scoped status colors appended in `resolveThreadStatusPill`.                                                                                                                                                                                                                                                     |
| `apps/web/src/components/Sidebar.tsx`, `Sidebar.logic.ts`, `Sidebar.drag.ts`                                      | none                                                                       | Hook    | The Working shelf sits between pinned and active (keyboard order, rendering, drop targets, drag preview, bottom-shelf gap); Snoozed and Archived anchor the bottom and host the undo notice. Outside drags the active boundary draws a hairline under Working (`SidebarListMarkers.tsx` `SidebarDragBoundary` `rule`). |
| `apps/web/src/components/CommandPalette.tsx`, `apps/web/src/shortcuts/commandPaletteCommands.ts`                  | `sidebarView.ts`                                                           | Hook    | `installCommandPaletteCommands` registers the `sidebar.toggleView` handler; the palette only lists the action.                                                                                                                                                                                                         |
| `apps/web/src/components/ReopenClosedViewShortcut.tsx`, `apps/web/src/components/files/BrowserDocumentFrame.tsx`  | `SidebarViewToggle.tsx`                                                    | Hook    | Forward `sidebar.toggleView` from previews and rendered HTML.                                                                                                                                                                                                                                                          |
| `apps/web/src/components/settings/SettingsPanels.tsx`, `settingsSearch.ts`, `AppearanceSettingsPanel.tsx`         | `ProjectFolderTintSetting.tsx`                                             | Hook    | "Group sidebar by project" wording and the folder-color switch.                                                                                                                                                                                                                                                        |
| `knip.jsonc`                                                                                                      | none                                                                       | Hook    | Keeps the replaced upstream originals and the icon shims as entries.                                                                                                                                                                                                                                                   |
| `apps/web/src/components/chat/composerProviderState.tsx`                                                          | `EffortPicker.tsx`                                                         | Hook    | Renders the owned effort picker.                                                                                                                                                                                                                                                                                       |
| `apps/web/src/components/chat/TraitsPicker.tsx`, `ComposerPendingApprovalActions.tsx`                             | `EffortPicker.tsx`, `FinckeApprovalCard.tsx`                               | Hook    | Export `getTraitsSectionVisibility` and `DEFAULT_APPROVAL_OPTIONS`.                                                                                                                                                                                                                                                    |
| `apps/web/src/components/chat/ChatComposer.tsx`                                                                   | `FinckeApprovalCard.tsx`, `slashMenu.ts`                                   | Hook    | Fincke approval card; floating, sectioned slash menu.                                                                                                                                                                                                                                                                  |
| `apps/web/src/components/chat/ComposerFooterControls.tsx`                                                         | `PlanModeChip.tsx`, `useFinckeOcean.ts`                                    | Hook    | Under Fincke Ocean the plan control is a chip shown only while plan mode is on.                                                                                                                                                                                                                                        |
| `apps/web/src/components/chat/TimelineUserMessageRow.tsx`, `ComposerPrimaryActions.tsx`                           | `threadPane.css`, `StopRing.tsx`                                           | Hook    | `data-slot` hooks for the user bubble, send and stop buttons; the stop button's turning ring.                                                                                                                                                                                                                          |
| `apps/web/src/components/chat/ThreadActivityBanners.tsx`                                                          | `BackgroundWorkBanner.tsx`, `backgroundWorkBanner.css`                     | Hook    | The background work line at the end of the timeline (upstream `ThreadNow.tsx`) gets a kind icon, a plain title and a square Stop icon; the CSS targets that line under Fincke Ocean, where every composer banner uses the sidebar surface.                                                                             |
| `apps/web/src/components/chat/ComposerCommandMenu.tsx`, `ComposerCommandMenuLayer.tsx`, `useComposerMenuItems.ts` | `slashMenu.ts`                                                             | Hook    | Kind sections and colors, first-sentence descriptions, composer-width popup.                                                                                                                                                                                                                                           |
| `apps/web/src/components/chat/ComposerBanner.tsx`                                                                 | none                                                                       | Hook    | Re-adds a minimal `placement` prop on `ComposerBanner.Surface` only so the grouped slash menu (`ComposerCommandMenu`, `slashMenu.ts`) floats as its own card without the seam shade; every other surface stays attached.                                                                                               |
| `apps/web/src/components/SidebarStageBackdrop.tsx`                                                                | `FinckeWaveArt.tsx`, `waveBackdrop.css`                                    | Hook    | Solid fade so the Fincke wave stays a full-color header band.                                                                                                                                                                                                                                                          |
| `apps/web/src/components/chat/TimelineToolActivityIcon.tsx`, `V2LifecycleRow.tsx`                                 | none                                                                       | Hook    | The app's own tool and "Created thread" rows show the 456 icon.                                                                                                                                                                                                                                                        |
| `apps/web/src/components/settings/SettingsPanels.tsx`, `settingsSearch.ts`                                        | none                                                                       | Removal | Drops the upstream privacy-policy row (it linked T3's policy; no setting behind it); `legalLinks.ts` deleted.                                                                                                                                                                                                          |
| `apps/web/src/components/settings/LabsSettingsPanel.tsx`, `settingsSearch.ts`                                     | none                                                                       | Removal | Drops the Beta section and its Guest links row, the only way to turn on guest sharing (it needs T3 Connect); `guestSharingEnabled` stays off, and existing shares keep their indicator.                                                                                                                                |
| `apps/web/src/components/settings/ConnectionsSettings.tsx`, `SavedEnvironmentRows.tsx`, `settingsSearch.ts`       | none                                                                       | Removal | T3 Connect, Hold webhooks while offline and Publish agent activity rows are gone from Sharing & access and search (principles §4); pairing, device access, authorized clients and auth stay; cloud services are untouched.                                                                                             |
| `apps/server/src/mcp/McpHttpServer.ts`                                                                            | none                                                                       | Removal | The MCP tool analytics block stays removed with `AnalyticsService` (principles §4); the Cartographer toolkit registers beside upstream tools.                                                                                                                                                                          |
| `apps/web/src/components/settings/AddProviderInstanceDialog.tsx`                                                  | `CopilotProviderTile.tsx`                                                  | Hook    | Featured GitHub Copilot tile prepares the `github-copilot-cli` ACP Registry entry or falls back to a prefilled registry search (principles §5).                                                                                                                                                                        |
| `apps/desktop/src/snapShot/KdeSnapShot.ts`, `GnomeCaptureSetup.ts`, `apps/desktop/gnome-extension/metadata.json`  | `apps/desktop/src/fincke/build.ts`                                         | Copy    | Helpers display as "<app> SnapShots"; uuids, markers and install paths unchanged; the KDE freshness check ignores `Name=`.                                                                                                                                                                                             |
| `scripts/build-desktop-artifact.ts`                                                                               | none                                                                       | Copy    | Personal builds name the app in macOS usage descriptions.                                                                                                                                                                                                                                                              |
| `apps/web/src/components/chat/ModelPickerContent.tsx`                                                             | `ModelPickerLimitsLine.tsx`                                                | Hook    | One-line limits under the picker search.                                                                                                                                                                                                                                                                               |
| `apps/web/src/components/chat/ComposerControlsBar.tsx`, `restingComposerControlsMeasurement.ts`                   | `ComposerLimitIndicator.tsx`                                               | Hook    | Low-limit ring beside the model chip, counted in footer width.                                                                                                                                                                                                                                                         |
| `apps/web/src/components/usage/UsageLimitsPooled.tsx`                                                             | `providerLimits.ts`                                                        | Hook    | Fincke bar colors by remaining limit.                                                                                                                                                                                                                                                                                  |
| Everyday UI copy in `apps/web` and `apps/desktop`                                                                 | none                                                                       | Copy    | Names come from `APP_BASE_NAME` (`apps/web/src/branding.ts`) and `DESKTOP_APP_NAME` (`apps/desktop/src/fincke/build.ts`); `packages/client-runtime` uses neutral wording; theme label "T3 Classic". T3 Connect, relay and hosted flows, attribution and technical identifiers keep upstream names.                     |
| `AGENTS.md`                                                                                                       | none                                                                       | Copy    | The Evals section says live evals call paid models and run only when the developer asks.                                                                                                                                                                                                                               |

Replaced components (review the original's upstream history since the recorded commit on each update):

| Upstream original                                                                                                       | Fork copy                | Copied from  |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------ |
| `apps/web/src/components/LegacySidebar.tsx`                                                                             | `ProjectSidebar.tsx`     | `d2c440312e` |
| `apps/web/src/components/sidebar/SidebarThreadRow.tsx` (row + `SortableThreadRow`)                                      | `ActivityThreadRow.tsx`  | `d2c440312e` |
| `apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx` + action layout of `ComposerPendingApprovalActions.tsx` | `FinckeApprovalCard.tsx` | `d2c440312e` |
| `apps/web/src/components/chat/TraitsPicker.tsx` (`TraitsPicker`)                                                        | `EffortPicker.tsx`       | `d2c440312e` |
| `apps/web/src/components/sidebar/SidebarDraftBlock.tsx`                                                                 | `ActivityDraftBlock.tsx` | `d2c440312e` |

## Routine future update

1. Record local HEAD, the incorporated upstream base and the exact new upstream target. The target is the latest stable upstream release tag; record both the tag and its commit. Merge an untagged or nightly commit early only for a specific fix I need or when the latest stable release is more than 10 days old, and say why in the PR. Preserve dirty state and existing worktrees before changing either checkout.
2. Fetch origin and the upstream target, start an isolated integration branch from current `origin/main`, and merge that one pinned target normally. Preserve both histories and resolve the extension hooks against the current upstream interfaces.
3. Keep upstream changes in orchestration, provider lifecycle, persistence, mobile, Git, tooling and layout. Adapt the named extension modules or their narrow registration points instead. Recheck each hook listed under [personal design changes](#personal-design-changes), and review upstream history for every replaced component since its recorded commit.
4. Review every path differing from the new upstream target. Keep upstream dependency resolutions and patches, with extension dependencies added through their existing owners.
5. Run focused existing tests, affected package typechecks and targeted formatting/lint/builds. When interactive acceptance is requested, use an isolated app environment to recheck Coral resume, theme persistence, worktree scope and displayed-diff identity.
6. Keep quality CI on standard GitHub runners and retain disabled publication and npm/service self-update behavior; desktop updates stay limited to locally staged builds. Authorized scheduled syncs push coherent integration commits and open one draft PR; each merge requires a fresh human decision.
7. Package only approved merged `origin/main` with passing quality CI on that exact commit. Install only while the app and its helpers are confirmed closed, preserving a verified recovery bundle and all profile data. Keep shared build/install receipts, defer while the app is running, and leave it closed after installation.

## Historical modified-file inventory (September 30)

This snapshot predates V2. Its client queue modules and V1 provider/checkpoint interfaces have since been replaced; use the ownership boundaries above and the current upstream diff for new integrations.

| Path                                                           | Group                            | Why this patch is necessary                                                                                                       |
| -------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/scripts/electron-launcher.mjs`                   | Desktop isolation                | Separate local app bundle identity and protocol registration; preserves the old installed app.                                    |
| `apps/desktop/scripts/electron-launcher.test.mjs`              | Appearance verification          | Adapt the two canonical icon expectations to the retained Ocean artwork; preserve the launcher tests.                             |
| `apps/desktop/src/app/DesktopAssets.ts`                        | Appearance                       | Resolve the personal icon through the existing asset entry point.                                                                 |
| `apps/desktop/src/app/DesktopEarlyElectronStartup.ts`          | Desktop isolation                | Use the same isolated early-start settings path and Linux identity as the runtime.                                                |
| `apps/desktop/src/app/DesktopEnvironment.ts`                   | Desktop isolation                | Resolve personal display name, profile and identity behind the build flag; no legacy profile migration.                           |
| `apps/desktop/src/app/DesktopStatePaths.ts`                    | Desktop isolation                | Use .456code-thin, or append 456code-thin to an explicit T3CODE_HOME.                                                             |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts`      | Desktop isolation                | Clear inherited T3CODE_HOME for the personal backend child so the isolated bootstrap home wins.                                   |
| `apps/desktop/src/electron/ElectronProtocol.ts`                | Desktop isolation                | Register code456-thin/code456-thin-dev and use that exact scheme in the renderer policy.                                          |
| `apps/desktop/src/main.ts`                                     | Appearance / isolation           | Seed the preset after Clerk protocol registration and before starting the application.                                            |
| `apps/desktop/src/updates/DesktopUpdates.ts`                   | Desktop isolation                | Disable native automatic updates for the personal build.                                                                          |
| `apps/desktop/vite.config.ts`                                  | Desktop isolation                | Define the personal build flag only in the desktop build.                                                                         |
| `apps/server/package.json`                                     | Cartographer / isolation         | Add the isolated engine and external scanner; move dev/test to tasks with an engine build prerequisite; mark publication private. |
| `apps/server/scripts/acp-mock-agent.ts`                        | Coral verification               | Add an opt-in real child-process Coral fixture profile; preserve existing fixture behavior.                                       |
| `apps/server/scripts/cli.ts`                                   | Desktop isolation                | Reject npm publication while the server package is private, before reading archives or spawning npm.                              |
| `apps/server/src/bin.ts`                                       | Desktop isolation                | Override the upstream update command with the extension rejection before runtime download or service changes.                     |
| `apps/server/src/auth/RpcAuthorization.ts`                     | Cartographer                     | Assign the four namespaced methods to existing read/operate authorization scopes.                                                 |
| `apps/server/src/environment/ServerEnvironment.ts`             | Cartographer                     | Advertise map/impact analysis only in Node/Electron runtimes, which ship the separate analysis worker.                            |
| `apps/server/src/http.ts`                                      | Desktop isolation                | Accept the two exact personal renderer origins using existing authenticated HTTP/CORS handling.                                   |
| `apps/server/src/mcp/McpHttpServer.ts`                         | Cartographer                     | Register the read-only toolkit alongside upstream app MCP tools.                                                                  |
| `apps/server/src/mcp/McpInvocationContext.ts`                  | Cartographer                     | Name the Cartographer credential capability.                                                                                      |
| `apps/server/src/mcp/McpSessionRegistry.ts`                    | Cartographer                     | Grant the capability to existing app-MCP sessions; default test options remain unchanged.                                         |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts`            | Coral                            | Permit omitted authentication only for an empty advertised auth-method list; otherwise fail before session creation.              |
| `apps/server/src/provider/builtInDrivers.ts`                   | Coral                            | Register one driver through the upstream driver registry.                                                                         |
| `apps/server/src/server.ts`                                    | Cartographer / isolation         | Provide the extension service and replacement update policy at the composition root.                                              |
| `apps/server/src/ws.ts`                                        | Cartographer                     | Wire namespaced RPC handlers through the existing authenticated RPC path.                                                         |
| `apps/server/tsconfig.json`                                    | Extension verification           | Include the root `tests/apps/server` regressions in the server type check.                                                        |
| `apps/server/vite.config.ts`                                   | Cartographer                     | Build the analysis worker, supply ESM shims for its bundled parser, and require engine compilation before server dev/test/build.  |
| `apps/web/public/apple-touch-icon.png`                         | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                       |
| `apps/web/public/favicon-16x16.png`                            | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                       |
| `apps/web/public/favicon-32x32.png`                            | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                       |
| `apps/web/public/favicon.ico`                                  | Appearance                       | Use the existing personal icon at the standard web favicon/touch-icon path.                                                       |
| `apps/web/src/branding.test.ts`                                | Appearance verification          | Align existing hosted-name expectations with personal branding; preserve injected-brand tests.                                    |
| `apps/web/src/branding.ts`                                     | Appearance                       | Set the personal display-name constants.                                                                                          |
| `apps/web/src/components/ChatView.tsx`                         | Cartographer                     | Mount lazy map/impact panels and expose Map only for capable environments and Git-backed tasks.                                   |
| `apps/web/src/components/DiffPanel.tsx`                        | Cartographer                     | Send the displayed comparison identities, cwd and diff hash to Analyze Impact.                                                    |
| `apps/web/src/components/QueuedMessageSender.tsx`              | Coral                            | Pass the queued message's target driver to the due check so Coral waits for a ready session.                                      |
| `apps/web/src/components/RightPanelTabs.tsx`                   | Cartographer                     | Add Map/Impact descriptors and a Map launcher to upstream panel controls.                                                         |
| `apps/web/src/components/SidebarStageBackdrop.tsx`             | Appearance                       | Add Fincke wave artwork through the existing backdrop hook.                                                                       |
| `apps/web/src/components/chat/ChatComposer.tsx`                | Coral                            | Reject attachments consistently and show only Coral-supported permission modes.                                                   |
| `apps/web/src/components/chat/CompactComposerControlsMenu.tsx` | Coral                            | Disable unsupported permission options in compact controls.                                                                       |
| `apps/web/src/components/chat/MessagesTimeline.tsx`            | Coral                            | Disable Send now and show the waiting label while Coral cannot be steered.                                                        |
| `apps/web/src/components/chat/providerIconUtils.ts`            | Coral                            | Resolve the Coral icon through upstream provider presentation.                                                                    |
| `apps/web/src/components/settings/providerDriverMeta.ts`       | Coral                            | Expose the driver in the standard Add provider instance flow.                                                                     |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`            | Appearance                       | Use the existing header branding/artwork entry point; retain the upstream sidebar layout.                                         |
| `apps/web/src/queuedMessageStore.ts`                           | Coral                            | Hold due queued messages for Coral until its session is ready.                                                                    |
| `apps/web/src/rightPanelStore.ts`                              | Cartographer                     | Add two singleton panel kinds to upstream panel state.                                                                            |
| `apps/web/src/themePalette.ts`                                 | Appearance                       | Recognize the personal artwork identifier while preserving T3 theme storage and rendering.                                        |
| `apps/web/tsconfig.json`                                       | Extension verification           | Include the root `tests/apps/web` regressions in the web type check.                                                              |
| `apps/web/vite.config.ts`                                      | Extension verification           | Discover root `tests/apps/web` regressions alongside colocated tests.                                                             |
| `packages/contracts/src/environment.ts`                        | Cartographer                     | Add an optional availability capability for version-skew tolerance.                                                               |
| `packages/contracts/src/index.ts`                              | Cartographer                     | Export the new schema-only contract module.                                                                                       |
| `packages/contracts/src/model.ts`                              | Coral                            | Supply the initial default model slug; metadata probes and native setup supply available models.                                  |
| `packages/contracts/src/rpc.ts`                                | Cartographer                     | Include four namespaced RPC schemas in the existing group.                                                                        |
| `packages/contracts/src/settings.ts`                           | Coral                            | Describe executable, Ollama endpoint and per-instance home settings using upstream form schemas.                                  |
| `knip.jsonc`                                                   | Extension verification           | Declare worker and retained CLI entry points, external parser ownership and intentionally disabled upstream updater source.       |
| `pnpm-lock.yaml`                                               | Cartographer engine              | Lock only extension dependencies/importers; retain existing upstream resolutions.                                                 |
| `pnpm-workspace.yaml`                                          | Cartographer engine              | Scope TypeScript 6 to dependency-cruiser 18.2.0, whose parser loader cannot use the root TypeScript 7 compiler API.               |
| `scripts/build-desktop-artifact.ts`                            | Desktop isolation / Cartographer | Use personal artifact identity, icons and publish:null; preserve scanner runtime dependencies in staged artifacts.                |
| `scripts/release-smoke.ts`                                     | Cartographer verification        | Include the engine manifest in the existing isolated workspace fixture.                                                           |
