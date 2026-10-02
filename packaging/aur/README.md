# AUR packaging

This directory maintains the [`t3code-bin`](https://aur.archlinux.org/packages/t3code-bin) and
[`t3code-nightly-bin`](https://aur.archlinux.org/packages/t3code-nightly-bin) packages. Both
repackage the official x86_64 AppImage from GitHub Releases.

## Publishing

These recipes target upstream T3 Code releases. This fork does not publish AUR packages through
GitHub Actions; see [local packaging](../../docs/operations/release.md) for fork artifacts.

The retained `packaging/aur/scripts/release.sh` selects the stable or nightly upstream package,
updates its version and checksums, builds it, and regenerates `.SRCINFO`. It pushes to the AUR only
when `AUR_SSH_PRIVATE_KEY` is configured.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v0.0.33 \
  packaging/aur/scripts/release.sh
```
