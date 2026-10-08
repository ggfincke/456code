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
without launching Finder or the application.

Scheduled installation requires a human-approved merged upstream-sync PR and passing quality
CI on the exact current `origin/main` commit. A verified artifact waits when the installed app or
its helpers are running, or when their absence cannot be reliably established. Preserve a
verified recovery copy before replacing the closed bundle, verify installed files and the
embedded source revision, and leave the app closed. Do not migrate or modify profile data.
Artifact and installed-file checks do not establish interactive client acceptance.
