# 456code docs

The [456code guiding principles](./principles.md) define what I want from this platform and how I evaluate upstream changes. The [fork operations record](./operations/thin-fork.md) preserves existing local integration details. The T3 guides below are retained upstream references; hosted services and installation instructions may not apply to this fork.

## Using T3 Code

- [Install T3 Code](./user/install.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Projects with several repositories](./user/multi-repo-projects.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Voice input](./user/voice-input.md)
- [Text generation models](./user/text-generation.md)
- [SnapShots](./user/snap-shot.md)
- [Visual replies](./user/html-renders.md)
- [Import browser sessions](./user/browser-import.md)
- [Use T3 Code as your default browser](./user/default-browser.md)
- [Devices](./user/devices.md)
- [Usage and limits](./user/usage.md)
- [Secrets](./user/secrets.md)
- [Diagnostics and resource monitoring](./user/telemetry.md)
- [Remote access](./user/remote-access.md)
- [Outside agents (MCP)](./user/outside-agents.md)
- [Updating T3 Code](./user/updating.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [Antigravity](./user/providers-antigravity.md) · [Kiro](./user/providers-kiro.md) · [Pi](./user/providers-pi.md) · [Muse Code](./user/providers-muse.md) · [fx](./user/providers-fx.md)

---

## Working on T3 Code

Start with the [development runbook](./operations/development.md).

Internal docs preserve architectural decisions, trust boundaries, conventions, and cross-cutting
traps that the source alone does not explain. Most code changes do not need an internal
documentation update. Follow the [documentation rules](../AGENTS.md#documentation) before adding
anything.

### Internals (in reading order)

- [00 · Glossary](./internals/00_glossary.md)
- [01 · Architecture](./internals/01_architecture.md)
- [02 · Effect services](./internals/02_effect-services.md)
- [03 · Providers](./internals/03_providers.md)
- [04 · Environment auth](./internals/04_environment-auth.md)
- [05 · Remote environments](./internals/05_remote.md)
- [07 · Server updates](./internals/07_server-updates.md)
- [09 · Connection runtime](./internals/09_connection-runtime.md)
- [10 · Web UI](./internals/10_web-ui.md)
- [11 · Mobile layout](./internals/11_mobile-layout.md)
- [12 · Mobile navigation](./internals/12_mobile-navigation.md)
- [13 · Mobile development lifecycle](./internals/13_mobile-development.md)
- [14 · Translating the UI (i18n)](./internals/14_i18n.md)
- [15 · Testing](./internals/15_testing.md)
- [16 · Performance regression checks](./internals/16_performance-regressions.md)
- [17 · Scripts](./internals/17_scripts.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [Local packaging and staged updates](./operations/release.md)
- [Observability](./operations/04_observability.md)
- [Coral setup](./operations/coral-setup.md)
