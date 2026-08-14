<!-- .plans/28-coral-provider-integration.md -->
<!-- track the first-party Coral provider: Early Access Core shipped, later phases parked -->

# Coral Provider Integration

## Status

**Early Access Core is shipped in 456code.** Coral is a disabled-by-default first-party provider
with an Early Access badge. It runs `coral acp` for real turns. Status probes use `coral --version`
plus configured/fallback models (`gemma4:31b-mlx`) and do **not** call ACP `session/new`.

Phase 2 (HTTP MCP / Orchestrate readiness / 456 MCP handshake) is **parked**. Phases 3–4 (load/list
import, images, elicitation, rollback, `coral doctor`, packed-install rollout) are **not in this
release**.

## What Early Access Core includes

- Text turns, approvals, idle model switch, cancel, multi-turn, and native `session/resume`.
- Settings: disabled by default; executable path; Ollama host `http://localhost:11434`; home
  `~/.coral` / `CORAL_HOME`.
- Advertised capabilities only: default interaction, `approval-required`, in-session model switch.
  No active-turn input, Orchestrate, or rollback.
- App driver slug `coral` is distinct from the reserved worker-broker harness slug `coral`.

## What Core does not include

Orchestrate, HTTP MCP / `code456` session MCP injection, conversation rollback, images, session
list/load/import, structured elicitation, or `coral doctor`.

## Architectural Contract

`coral acp` is a first-party ACP v1 stdio agent. 456code owns routing, provider-instance settings,
canonical runtime events, and user interaction surfaces. Coral owns its model/tool loop, native
conversation state, native session persistence, local tools, and Ollama transport.

One ACP child binds at most one Coral session at a time. Core spawn does not inject 456code HTTP
MCP. Authentication is not applicable: Coral is local/Ollama.

The integration rejects driving the Ink TUI through a PTY, one `coral exec` process per turn,
embedding Coral internals into the 456code server, and representing Coral itself as an MCP server.

`coral exec` remains an independent one-shot worker surface. It is not the interactive provider
transport.

## Protocol Pin

The wire protocol is ACP v1. The compatibility fixture pins `@agentclientprotocol/sdk@1.3.0` and
`schema-v1.20.0`. Unstable v1 features stay generated but capability-gated. `/experimental/v2` is
not imported.

Invariants that still apply to Core:

- `session/resume` restores native state without transcript replay.
- an empty `authMethods` list means no `authenticate` call.
- permission option IDs are opaque; behavior is selected by each advertised option's semantic
  `kind`.
- status refresh must not create durable Coral sessions.

## Phase ledger

| Phase | This release | Notes |
| --- | --- | --- |
| 0 — ACP v1 compatibility foundation | shipped | SDK 1.3.0 / schema v1.20.0 pin in `packages/effect-acp`. |
| 1 — Baseline first-party provider | shipped | Driver, adapter, settings, Core capability matrix, Early Access UI. |
| 2 — HTTP MCP, runtime policy, Orchestrate | parked | `buildCoralAcpMcpServers` / `McpToolReadiness` / selected-provider MCP handshake preserved on the coral-integration side branch only. |
| 3 — Load/list/import, images, elicitation, rollback | not this release | Capability-gated follow-on. |
| 4 — `coral doctor`, packed-install, public docs rollout | not this release | `docs/providers/coral.md` is owned by the isolated smoke pass. |

## Probe behavior

`checkCoralProviderStatus` runs `coral --version` with the configured binary (timeout 4s). On
success it publishes fallback models. It never starts ACP and never calls `session/new` or
`listSessions` during refresh. ACP starts on real turns only.

## Deliberate Test Boundary

Focused tests cover Coral provider/adapter/ACP support, capability matrices, Effect ACP SDK v1
conformance, and settings defaults. Isolated web smoke and `docs/providers/coral.md` are a later
pass. This plan does not require packed-install or `test-t3-app` evidence to remain valid.
