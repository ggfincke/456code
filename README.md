# 456code

456code is a minimal web GUI for coding agents (currently Codex, Claude, Cursor, and OpenCode, more coming soon).

## Installation

> [!WARNING]
> 456code currently supports Codex, Claude, Cursor, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

456code is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). It is not published to npm, Homebrew, winget, or the AUR, and there are no release downloads — build it from source.

### Build and run from source

```bash
vp i && vp run build
```

Then start the server:

```bash
node apps/server/dist/bin.mjs
```

Tip: add `--help` for the full CLI reference. The CLI is named `456code` once linked; see [Install `vp`](#install-vp) below if you don't have Vite+ yet.

### Desktop app

Build a desktop artifact for your platform:

```bash
vp run dist:desktop:dmg
```

Substitute `dist:desktop:linux` or `dist:desktop:win` on other platforms; see [scripts reference](./docs/reference/scripts.md) for the full list.

## Some notes

We are very very early in this project. Expect bugs.

This is a personal fork. Upstream is not accepting contributions, and neither is this.

There's no public docs site yet, checkout the miscellaneous markdown files in [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Remote access](./docs/user/remote-access.md)
- [Keeping 456code in sync](./docs/user/server-updates.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)

## If you REALLY want to contribute still.... read this first

### Install `vp`

456code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
