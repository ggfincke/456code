<!-- .plans/31-gemini-provider-integration.md -->
<!-- track the first-class Google CLI providers and their sequential review gates -->

# First-Class Google CLI Providers

## Status

**Active — implementation approved 2026-08-22; closeout remains validation-gated.** This plan
covers two distinct built-in providers, both disabled by default:

- **Gemini** — the official open-source [Google gemini-cli](https://github.com/google-gemini/gemini-cli)
  in ACP JSON-RPC stdio mode: `gemini --acp`.
- **Antigravity (Experimental)** — the official [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli)
  in persistent NDJSON mode: `agy --input-format stream-json --output-format stream-json`,
  requiring `agy` >= `1.1.15`.

The implementation is not closed by source presence alone. This ledger records the required
review slices and actual gates; no gate is marked passed here unless its evidence is recorded.

## Official protocol references

- [Gemini CLI ACP mode](https://geminicli.com/docs/cli/acp-mode)
- [Gemini CLI command reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md)
- [Antigravity CLI overview](https://antigravity.google/docs/cli/overview)
- [Antigravity CLI product page](https://antigravity.google/product/antigravity-cli)
- [Antigravity CLI releases](https://github.com/google-antigravity/antigravity-cli/releases)

These providers are not aliases. Each official executable owns its own login, configuration, and
native session files. 456code does not share credentials between them, extract OAuth or other
Google tokens, call a direct Google/provider backend, use a Python SDK or sidecar, or redirect
Gemini CLI through an Antigravity backend.

## Capability contract

### Gemini

Supported:

- Multi-turn text with streaming output, standard ACP tool approvals, cancellation, and
  interruption.
- Image attachments from the managed 456code attachment store.
- Thread continuation through replay-gated ACP `session/load`.
- Best-effort model inventory and guarded `session/set_model` switching when the CLI advertises
  its unstable model method.
- Runtime modes and plan interaction discovered from the exact ACP mode IDs. Before live session
  confirmation, the provider retains the conservative `approval-required` and default-interaction
  capability fallback.
- Required one-shot text generation through the CLI's JSON output mode.

Unsupported or intentionally bounded:

- Conversation rollback, active-turn input, and structured user-input prompts are unsupported.
- Runtime and interaction modes omitted by the live ACP session are unavailable.
- A second turn is rejected while a prompt is running; 456code does not queue or steer it.

API-key instances receive an isolated `GEMINI_CLI_HOME`. Existing-login instances strip ambient
`GEMINI_API_KEY` and `GOOGLE_API_KEY` and let gemini-cli's own login state control authentication.

### Antigravity (Experimental)

Supported:

- One persistent `agy` process per active thread, with multi-turn assistant text streamed as
  newline-delimited JSON.
- Tool, checkpoint, usage, and delegated-agent activity in the 456code timeline.
- Exact continuation through the opaque `conversation_id` returned by the CLI, with one bounded
  resume attempt after a later-process failure.
- Opaque model selection, optional configured agent selection, and one-shot JSON text generation.
- `auto-accept-edits` and acknowledgement-gated `full-access` runtime modes.

Unsupported or intentionally bounded:

- The protocol is not ACP. It is the official persistent stream-json process surface.
- No native attachments, active-turn input, conversation rollback, interactive approval/user-input
  round trip, or in-session model/interaction-mode switching.
- A second message is rejected while a turn is running; 456code does not queue or steer it.
- Orchestration is a prompt prefix, not a native provider control channel.
- Model and agent discovery is best-effort and preserves configured opaque values when unavailable.

`auto-accept-edits` launches `--mode accept-edits`. `full-access` launches
`--dangerously-skip-permissions`; the server rejects the session unless the caller supplies the
exact capability acknowledgement `antigravity-full-access-v1`. This acknowledgement is required
for direct RPC callers as well as clients. The independent Antigravity sandbox setting remains
enabled by default.

## Sequential review slices

The slices are sequential. A slice cannot be closed by prose from a later slice; its focused gates
must pass before the next slice is reviewed.

| Slice | Review scope | Required validation gate | Status |
| --- | --- | --- | --- |
| 1 — Server contracts and runtimes | Settings, driver registration, capability matrices, server admission, Gemini ACP lifecycle/auth/resume, Antigravity version/flag checks, NDJSON parsing/lifecycle/recovery | `vp test run tests/packages/contracts/settings.test.ts tests/packages/contracts/provider.test.ts tests/apps/server/provider/providerCapabilities.test.ts tests/apps/server/provider/acp/GeminiAcpSupport.test.ts tests/apps/server/provider/antigravity/AntigravityCli.test.ts tests/apps/server/provider/antigravity/AntigravitySessionRuntime.test.ts tests/apps/server/provider/Layers/GeminiAdapter.test.ts tests/apps/server/provider/Layers/AntigravityAdapter.test.ts`; `pnpm --filter @t3tools/contracts typecheck`; `pnpm --filter 456code typecheck` | Implementation present; pass evidence not recorded |
| 2 — Client capability and acknowledgement flow | Web/mobile provider metadata, capability limits, runtime-mode selection, and propagation of `antigravity-full-access-v1` | `vp test run tests/apps/web/components/chat/runtimeModeWarnings.test.ts tests/apps/mobile/lib/projectThreadStartTurn.test.ts tests/apps/mobile/state/threads/thread-outbox.test.ts tests/apps/mobile/state/threads/use-thread-composer-state.test.ts`; web/mobile typechecks; one isolated web integrated pass with `test-t3-app`; one representative mobile pass with `test-t3-mobile` | Implementation present; pass evidence not recorded |
| 3 — Official CLI and release closeout | Real executable probes, docs, and final safety/transport review | `gemini --version`; real `gemini --acp` initialize/auth/session/load/prompt/cancel lifecycle; `agy --version` >=1.1.15; `agy --help` exposes both stream-json flags; real Antigravity stream lifecycle/recovery and acknowledgement rejection; `git diff --check` on owned files | Open |

Slice 3 must also confirm that no provider path performs credential sharing, token extraction,
direct-backend calls, or Python SDK/sidecar startup. A simulated wrapper test is useful focused
evidence but does not replace the real official-CLI gate.

## Closeout rule

Mark this plan complete only after all three slices pass in order, the focused results and
integrated client evidence are retained, the real CLI gates are recorded, and the documentation
diff is clean. Until then, keep the plan **Active** and describe each gate as pending, failed, or
passed with evidence.
