<!-- docs/getting-started/quick-start.md -->
<!-- install the development toolchain and run the application -->

# Quick start

Use Node 24.20.0 LTS or a later Node 24 release. The repository pins pnpm 12.3.4 and
[Vite+](https://viteplus.dev/guide/) 0.3.0. Install the matching global `vp` command:

```bash
curl -fsSL https://vite.plus | env VP_VERSION=0.3.0 bash
```

On Windows, use PowerShell:

```powershell
$env:VP_VERSION = "0.3.0"
irm https://vite.plus/ps1 | iex
```

Install dependencies once:

```bash
vp install --frozen-lockfile
```

Vite+ downloads the pinned native pnpm executable. Older Vite+ releases before 0.2.8 cannot
bootstrap pnpm 12.

Without a global Vite+ install, bootstrap through the compatible Corepack release:

```bash
npx --yes corepack@0.36.0 pnpm install --frozen-lockfile
```

Then prefix the `vp` commands below with `npx --yes corepack@0.36.0 pnpm exec`. This uses cached
tools without replacing a global pnpm or Corepack installation. Older Corepack installations
may look for the removed `bin/pnpm.cjs` entry point.

CI explicitly selects `~/.vite-plus` through `VP_HOME` before `setup-vp`, keeping its executable
discovery consistent with Vite+ 0.3's single-root layout. EAS profiles separately pin Node 24.20.0
and pnpm 12.3.4 with Corepack disabled, so EAS provisions pnpm before dependency installation.
An `eas-build-pre-install` hook cannot repair an incompatible pnpm bootstrap because EAS runs
that hook through pnpm too. Keep the EAS pnpm pin aligned with the root `packageManager` field.

## Commands

```bash
# Development (with hot reload)
vp run dev

# Desktop development
vp run dev:desktop

# Desktop development on an isolated port set
T3CODE_DEV_INSTANCE=feature-xyz vp run dev:desktop

# Production
vp run build
vp run start
```

`vp run start` runs the built server. You can also invoke the bundle directly, which is
useful when pointing it at another working directory:

```bash
node apps/server/dist/bin.mjs --help
```

## Desktop artifacts

The macOS desktop app requires macOS 13 (Ventura) or later, matching the
[Electron 44 minimum](https://www.electronjs.org/blog/electron-44-0#removed-macos-12-support).

Fetch the Electron runtime first, then build for your platform:

```bash
vp run --filter @t3tools/desktop ensure:electron
```

```bash
vp run dist:desktop:dmg
```

Substitute `dist:desktop:linux` or `dist:desktop:win` on other platforms. See the
[scripts reference](../reference/scripts.md) for the full list.

> [!NOTE]
> The commands above are the documented development path for building from source. Published
> releases also provide the `456code` npm package, including the `npx 456code@latest` entry point.
