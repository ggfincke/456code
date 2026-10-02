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

```sh
pnpm run dist:desktop:dmg:arm64
pnpm run dist:desktop:dmg:x64
pnpm run dist:desktop:linux
pnpm run dist:desktop:win:x64
pnpm run dist:desktop:win:arm64
```

The desktop uses the 456code identity, profile and protocol. Artifact names follow
`456code-thin-<version>-<arch>.<extension>`, publishing is disabled, and native/server self-updates
remain disabled. Building an artifact does not install it or migrate an existing profile.

Use `--output-dir` to choose a destination, `--keep-stage` to retain staging files, or `--skip-build`
to package existing build outputs. Inspect all options with:

```sh
pnpm run dist:desktop:artifact --help
```

Windows WSL support requires an independently built Linux CLI archive supplied as `--wsl-runtime`.
Build and smoke-check CLI archives through the retained [CLI builder](../../apps/server/scripts/cli.ts),
[archive builder](../../scripts/build-cli-archive.ts), and
[archive smoke tool](../../scripts/smoke-cli-archive.ts). These local tools do not configure a fork
release destination or publish packages.

## Validate packaging helpers

```sh
pnpm run release:smoke
```

This command checks isolated version, lockfile, nightly and update-manifest fixtures. It does not
publish, install an application, or inspect a live database. Use focused existing tests and scoped
build/type checks for the packaging behavior being changed. Local success does not establish
hosted CI, cross-platform execution, signing, or interactive client acceptance.

## Optional local signing

Unsigned builds are the default. Add `--signed` only after configuring local platform credentials
for the actual artifact identity.

For macOS, electron-builder consumes the signing certificate through `CSC_LINK` and
`CSC_KEY_PASSWORD`; notarization uses `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
Passkey provisioning additionally uses `T3CODE_APPLE_TEAM_ID`,
`T3CODE_MACOS_PROVISIONING_PROFILE` (a local profile path), and Clerk RP-domain configuration.
See [desktop passkey setup](connect-setup.md#desktop-passkeys) for the local procedure. Match the
certificate/profile and Associated Domains entitlement to the application's actual bundle ID.

For Windows, configure Azure authentication and the existing packager inputs:
`AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
`AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
A local build with `--signed` must be checked on its target host; no signing or publication
credentials are configured by CI in this fork.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship
`resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar: the Linux CLI archive
(`t3-<version>-linux-<arch>.tar.gz`, the same arch as the Windows host) built
locally on Linux and supplied to the Windows artifact builder through
`--wsl-runtime`. The builder copies it verbatim. WSL verifies and extracts that archive
into `~/.t3/wsl-runtime/sha256-<archive-digest>` inside the selected distro,
then reuses it for later launches of the same update.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only
native libraries and helper executables. Avoid enabling whole-package smart
unpacking: each loose file adds work to NSIS installation and counts against
the payload limit.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build given `--wsl-runtime` omits the WSL archive or SHA-256
  sidecar, or the sidecar digest does not match the emitted archive.
- The emitted WSL archive is not a Linux CLI release archive: it must unpack to
  a single `t3-<version>-linux-<arch>` directory holding `t3`, `client/`, and
  `node_modules/` with the Linux node-pty binary, and must not carry a loose
  server bundle (`bin.mjs`).
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each intended target must exercise the primary native-load probe.

## Upstream publication reference

T3 Code's hosted release process is maintained in the
[upstream release runbook](https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md).
Its production services, credentials and automation apply to upstream.
