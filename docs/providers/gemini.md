<!-- docs/providers/gemini.md -->
<!-- how to set up and use the built-in Gemini provider -->

# Gemini

Gemini is a built-in 456code provider backed by the official open-source
[Google gemini-cli](https://github.com/google-gemini/gemini-cli) running in its documented ACP
mode (`gemini --acp`). It is a distinct provider from [Antigravity](./antigravity.md) and ships
disabled by default. See the official [ACP mode documentation](https://geminicli.com/docs/cli/acp-mode/)
and [CLI reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md)
for the upstream protocol and command surface.

## What is supported?

- Multi-turn text sessions with streaming output.
- Tool approvals through the standard 456code approval flow.
- Session cancel and interruption.
- Image attachments from the managed 456code attachment store.
- Thread continuation through gemini-cli session persistence, using a replay-gated `session/load`.
- Best-effort model inventory and guarded in-session model switching through `session/set_model`
  when the CLI advertises the unstable model method.
- Runtime modes and plan interaction when ACP advertises the exact `default`, `autoEdit`, `yolo`,
  and `plan` mode IDs. Until a session confirms those modes, 456code advertises only the
  conservative `approval-required` and default-interaction fallback.
- One-shot text generation for the required 456code text-generation surface.

## What is not supported?

Conversation rollback, active-turn input, and structured user-input prompts are not supported.
Gemini does not accept a second 456code turn while a prompt is running, and it does not expose
Antigravity's `agy` stream-json protocol. Runtime and interaction modes not confirmed by the live
ACP session remain unavailable.

## Installation

Install the official gemini-cli using one of the following:

```bash
npm install -g @google/gemini-cli
brew install gemini-cli
```

The [official npm package](https://www.npmjs.com/package/@google/gemini-cli) is another install
reference.

Verify the binary is on your `PATH`:

```bash
gemini --version
```

## Enabling Gemini in 456code

1. Open **Settings → Providers**.
2. Select **Add provider instance**, choose **Gemini**.
3. Configure:
   - **Binary path** — defaults to `gemini`; point it at another executable if needed.
   - **Environment variable `GEMINI_API_KEY`** — optional sensitive provider-instance variable.
     It is passed only to that instance; leave it absent to reuse an existing gemini-cli login.
4. Enable the instance with its toggle. Status probes run `gemini --version` only; ACP starts on
   real turns.

## Authentication

gemini-cli advertises its authentication methods over ACP `initialize`. For an instance with a
configured `GEMINI_API_KEY`, 456code selects the advertised API-key method, gives that instance an
isolated `GEMINI_CLI_HOME`, and authenticates through ACP. For an existing CLI login, 456code
strips ambient `GEMINI_API_KEY` and `GOOGLE_API_KEY` and skips `authenticate`, leaving gemini-cli's
own login state in control. Complete any browser-based sign-in by running `gemini` once in a
terminal before enabling the instance.

456code does not share credentials with Antigravity, extract Google tokens, or call a Google
backend directly. The official CLI remains the owner of authentication and native session files.

## Account usage

The current Gemini CLI integration does not expose account quota percentages or reset times to
456code. Enabled instances show “Gemini account limits aren’t available through this integration.
Check /stats in Gemini CLI.” in the model picker and Usage popover.

Run `/stats` inside the interactive Gemini CLI to inspect the usage it reports. 456code keeps
version-only health probes: it does not send headless `/stats` prompts, scrape terminal output, or
read Google credentials to obtain account limits. This limitation does not block sending.

## Troubleshooting

- **"is not installed or not on PATH."** — check `gemini --version` in your shell,
  or set the binary path explicitly in the instance settings.
- **Startup error mentioning authentication method ids** — your gemini-cli version advertises
  different method ids. Update gemini-cli; the error lists the advertised ids.
- Model switching silently unavailable — older releases lack `session/set_model`; update to a
  current stable release.
