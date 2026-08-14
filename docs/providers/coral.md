# Coral

This guide is for people who want to run Coral, a local Ollama coding agent, inside 456code.

Coral is Early Access and disabled by default. 456code talks to it over ACP (`coral acp`). It does
not ship the Coral CLI; you install that yourself.

## Install Coral Manually

Coral currently runs from a source checkout. You need Node.js 24 or newer, a running
[Ollama](https://ollama.com/) server, and at least one model already pulled.

```bash
git clone https://github.com/ggfincke/coral.git
cd coral
npm install
npm run build
```

The compiled CLI is `dist/cli/main.js`. Point 456code at that file, or put a `coral` executable on
a stable path and set **Binary path** to it.

Use an explicit binary path in Settings. A `coral` resolved through a mismatched Node or mise PATH
can hang on `coral --version`, which is also how 456code probes the CLI.

## Enable Coral In 456code

Open Settings → Providers. Coral shows an Early Access badge and starts off.

```text
Display name: Coral
Binary path: /path/to/coral
Ollama host: http://localhost:11434
CORAL_HOME path: ~/.coral
```

Turn the Coral switch on. Authentication is not applicable: Coral is local. Status refresh only
runs `coral --version`; it does not create a Coral session.

An empty **CORAL_HOME path** uses `~/.coral`. Set a dedicated directory when you want 456code
sessions isolated from your interactive Coral TUI.

## Ollama Networking

Every model request goes to the Ollama host you configure. The default is
`http://localhost:11434`.

If Ollama is on another machine or port, set **Ollama host** to that HTTP or HTTPS URL. Prompts,
attached files, tool results, and conversation context are sent to that host.

456code does not start Ollama. Pull a model first:

```bash
ollama pull gemma4:31b-mlx
```

Before a Coral session starts, 456code advertises the fallback model `gemma4:31b-mlx`. Once a
session is open, Coral reports the models actually installed on that Ollama host.

## No Telemetry

Coral has no cloud inference API and no remote telemetry. Reliability counters stay in local files
under `CORAL_HOME`. 456code does not upload Coral session or telemetry files.

If **Ollama host** points at a non-local server, that host is a separate data boundary for prompts
and tool context.

## What Early Access Does Not Include

This 456code Coral release does not support:

- Orchestrate
- HTTP MCP / 456code session MCP injection
- Conversation rollback
- Images
- Session list, load, or import
- `coral doctor`

It does support text turns, approvals, idle model switch, cancel, multi-turn conversations, and
native `session/resume`.
