# 456code

456code is my personal agent orchestration platform, derived from T3 Code. I'm building it around directing agents on furnace from my Mac desktop app, native iPhone app, or browser over a private network or tailnet. Local Mac hosting is an explicit option; iPad support follows useful upstream work.

[Guiding principles](docs/principles.md) define product scope, privacy requirements, provider priorities, and how regular T3 updates are evaluated. They describe the intended product; the current application still contains upstream behavior that needs separate implementation work.

## Builds

There are no published releases, installers, or store apps. Desktop builds are staged on each host from `origin/main` and installed through the app's update pill; the iPhone app is built locally. See [local packaging and staged updates](docs/operations/release.md).

Install and authenticate at least one provider on the host before starting a thread:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
- Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
- Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

## Documentation

Full docs live in [docs/](./docs).

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)

For local development, use the [development runbook](docs/operations/development.md). Fork integration details are in the [fork operations record](docs/operations/thin-fork.md), and architecture starts at [docs/internals/overview.md](./docs/internals/overview.md).

## T3 Code

456code is derived from [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc. and merges its improvements regularly. It keeps T3 Code's MIT license; see [LICENSE](./LICENSE).
