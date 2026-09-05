<!-- docs/user/provider-updates.md -->
<!-- explains safe provider update availability and manual fallback -->

# Provider updates

When an installed provider CLI is behind its latest release, its card under **Settings ->
Providers** shows the available version. The version notice remains visible even when 456code cannot
safely update that installation for you.

**Update now** appears only when the server can prove which installer owns that specific provider
instance. Supported ownership includes native provider installs, Homebrew formulae and casks, and
global npm, pnpm, Bun, or Vite+ installs. The update runs on the provider's machine with that
instance's configured environment.

If the card does not show **Update now**, update the CLI using the same tool and environment that
installed it. This is expected for missing executables, mise-managed provider tools (including shims
from a Homebrew-installed mise), unrecognized custom installation layouts, unresolved binary paths,
and other layouts where automatic ownership cannot be proven. Refresh provider status after the
manual update. npm globals installed inside a mise-managed Node version still use the owning npm
prefix and can be eligible.

Homebrew-backed providers compare against the version Homebrew offers, which can temporarily trail
another package registry. 456code also checks ownership again before execution and refuses to run if
the installation changed after the card was loaded.
