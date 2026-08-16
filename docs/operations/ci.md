# CI quality gates

- `.github/workflows/ci.yml` runs `vp check` (format check + lint + typecheck), `vpr typecheck`, and `vp run test` on pull requests and pushes to `main`.
- The same CI workflow builds two unsigned x64 NSIS installers on GitHub-hosted `windows-2025`, then a separate hosted consumer exercises installation, packaged backend/native loading, a real Cartographer CLI graph build, differential and fallback updates, stale cleanup, and uninstall. See [Hosted Windows acceptance](./release.md#hosted-windows-acceptance) for the exact boundary.
- `.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`) desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release.
- The release workflow auto-enables signing only when platform credentials are present. macOS passkey builds additionally require `APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows uses Azure Trusted Signing. Without the core signing credentials, it still releases unsigned artifacts.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.
