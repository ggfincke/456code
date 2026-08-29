---
name: test-t3-mobile
description: Launch and test 456code Mobile on an iOS Simulator against disposable local T3 environments, including Metro and dev-client reuse, native rebuild decisions, per-client pairing, seeded projects, semantic UI control, screenshots, and serve-sim streaming. Use after mobile UI or native changes, when reproducing iPhone or iPad behavior, pairing a simulator to isolated state, or verifying mobile behavior on macOS.
---

# Test T3 Mobile

Run one focused, end-to-end mobile verification pass against disposable T3 state. Use the sibling [`test-t3-app`](../test-t3-app/SKILL.md) skill as the detailed reference for pairing-token semantics and SQLite fixtures.

## Confirm iOS tooling

Inspect the host and the affected code before launching processes:

- Use one representative iOS Simulator so the user can watch through serve-sim when available.
- Load and follow [`ios-debugger-agent`](../ios-debugger-agent/SKILL.md), and load [`ios-simulator-browser`](../ios-simulator-browser/SKILL.md) when live streaming is available.
- When the required Xcode, simulator runtime, or development client is unavailable, report the missing prerequisite rather than claiming verification.

## Choose the lightest valid launch path

- For JavaScript, TypeScript, or asset-only changes, reuse a compatible installed development client and start Metro. Do not rebuild native code merely to load a new bundle.
- For native source, native dependencies, entitlements, config plugins, or generated project changes, rebuild the iOS app.
- Use `vp run ios:dev` only when an Expo clean prebuild is actually required; it regenerates the native project.
- If the user requested no native rebuild and no compatible app is installed, reuse an existing compatible `.app` artifact when available. Otherwise report the missing dev client instead of silently rebuilding.

The development identity is:

- App: `456code Dev`
- Bundle identifier: `com.ggfincke.code456.dev`
- URL scheme: `code456-dev`

Bundle presence proves the correct variant, not native compatibility. Reuse it only when the current changes did not alter its Expo SDK, native dependencies, config plugins, entitlements, generated project, or native source.

## Start one disposable T3 environment

Run backend commands from the repository root. Use the ignored, worktree-local `.456code` directory or create a fresh directory with the host OS's temporary-directory mechanism. An explicit base directory stores state in `<base-dir>/userdata`; never point testing at shared `~/.456code` state.

Seed a small number of meaningful Git projects before starting the backend:

```bash
node apps/server/src/bin.ts project add <git-workspace> \
  --base-dir <base-dir> \
  --title <project-title>
```

Running `project add` before the backend starts gives it exclusive offline database access. If a backend is already running, wait until it is ready so the CLI dispatches through the live server; never run offline mutations concurrently with the server.

Use direct SQLite mutation only for disposable projection fixtures. Follow `test-t3-app` and stop the backend before writing.

Start a headless backend after seeding:

```bash
node apps/server/src/bin.ts serve \
  --host 127.0.0.1 \
  --port <server-port> \
  --base-dir <base-dir> \
  --no-browser
```

Use `http://127.0.0.1:<server-port>` for an iOS Simulator. For a physical iOS device, bind the
backend to `0.0.0.0` and use the host's reachable LAN origin.

Always enter the complete `http://` origin; the mobile host field otherwise assumes HTTPS. When testing web and mobile together, run `vp run dev --home-dir <base-dir> --host 127.0.0.1` instead and do not launch a second backend over the same base directory.

## Start or reuse Metro safely

Run Metro from `apps/mobile`.

1. Inspect any process on the intended Metro port and its `/status` response. Reuse it only when it is healthy, belongs to this worktree, and matches `APP_VARIANT=development`, `--dev-client`, and scheme `code456-dev`.
2. Never kill another worktree's Metro. Use a free explicit port when necessary.
3. Run `vp run dev:client` on the standard port. For another port, retain the complete development identity:

   ```bash
   APP_VARIANT=development vp exec expo start \
     --dev-client \
     --scheme code456-dev \
     --clear \
     --lan \
     --port <metro-port>
   ```

4. Open the exact development-client URL for the selected device and confirm the loaded bundle belongs to this worktree and Metro port.

### Launch the iOS app

Use `ios-debugger-agent` to select one UDID and set these XcodeBuildMCP session defaults:

- Workspace: `<repo>/apps/mobile/ios/456codeDev.xcworkspace`
- Scheme: `456codeDev`
- Configuration: `Debug`
- Simulator ID: the selected UDID
- Bundle ID: `com.ggfincke.code456.dev`

Check the installed client with:

```bash
xcrun simctl get_app_container <simulator-udid> com.ggfincke.code456.dev app
xcrun simctl openurl <simulator-udid> <printed-dev-client-url>
```

Accept the iOS confirmation prompt and dismiss the developer menu when it obscures the app. Do not
start, stop, erase, or reconfigure a simulator owned by another task. Track and later stop only
processes owned by this test.

## Pair each client once

Issue a fresh credential against the running backend's exact base directory:

```bash
T3CODE_PORT=<server-port> node apps/server/src/bin.ts auth pairing create \
  --base-dir <base-dir> \
  --base-url <mobile-origin> \
  --ttl 15m \
  --label agent-mobile-<short-device-id>
```

If the visible Add Environment action is not exposed as a semantic target, open the app's registered route instead of guessing coordinates:

```bash
xcrun simctl openurl <simulator-udid> 'code456-dev://connections/new'
```

In 456code Dev, open Add Environment and enter the complete `<mobile-origin>` and newly printed `Token`. Verify the expected seeded projects appear before exercising the affected flow.

Pairing credentials are secret, short-lived, and single-use. Create a different credential for every simulator, physical device, or browser. If an attempt fails, issue a new credential rather than retrying the old one. Do not expose tokens in screenshots, commits, or final responses.

## Drive and observe the affected flow

Use `snapshot_ui` and current element references from XcodeBuildMCP for taps and typing. Stream the same UDID through `ios-simulator-browser` so the user can watch in 456code when the host supports it. Use the stream as a visual feed rather than a reason to switch to fragile browser coordinates.

## Verify and clean up

Exercise only the affected flow on one representative device unless the change specifically concerns platform, OS version, or screen size. Follow the shared environment lifecycle in `test-t3-app`: keep a backend only while the identified web/mobile verification or explicitly requested human review is still active, then stop owned processes as required by `AGENTS.md`. Finishing mobile alone does not authorize stopping a backend still needed by web.

At the end of that focused loop:

1. Confirm the app connected to the intended disposable environment instead of merely rendering an empty disconnected state.
2. Capture the relevant final state.
3. Remove the disposable environment from 456code Dev when it is no longer needed for the identified review window.
4. Stop only the serve-sim, Metro, backend, simulator, and log processes started by this test after their participating client checks finish; never stop another task's processes.
5. Remove only base directories and temporary Git repositories deliberately created for this test. Preserve them when they contain useful reproduction evidence.

Preserve useful base-directory state for restart rather than keeping processes alive for unspecified future work. Keep local verification focused. Do not turn this workflow into a full repository test run.

## Troubleshoot predictable failures

- **Old UI or an old error appears:** verify Metro's worktree, variant, URL, and port before diagnosing the app.
- **The environment remains empty:** verify the iOS HTTP origin, use a fresh token, and confirm project seeding used the identical base directory.
- **A second client cannot pair:** pairing tokens are single-use; issue another token.
- **iOS semantic actions fail:** set explicit XcodeBuildMCP defaults and refresh with `snapshot_ui`.
