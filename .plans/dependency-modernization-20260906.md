# Dependency modernization — 2026-09-06

## Authority and baseline

The user approved the complete dependency modernization plan in this task, including source
adaptations, dependency patches, generated MSW/Pierre outputs, Effect reference synchronization,
the named focused tests and limited regression additions, and isolated web/iOS/desktop verification.
Commits, publication, releases, EAS submission, global tool replacement, and installed application
replacement are excluded.

Baseline: `a60bdbc5856fdb88e32585156238b39617bf9e86` on clean `main`.
Implementation: `codex/dependency-modernization-20260906` in a separate worktree.
The original checkout, other worktrees, and persisted user application state are preserved.

## Approved targets and invariants

- Node 24.20.0 LTS; development engine `^24.20.0`; Node types 24.13.3.
- pnpm 12.3.4, Corepack 0.36.0, Vite+ and aliased core 0.3.0; retain TypeScript 6 API/mobile
  and TypeScript 7 compiler ownership.
- Effect family 4.0.0-beta.107, Effect language tooling 0.41.0; preserve required RPC/MCP
  patches and Vite+ testing integration. Scope the Atom React exception to beta107/19.2.3.
- Electron 44.2.0, Builder 26.16.0, Updater 6.8.9, Playwright 1.63.0, FFF 0.10.6,
  Electron Store 11.0.2. Adopt macOS 13 minimum and signed notification requirements.
- Noble curves/hashes 2.4.0; preserve prehashed compact signatures and high-S verification.
- Web React/DOM 19.2.8, Lexical 0.50.0, Pierre Diffs 1.4.1, Trees 1.0.0-beta.6,
  Shiki 4.4.3, LegendList 3.3.10.
- Expo 57.0.20 and SDK-aligned packages, Clerk Expo 4.6.5, Nitro Markdown 0.12.1 and
  Nitro Modules 0.37.1. Preserve the owned Fabric bridge and plain-text fallback.
- Mobile holds: React/DOM 19.2.3, RN 0.86.3, Reanimated 4.5.1, Worklets 0.10.1,
  Gesture Handler 2.32.x, Screens 4.26.2, Safe Area Context 5.7.x, SVG 15.15.4,
  WebView 13.16.1, patched Keyboard Controller 1.21.13.
- Preserve package catalogs, SDK/protocol boundaries, supply-chain/build permissions, persisted
  data, and existing functional patches. Stable direct updates use the recorded registry
  intake; only existing Effect/Pierre prerelease families continue.
- All seven known transitive deprecations may remain. Do not force unsupported overrides.

## Execution ledger

| Group | State | Evidence |
| --- | --- | --- |
| 1. Package manager and build tooling | Passed local gate | Frozen install and peers clean; packaging helpers 23/23; scripts/plugin types and 7 configuration files checked |
| 2. Effect, shared libraries, providers | Passed local gate | Frozen/peers clean; affected typechecks and focused schema/RPC/provider/MCP/signing/SQL/analysis gates passed |
| 3. Desktop runtime and packaging | Passed build and source gates | Focused suites/types pass; final arm64 DMG and production install pass; packaged acceptance detailed below |
| 4. Web and mobile rendering | Passed source gate | Web 153 focused tests; mobile 36; affected types, lint and formatting pass; native rebuild and Metro export pass |
| Integrated acceptance | Completed available local checks; limits recorded | Web, rebuilt iOS and final DMG exercised; native selection passed; software-keyboard and signed-release gates remain |

## Verification contract

Run frozen installation, peers and patch checks; focused affected-package tests/typechecks/lint.
Approved regression changes cover asynchronous clipboard completion/rejection, Playwright wrong-module
extraction, and native Markdown parser-failure fallback; existing API fixtures may be adapted.
No routine full-workspace suites locally. CI owns full and cross-platform acceptance.

Primary-agent integrated verification covers connection/thread updates, keyboard/composer scrolling,
navigation, rich/selectable Markdown, diffs and links. Packaged desktop verification additionally
covers text/image clipboard, browser automation, PTY operations, native search and restart persistence.
Use isolated state; stop verification processes afterward. Unsigned notification failure must be
observable; successful signed notification delivery is a release gate.

## Results and deviations

### Group 1

- Corepack 0.36.0 launched through npm exec under mise Node 24.20.0; no global tool replaced.
- pnpm 12.3.4 / Vite+ 0.3.0 installation and frozen reinstallation passed, including all original
  dependency patches. `pnpm peers check` reports no issues.
- Scripts packaging/catalog tests: 2 files, 23 tests passed. Scripts and Oxlint-plugin typechecks
  passed; new Effect language-service suggestion diagnostics are informational.
- Targeted plugin lint and configuration formatting passed. Workflow checks cover 21 setup steps
  and four EAS profiles. Hosted CI and EAS execution remain later delivery gates.
- EAS provisions explicit Node/pnpm versions with Corepack disabled. Its preinstall hook already
  requires pnpm, so upgrading Corepack inside that hook cannot solve bootstrap compatibility.
- Babel JSX 8.0.1 introduced Babel 7 peer conflicts in the Expo/web graph. Keep compatible JSX
  7.29.7 and explicitly declare web's Babel core 7.29.7; no peer-rule relaxation was introduced.
- pnpm 12 may store package-manager dependencies and workspace dependencies as separate YAML
  documents within lockfile format 9.0. Repository production readers inspect lockfile text rather
  than assuming one YAML document.
- Exact package intake/selected targets are in `dependency-modernization-targets-20260906.json`.

### Group 2

- Effect and Vite+ testing patches apply to beta107. RPC hooks and ping/pong/timeout behavior
  remain; MCP DELETE session termination was rebased onto the shared HTTP transport.
  The old Vitest runner substitution is obsolete because upstream now uses the supported
  TestRunner API; all seven Vite+ import/export substitutions remain.
- The Effect reference snapshot matches canonical `Effect-TS/effect.git`, tag
  `effect@4.0.0-beta.107`, commit `3c495ae7c96d43bfc3b8020250562a194c2c895e`, tree
  `5e77033d116402945c4115c8c3c6b8fce8ec81e8`. All 3,375 paths, contents, modes, and symlinks
  were verified. Alchemy's 1,521 files are unchanged. The scoped owner dry run and ten existing
  sync tests pass. The current subtree owner creates commits, so the exact snapshot was applied
  through a scratch archive without altering Git refs/index/history; this respects delivery scope.
- Migrated owned Schema TaggedErrorClass calls to TaggedError and replaced the now-internal
  UnknownFromJsonString alias with fromJsonString(Schema.Unknown). InvalidValue arguments now
  follow beta107's annotations/input ordering.
- Web React/DOM 19.2.8 moved forward as an Effect installation prerequisite. Mobile stays
  19.2.3 with only the exact beta107 Atom peer exception; peers report no issues.
- Claude SDK 0.3.263 is younger than the existing release-age threshold. Selected exact 0.3.261
  and removed only the automatically added Claude exceptions. Enabled minimumReleaseAgeStrict
  so later updates cannot silently exempt young packages. Existing exceptions remain intact.
- Shared/mobile Noble signing suites pass 16 tests, including high-S compatibility. Contracts
  pass 109 tests, shared JSON/YAML pass 16, Cartographer analysis passes 45. Remaining runtime
  gates are ongoing; these counts do not constitute integrated acceptance.

- Final Group 2 gate: frozen installation and peer checks pass. Server, contracts, shared,
  client-runtime, ACP and Codex package typechecks pass. Client/schema/Codex lane passed 231
  focused tests; ACP passed 45; Claude/OpenCode passed 163 with subsequent changed-adapter/registry
  reruns; MCP passed 26 including the actual DELETE session lifecycle; SQL/CLI/preview/VCS passed
  47 with a subsequent CLI 20-test rerun. Shared observability/Net passed 13.
- Mobile resolution is React/DOM 19.2.3, Atom/Effect beta107, Scheduler 0.27.0, RN 0.86.3.
  A mobile-resolved React DOM probe verified Atom mount, subscription update and unmount. The
  rebuilt native gate remains required after Group 4.
- Preserved decimal string RPC request IDs for clients talking to beta78 servers; beta107's
  numeric default is incompatible with those servers. ACP keeps its numeric wire IDs and disjoint
  extension range. Pinned generated protocol revisions are unchanged.
- MCP explicitly selects the existing 2025-06-18 protocol and preserves invalid-parameter tool
  results, annotations and authorization context. SQL unprepared value results share the existing
  execution/reset behavior. OTLP now receives its explicit flusher and HTTP client dependencies.

### Group 3

- Installed Electron 44.2.0, explicit Builder 26.16.0, Updater 6.8.9, Store 11.0.2,
  Playwright 1.63.0, FFF 0.10.6 and ASAR 4.3.0. Frozen reinstall and peers pass. The same seven
  transitive deprecations remain.
- Clipboard text and PNG writes await completion/rejection; notifications await show/failed
  events through the existing typed logging surface. Playwright extraction anchors to the
  injected-script module identity. Removed the retired WebSQL clear-storage option.
- FFF's patch applies to both dist/index.js and dist/index.cjs. Forward/reverse application,
  installed bytes and 20 Windows/POSIX ASAR resolver probes pass. Windows native-load probes
  use the new entrypoint. Builder metadata declares macOS 13.0.0; maintained docs explain the
  minimum and signed notification requirement.
- Source gate: desktop typecheck and 57 clipboard/preview/browser tests pass; 53 updater/settings/
  launcher tests and three desktop trace tests pass. Packaging helper tests 22/22 and scripts
  typecheck pass. Targeted lint reports only three unchanged unused packaging imports.
- The existing Electron bootstrap downloaded and verified its owned 44.2.0 runtime; Info.plist
  reports macOS 13.0 and the binary reports embedded Node 24.20.0. Native SQLite loads.
  The application NodePtyAdapter spawns a shell successfully under Electron 44 and returns its
  expected output. A preliminary raw node-pty probe bypassed the existing spawn-helper permission
  repair and failed; the owner-path probe passed without a source workaround. SSH focused
  tunnel/command tests passed 21 and SSH/Tailscale types passed.
- Production staging installation and packaged DMG/launch passed during integrated acceptance.
  Signed notification delivery remains a release gate; detailed runtime results appear below.

### Group 4

- Preserved Expo's exact React/native tuple and keyboard exception. Removed the inactive mobile
  tarball override declaration; retained its tarball.
- Rebased LegendList, Pierre Diffs, Nitro Modules and Native Stack patches. Native Stack retains
  all custom center/toolbar/subtitle/navigation style/mail-search behavior and new upstream inset
  handling. Pierre Diffs retains three needed exports; equivalent upstream selection/gutter
  behavior replaces obsolete patch sections. Other patches remain on unchanged versions.
- Exact Nitro Markdown 0.12.1 package extension marks guarded RaTeX peer optional; math stays
  disabled and Metro bundling passed with RaTeX absent.

- Trees beta6 pins Theming 1.0.0, whose peer metadata rejects Theme 2.0.0 from Diffs 1.4.1.
  Scoped Trees beta6 to publisher Theming 1.0.1; all four runtime entrypoints are byte-identical
  and upstream explicitly added Theme 2 support. Peer checks now pass without new peer exemptions.
- Pierre icon owner regeneration reports all 58 PNGs current. MSW worker regenerated through
  its CLI. Expo's 39 selected native packages match, with only the approved Keyboard Controller
  1.21.13 versus SDK default 1.21.9 exception.
- Metro iOS export passed with RaTeX absent. Native prebuild and CocoaPods installation passed;
  final iOS deployment target remains 18.0. Primary simulator rebuild passed on a previously
  shut-down iPhone 17e/iOS 26.5 (C95429D9-9514-4EF7-A6D7-221FC6C577BF), with no pre-existing
  development app installed. Generated iOS project and build products remain ignored/local.
- Server MDX/Pierre compatibility tests passed 8 and server typecheck passed. Actual Electron44
  FFF native fileSearch, mixedSearch and grep each returned the expected isolated-fixture result;
  finder/library/fixture were cleaned. Packaged ASAR acceptance remains pending.


### Integrated verification checkpoint

- Web rendering gate passed 16 files / 153 tests and typecheck. Mobile passed 36 tests and
  typecheck; its approved parser-boundary regression covers native failure and over-limit source
  through the existing selectable text primitive. Math remains disabled; Metro export succeeded
  with RaTeX absent. The owned Fabric bridge is retained.
- The primary agent rebuilt and launched the iOS development app successfully on the isolated
  iPhone 17e/iOS 26.5 simulator. Verified connection, thread navigation, composer draft persistence
  across navigation/restart, long-message scrolling, tables/code/diffs, code clipboard contents,
  an external Electron documentation link opening Safari, and native long-press Markdown selection.
  Software-keyboard occlusion has not been established through available automation.
- The isolated web pass verified rendering/navigation and actual keyboard file editing. It exposed
  a disposed save coordinator retained across React effect replay. The existing hook now creates
  a fresh coordinator for each layout-effect setup and delegates through a stable handle. Four
  existing files / 26 tests and web typecheck pass. Keyboard replacement persisted to disk and
  survived a full page reload after the fix; temporary diagnostics were removed.
- Lexical 0.50.0 emits a development-only read-only selection warning in upstream FOCUS_COMMAND
  handling. Stack inspection found no owned mutating listener; production output does not emit it.
  No dependency downgrade or speculative vendor patch was added.
- The first arm64 DMG build exposed stale transitive node-abi 4.31.0, which does not recognize
  Electron 44 ABI 149. Updated the lockfile to compatible node-abi 4.35.0 within the existing
  declared range and release-age policy. Production staging installation, native rebuild,
  DMG/ZIP/blockmap generation and read-only DMG checksum/mount then passed.
- Launched the actual mounted packaged app using task-owned backend and Chromium state. A scoped
  startup inspector harness redirects the app's production userData assignment before execution;
  installed application files and normal user data are untouched. Unsigned notification delivery
  reports the expected failed event. A final DMG rebuild includes the editor lifecycle fix.
- Packaged native UI automation misdirected a fixture path into a test composer after selecting a
  home-directory project. The provider rejected the request before execution for unavailable
  usage credits. Removed that temporary project through the app's command API and registered the
  intended isolated fixture project. No home-directory files were modified by that attempt.
- The initial packaged restart authentication timeout was traced to synchronous Keychain reads,
  with successful automatic retry and subsequent launch. Packaged clipboard and preview acceptance
  passed as detailed below. Persisted-thread terminal/search probes also passed.

- Final frozen reinstall and peers pass. Read-only probes reconcile all 23 catalog entries,
  94 catalog references, 308 dependency declarations across 16 manifests, and 56 resolution-only
  test declarations with the active lockfile document. All 12 patch files/hashes/registrations and
  installed snapshots match. Mobile React/Effect identity, Atom mount/update/Effect success,
  Scheduler execution/cancellation and unmount listener cleanup pass again on the final graph.
- Final DMG rebuild passed and was checksum-verified, mounted and launched. SHA256:
  `9e5b7f29b18286702476d9dea79128e573ee5d14a04d03bd78414af3981c03dc`.
  Artifact: `release/456code-0.0.28-arm64.dmg`.
- Final packaged launch reconnects and retains the isolated project. Earlier authentication delay
  matches synchronous connection-catalog Keychain reads; retry completed in 5 ms. The renderer's
  HTTP 500 label was a fallback, not an observed backend 500. No authentication workaround added;
  signed-build Keychain startup behavior remains a release check.
- Web/Metro/serve-sim verification processes stopped; the task-owned simulator app stopped and
  simulator shut down. Packaged app and fixture server subsequently stopped and DMG unmounted.
- Owned-source whitespace checks pass. Exact upstream Effect snapshot retains its upstream
  changelog whitespace; no reference-only formatting modifications were introduced.

### Patch disposition

| Patch | Disposition |
| --- | --- |
| Effect beta107 | Rebased; RPC and MCP behavior retained |
| Effect Vitest beta107 | Rebased Vite+ imports/exports; obsolete runner substitution removed after upstream API verification |
| Expo Metro 57.0.12 | Unchanged version and patch retained |
| FFF 0.10.6 | Rebased onto both bundled entrypoints; ASAR native probes pass |
| React Native Menu 2.0.0 | Unchanged version and patch retained |
| Gesture Handler 2.32.0 | Unchanged version and patch retained |
| Keyboard Controller 1.21.13 | Approved native exception and patch retained |
| Screens 4.26.2 | Unchanged version and patch retained |
| LegendList 3.3.10 | Rebased scrolling behavior |
| Pierre Diffs 1.4.1 | Retained required exports; equivalent upstream selection/gutter behavior verified |
| Nitro Modules 0.37.1 | Rebased modules-provider behavior; owned Fabric bridge retained |
| Native Stack 7.18.10 | Rebased custom native navigation behavior |

- Packaged preview snapshot returned the fixture title, text, button selector and accessibility
  tree. Playwright clicked the observed button and the captured artifact shows `Automation
  verified`. PNG copy through the actual packaged IPC handler completed and its clipboard image
  matched all screenshot pixels (966 x 1376). Electron's asynchronous text write/readback also
  passed. The prior clipboard was restored after the probe.
- Snapshot's first image capture took 39.9 seconds; all four CDP operations completed in under
  1 ms. This existing capture path has no timeout and holds the automation semaphore while
  capturing. Record as a capture-latency limitation, without an unrelated source workaround.
- Removed the exact owned root editor fixture after confirming its saved content. Verification
  state, screenshots and build outputs remain ignored/local for review.

- The original checkout now contains concurrent edits in CheckpointReactor, ProviderCommandReactor
  and GitVcsDriver that appeared after the clean intake. They are outside this worktree and were
  neither incorporated nor modified. No commits, staging, publication or installed-app replacement
  were performed.

## Final local result and remaining gates

All four implementation groups are implemented with their focused source gates passed. The final
arm64 DMG includes the last editor lifecycle fix. Frozen reinstall, peer checks, catalog/test
manifest reconciliation, all 12 patch registrations/application snapshots, affected typechecks and
focused suites passed. Full workspace suites, Windows/Linux packaging and hosted CI remain outside
the authorized local verification scope.

Packaged backend acceptance used the actual DMG's running server, with an empty thread created
through its existing command API. PTY output contained the expected marker from a real shell;
terminal close removed metadata, emitted closure and terminated its OS process. Filename search
returned README.md and preview.html; native content search found the expected fixture marker on
README.md line 3. All results were nontruncated. The thread retained zero messages and no provider
session. The primary agent also verified its title in the packaged renderer after reload.

The following are explicit limits, not passed acceptance claims:

- Native long-press Markdown selection passed in a rebuilt simulator client: selection handles and
  the iOS Copy/Look Up/Translate menu appeared over rendered Markdown. Physical keyboard draft
  input, scrolling, navigation, restart persistence, code copy and links also passed. Software-
  keyboard occlusion remains unverified because this headless Xcode installation has no usable
  Simulator.app control surface and the temporary hardware-keyboard preference did not display it.
- Signed notification delivery and signed-build Keychain startup require release verification.
  The final DMG contains an ad-hoc signature with no TeamIdentifier, so it cannot close that gate.
  The unsigned failure event is reported correctly. The observed local Keychain stall recovered.
- One packaged preview screenshot took 39.9 seconds. Playwright extraction/click and final image
  capture/clipboard checks passed; the existing unbounded capture latency remains a follow-up.
- Native desktop accessibility/screenshot capture returned stale views during some automation;
  the live renderer's DOM, backend RPC and captured preview provided the reported verification.
- Provider conformance tests passed; integrated thread rendering used isolated fixtures and does
  not establish a live paid provider response. No provider execution was required for final
  terminal/search acceptance.

All task-owned verification servers, Metro, serve-sim, packaged app, PTY and simulator execution
have stopped. The DMG is unmounted, previous clipboard restored, and the root editor fixture removed.
Ignored artifacts and isolated state remain available for review. The implementation is committed on
`chore/dependency-modernization`; no release publication, EAS submission, or installed-app replacement
was performed.

## PR 101 CI remediation

Approved follow-up: repair Windows bootstrap, install under Node 24 before Cartographer runtime
verification, stage portable release dependencies, preserve telemetry blank opt-outs, regenerate
mobile themes, and scope directive preservation to owned source. Four co-authored commit groups
are authorized, followed by push and hosted CI verification. No merge or release is authorized.

- Group 1 implemented: native Windows VP_HOME paths, root node-gyp 13.0.2, a cold Node 24
  bootstrap/PTY probe in the Node 22 lane, preserved runtime matrix, and owned-source directive guard.
- Groups 2-4 pending. Final hosted CI and isolated mobile appearance acceptance pending.

Group 1 local gate: frozen installation under Node 24.20.0 passed; four directive regression
tests, directive comparison against origin/main, targeted formatting/comment checks and lint
passed (one pre-existing intentional literal-concatenation warning). Windows execution and the
uncached Ubuntu Node 24 bootstrap/PTY probe remain hosted gates. The Node 22 lane deliberately
disables setup cache so native installation cannot pass solely through reused build results.
