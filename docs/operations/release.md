# Local packaging and validation

> For maintainers. Using 456code? See [docs/user](../user/).

This fork retains local desktop and CLI packaging tools. CI runs code/build checks, manual Windows
compatibility tests, and advisory mobile fingerprints on standard GitHub runners. Automated
release publishing, deployment, hosted previews, store submission, and upstream administration
workflows have been removed.

## Build desktop artifacts

Follow the [development prerequisites](development.md#desktop-artifacts) for the target platform.
The artifact builder runs the required desktop/server/web builds and writes unsigned artifacts to
`release/` by default:

```bash
pnpm install --frozen-lockfile
export PATH="$(dirname "$(command -v node)"):$PWD/node_modules/.bin:$PATH"
pnpm --filter @t3tools/cartographer-core build
pnpm run dist:desktop:dmg:arm64 --output-dir /absolute/path/to/artifacts
```

Use the Node version required by `package.json`. Keep its directory ahead of the local binaries
so a packaging subprocess uses the supported runtime. Choose `dist:desktop:dmg:x64` on Intel
macOS. Linux and Windows packaging commands and their target-specific prerequisites are listed
in `package.json` and [development](development.md#desktop-artifacts); Windows requires the
matching Linux CLI archive for its WSL payload.

Build from a clean, pinned source revision. Do not use `--skip-build` when validating a new
revision. The builder validates package self-containment and writes the source commit prefix to
`app.asar`'s `package.json` as `t3codeCommitHash`. Confirm the bundle identifier, architecture and
embedded revision against the intended source, then verify the generated artifact. The fork
keeps its existing unsigned packaging policy; packaging success is not signing or notarization.

## Validate and install locally

Run the relevant existing packaging helper tests and `pnpm run release:smoke`. Add the local
binary directory to `PATH` for smoke subprocesses. Keep runtime smoke state disposable and
separate from the installed application's profile. Inspect a DMG through a read-only mount
without launching Finder or the application. Day-to-day installs go through staged updates
below rather than a manually copied artifact.

## Staged updates

The desktop app updates itself only from a build staged on the same machine; nothing is
published. Every 15 minutes `scripts/fincke-stage-update.ts` checks `origin/main`. Once CI has
passed on a new commit, it builds the app in a temporary sibling checkout, numbers it
`0.1.<main commit count>`, and stages it under `~/.456code-thin/updates/<linux|mac>/` with a
`manifest.json` written last. It never installs or restarts anything.

The running app's updater (`apps/desktop/src/fincke/StagedUpdater.ts`) offers that build through
upstream's update flow. Its own update pill installs it locally. A host also announces it to
connected clients (`hostAppUpdate` on the server config stream), so the sidebar update pill on
web and desktop, and the environment screen on iOS, can start the remote install. Installing
moves the staged build over the running AppImage or `.app` once the app has quit, then relaunches
it; clients reconnect on their own. There is no recovery copy: rebuild an older commit instead.

Set up each host once. The timer runs the stager from its own checkout, which it moves to
`origin/main` before every run, so a feature branch in the main checkout never changes it:

```bash
git -C ~/Projects/Applications/456code worktree add --detach ../456code-stager origin/main
(cd ~/Projects/Applications/456code-stager && vp i --frozen-lockfile)
```

The `node` on the timer's `PATH` (mise shims) only runs the stager. Builds use the exact version
`package.json` pins, which must already be installed with mise.

On furnace (Linux, AppImage at `~/Applications/456code.AppImage`):

```bash
cp infra/fincke-stage-update/456code-stage-update.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now 456code-stage-update.timer
journalctl --user -u 456code-stage-update.service
```

On the Mac (installed in `/Applications`), the LaunchAgent runs in the logged-in session:

```bash
sed "s|__HOME__|$HOME|g" infra/fincke-stage-update/dev.fincke.456code-stage-update.plist \
  > ~/Library/LaunchAgents/dev.fincke.456code-stage-update.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dev.fincke.456code-stage-update.plist
tail -f ~/Library/Logs/456code-stage-update.log
```

### iPhone

The stager also exports the iOS JavaScript bundle for the same commit and stages it under
`~/.456code-thin/updates/ios/`. The server serves it as an Expo Updates endpoint at
`/api/fincke/ios-update/manifest`, unauthenticated because `expo-updates` cannot carry a
session. The app's `updates.url` points at furnace over the tailnet, and upstream's updater
checks on launch and on foreground, then installs in the background. Five taps on the version
in About checks right away; an installed bundle shows its `0.1.<count>` build beside the
version.

A bundle only reaches a binary whose native fingerprint matches its `runtimeVersion`, so a
commit that changes native code (Swift modules, config plugins, native dependencies or the app
config) needs a native install from the Mac. Build it from a clean `origin/main` checkout so
the binary's fingerprint matches what the stager computes:

```bash
cd apps/mobile && vp run ios:release
```

Do not migrate or modify profile data as part of an update.
