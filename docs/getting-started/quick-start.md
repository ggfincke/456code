# Quick start

456code uses [Vite+](https://viteplus.dev/guide/), so you need the global `vp` command:

```bash
curl -fsSL https://vite.plus | bash
```

On Windows, use `irm https://vite.plus/ps1 | iex` instead. Without a global install, prefix
every command below with `pnpm exec`.

Install dependencies once:

```bash
vp i
```

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
