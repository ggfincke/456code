<!-- docs/providers/antigravity.md -->
<!-- how to set up and safely use the experimental Antigravity provider -->

# Antigravity

Antigravity is an Experimental built-in provider backed by Google's official
[Antigravity CLI](https://github.com/google-antigravity/antigravity-cli). It is a distinct provider
from [Gemini](./gemini.md). 456code keeps one `agy` process open per active thread and exchanges
newline-delimited JSON using the documented
`agy --input-format stream-json --output-format stream-json` surface. The provider ships disabled
by default and requires `agy` 1.1.15 or newer. See the official [CLI overview](https://antigravity.google/docs/cli/overview),
[CLI product page](https://antigravity.google/product/antigravity-cli), and
[release history](https://github.com/google-antigravity/antigravity-cli/releases).

## What is supported?

- Multi-turn text sessions with streaming assistant output.
- Tool, checkpoint, usage, and delegated-agent activity in the 456code timeline.
- Exact continuation through Antigravity's opaque `conversation_id`.
- Opaque model selection and optional agent selection at process startup.
- `auto-accept-edits` mode and acknowledgement-gated `full-access` mode.
- One-shot text-generation jobs through `agy -p ... --output-format json`.

## What is not supported?

Headless Antigravity does not provide an interactive approval or user-input round trip. Active-turn
input, conversation rollback, native attachments, and in-session model or interaction-mode
switching are unsupported. A second message is rejected while a turn is running; 456code does not
steer or queue it inside the provider. Orchestration is delivered as a prompt prefix, not as a
native provider control channel.

## Installation

Install and authenticate the official CLI, then confirm its version and required flags:

```bash
agy --version
agy
# The persistent runtime must advertise both stream-json flags.
agy --help | rg -- '--input-format|--output-format'
```

456code reuses the official CLI's existing login and configuration. It does not read, export, or
extract the CLI's tokens. It does not share credentials with Gemini, call a direct Google backend,
or use a Python SDK/sidecar.

## Enabling Antigravity in 456code

1. Open **Settings → Providers**.
2. Select **Add provider instance**, choose **Antigravity (Experimental)**, and set the binary path
   if `agy` is not on `PATH`.
3. Optionally configure an Antigravity agent or sandbox. Model IDs remain opaque provider values;
   456code does not interpret them.
4. Enable the instance. The server verifies the minimum version and persistent-stream flags before
   starting a provider session.

Model and agent discovery are best-effort. A temporary discovery failure marks the provider as
limited but preserves configured values so the CLI remains the authority on whether they are valid.

## Runtime safety

`auto-accept-edits` is the default and launches Antigravity with `--mode accept-edits`.
`full-access` launches it with `--dangerously-skip-permissions`; because 456code cannot review
individual headless tool calls, the server rejects a full-access start unless the client supplies
the exact capability acknowledgement `antigravity-full-access-v1`. Direct RPC callers must supply
the same acknowledgement. Sandbox selection is independent and remains enabled by default.

Fine-grained permission rules stay in Antigravity's own configuration. 456code never rewrites them.

## Continuation and recovery

456code resumes only with the exact `conversation_id` returned by the CLI and requires the next
`init` event to match it. If a child exits during a turn, that turn is completed once as interrupted
or failed and is never replayed: a tool may already have produced side effects before the process
ended. The runtime makes one bounded resume attempt for later work.

## Integration boundary

This integration drives only the documented official executable. Antigravity is not ACP: its
provider runtime is the persistent NDJSON stream-json process described above. It does not use a
Python SDK sidecar, extract OAuth credentials, call internal Antigravity services, or redirect
Gemini CLI to an Antigravity backend. If Google adds native ACP support later, the implementation
can change without changing Antigravity's provider identity or persisted threads.
