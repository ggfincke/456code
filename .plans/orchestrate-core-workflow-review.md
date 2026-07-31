# Orchestrate-as-core-workflow review

Run `orchestrate-core-review-k4v7`, 2026-07-30. Method: 4 read-only fanout reviewers (codex `gpt-5.6-luna`) over four lenses, then 2 adversarial verifiers (codex `gpt-5.6-sol`), one per repo. Bases: 456code `beecd7282` + working tree, ggfincke-skills `e7ef4ef` + working tree (temp base commits, reset after the run). All 6 workers completed, 0 scope violations.

Goal: adjustments so that driving everything through an orchestrator session (which plans, gates, and launches broker workers) is the app's core workflow rather than a bolt-on.

## Action groups (ranked)

### Group 1 — quick wins (S each)

1. **Fix the plan-card progress denominator.** The card derives all progress from observed jobs only; a run planned at 6 workers where only 4 launch shows "4/4 workers finished" and em-dashes for the missing stage. Compare observed jobs per stage against the plan's `workers` counts and `totalWorkers`; render explicit `pending` / `missing` states. Evidence: `apps/web/src/components/chat/OrchestratePlanCard.tsx:238-245, 548-557, 732-760`. Verified CONFIRMED (med).
2. **Add `run`/`workflow` filters + a run rollup to the broker MCP.** `list_workers` accepts only `status`; summaries already carry `run`/`workflow`/`stage` but nothing filters or aggregates on them, so orchestrators re-fetch and regroup the whole job inventory every poll. Add `run` filter and a `get_run_status` (counts by stage × status). Evidence: `tools/worker-broker/src/mcp-server.ts:162-185, 86-107`. Verified CONFIRMED (med).
3. **Report model/effort in worker results.** Terminal results omit both requested and provider-effective model/effort, so the lead can't confirm execution matched the approved plan. `job.json` already persists requested values — expose them in the result, and pass through provider-reported effective values where available. Evidence: `tools/worker-broker/src/contracts.ts:122-157`; providers resolve defaults internally (`providers/codex.ts:42-49`, `cursor.ts:93-95`, `coral.ts:69-76`). Verified CONFIRMED (med).
4. **Approval-loop small fixes.** (a) `handleApprove` clears `sending` only on the normal path — wrap in try/finally so a rejected promise can't strand the card disabled; (b) `handleEditInChat` sets `sent=true` immediately, disabling the very card being edited — separate `editing` from `approved`; (c) include the plan's `runId` in the emitted `approve …` reply so approvals are correlated to a specific plan. Evidence: `OrchestratePlanCard.tsx:572-582`. Verified PARTIAL (sub-claims (a)/(b) confirmed; concurrent double-send is already guarded by `sendInFlightRef`, `ChatView.tsx:4661-4671`).

### Group 2 — broker orchestration primitives (M each)

5. **Restart durability for queued jobs (highest-severity confirmed finding).** On broker restart, `reconcileInterrupted` fails every nonterminal job — including queued jobs that never started and could be safely re-scheduled. A mid-run broker restart converts pending waves into failures the orchestrator must manually recreate. Re-enqueue queued jobs; fail only orphaned running ones. Evidence: `tools/worker-broker/src/job-manager.ts:87-145, 155-163`. Verified CONFIRMED (high).
6. **Expose `wait_for_workers`.** `job-manager.ts:205-219` already has an EventEmitter-backed `waitForTerminal`, but no MCP tool exposes it, so orchestrators poll or arm external file monitors (this run needed a shell polling loop; user explicitly asked for push). Add a bounded blocking wait (job set or run, timeout param, returns terminal summaries). Verified CONFIRMED (med); bounded wait is feasible, unbounded risks client MCP timeouts.
7. **Add `get_worker_artifact`.** Patch, events.jsonl, stderr, prompt are path-only; an orchestrator without shell access can't perform the inspection `integration-checklist.md` requires. Bounded reads (named artifact, byte limit, tail/range). Evidence: `contracts.ts:143-149`, `mcp-server.ts:212-245`. Verified CONFIRMED (med).
8. **Queue fairness + wave ordering.** Scheduling skips blocked earlier edit jobs, so a later narrow edit can jump an earlier broad one, and there's no `depends_on`/barrier for multi-wave ordering — the orchestrator holds all sequencing. Add FIFO semantics among conflicting edit jobs and an optional `depends_on`. Evidence: `job-manager.ts:234-265`. Verified CONFIRMED (med).
9. **profiles.json feedback + write-back.** Verifier verdict: the "missing loader" claim is wrong (the orchestrator reads the file by design, `model-plan.md:59`), but invalid files fall back *silently*. Add: skill instruction to surface a one-line "profiles invalid/ignored" notice in the plan; a "remember this run's models" write-back after approval; optional per-repo overlays. Verified PARTIAL.

### Group 3 — app-side: runs as first-class objects (M/L)

10. **Run summary contract + server-side filtering.** No run concept exists in `packages/contracts/src/workers.ts` or `WorkerBrokerStore` (list/getJob only); every 3–4s refresh scans all historical job files serially and filters client-side. Add `WorkersRunSummary` (stage rollups, expected-vs-observed, failures, elapsed) + run-filtered queries. Evidence: `WorkerBrokerStore.ts:35-40, 359-415`, `workers.ts:89-120`. (L)
11. **Workers change stream to replace double polling.** Client runtime polls every 3s (`packages/client-runtime/src/state/workers.ts:14-26`) *and* the plan card adds a 4s interval; workers RPCs are unary. The app has a proven snapshot+PubSub pattern (`apps/server/src/vcs/VcsStatusBroadcaster.ts:503-530`, stream RPCs `rpc.ts:787-837`) — verifier note: it's a reusable *pattern*, not plug-in code; a jobs-dir watcher, event schema, and stream RPC all need building. (L)
12. **Broker readiness preflight.** The app never registers worker-broker tools itself (`McpHttpServer.ts:229-247` registers preview/proposal only); sessions get them only by inheriting user-level provider MCP config, and nothing health-checks that before send — broker absence surfaces as a failed tool call mid-turn. Add a readiness probe when orchestrate mode is selected ("broker unavailable" before the user sends). Verified PARTIAL (inheritance path is real; absence of health-check confirmed). (M)
13. **Plan-card navigation into the workers panel.** The card can't open the run or a worker; `OrchestratePlanActions` has only approve/edit; panel detail is local state; patches render as text only. Add "Open run"/"Open worker" actions and run identity in the panel surface (`rightPanelStore.ts:31-57`, `WorkersPanel.tsx:369-378, 281-286`). (M)
14. **Stale-card supersession + durable selections.** Every historical `orchestrate-plan` fence renders an actionable card with thread-level actions; unsent picker edits are component-local and lost on virtualization remount. Softened by verification: completed runs auto-disable via runId-job discovery, and the fence text (incl. runId) is durably persisted, so reload does not lose correlation. Remaining work: supersede older cards when a newer plan exists; key selections by message/run in a store. (M)

### Group 4 — added during dogfooding (2026-07-30 session)

15. **Plan-card visual polish.** User verdict on the current card: "could be prettier." Pass over spacing, row density, header/footer hierarchy, picker styling, and status-chip design; align with the app's composer/selector visual language. (M)
16. **Per-row stage identity — model/effort must bind per row, not per stage id.** Selections in `OrchestratePlanCard` are keyed by `stage.id`; a multi-wave plan that repeats an id (e.g. `implement` in wave 1 and wave 2) ties both rows' model/effort pickers together, and the `<stage>=` approval grammar becomes ambiguous. Fix in three places: card keys selections by row identity (index or id+phase); `model-plan.md` requires unique per-row stage ids in multi-wave plans (e.g. `implement-w1`); reply grammar addresses rows by that unique id. Observed live in this session. (S/M)

17. **Plan-card scope column forces egregious horizontal scroll.** Long `scope` strings render as one unwrappable line, widening the table until every other column is scrolled out of view (rows read as blank). Let scope wrap or line-clamp with expand-on-demand inside a bounded column; keep horizontal scroll only as a last resort for genuinely wide tables. Observed live 2026-07-30. (S)

18. **Claude Code broker provider.** The broker accepts only codex/cursor/coral, so Anthropic models can only run via cursor's harness; Claude Code's headless mode (`claude -p`) fits the existing provider shape (`tools/worker-broker/src/providers/`). Add a `claude` provider: spawn in worktree, model/effort flags, event/stderr capture, exit-code mapping, read/edit mode enforcement via permission mode. Surfaced by user 2026-07-30. (M)

19. **Broker: provider spawn failures never reach `job.error`.** The claude smoke test failed in 1.5s with `status: failed` but `error: null`, no stderr artifact, no events — the spawn exception (ENOENT on the binary) was swallowed. Persist the thrown error into the job record and create artifact files before spawn so there's always evidence. Found live 2026-07-31. (S)
20. **Broker: provider binaries need robust resolution.** The MCP server inherits a minimal PATH (no `~/.local/bin`), so `spawn("claude")` ENOENTs while the same job succeeds via CLI from a login shell. Mitigated by setting `WORKER_BROKER_CLAUDE_BINARY` in the MCP server env; durable fix: absolute-path resolution/validation at startup with a clear config error listing which providers are unavailable and why. Found live 2026-07-31. (S/M)

## Softened or refuted claims (recorded so they don't resurface)

- "profiles.json pipeline doesn't exist" — by design the orchestrator reads it; the gap is silent-invalid fallback only.
- "Double-approve is possible" — concurrent sends are guarded (`sendInFlightRef`); the remaining risk is sequential re-approval of stale cards.
- "Restart loses run correlation" — message text (and thus the plan fence + runId) is durably persisted and reprojected; no normalized server-side run relation exists, but the UI recovers.
- "Existing subscription infra is directly reusable for workers" — it's an architectural pattern to copy, not shared code.

## Implementation run report (orchestrate-core-fixes-p8w3, completed 2026-07-31)

All items except 15 (visual polish, deliberately deferred — wants user direction) and 19/20 (found during the run) are implemented and validated: 456code typecheck + tests green, broker check + 23/23 tests green, both from the reset working trees. 9/9 worker budget used across 3 waves (waves 1–2 codex, wave 3 native claude opus-5 via the new provider).

Deviations: worker A reported `failed` on sandbox-only verification (no node_modules) — accepted after full-toolchain validation in-lead plus a 3-line test-fixture fix; E's watcher was rewritten in-lead to Effect idiom (repo lint forbids node builtins/global timers); F needed two small idiom fixes; the claude smoke test failed via the MCP server (items 19/20, PATH-based spawn ENOENT), was replaced by a successful CLI repro, and wave 3 ran via the broker CLI — `WORKER_BROKER_CLAUDE_BINARY` is now set in `~/.claude.json` so MCP sessions work after the broker restarts. Both repos were soft-reset to their pre-run bases; all work sits as uncommitted diffs. Nothing committed or pushed.

## Review run report (orchestrate-core-review-k4v7)

- 6/6 workers completed; no failed/rejected/cancelled; no scope violations; read-only run, no patches to integrate.
- Deviation from plan: verify stage moved from cursor (profiles default) to codex:gpt-5.6-sol via gate edit — honored.
- Temp base commits in both repos were reset (`456code` → `beecd7282`, `ggfincke-skills` → `e7ef4ef`); working trees restored. Note: pre-commit hooks (`vp fmt`, lint-staged) may have reformatted some already-dirty files during the temp commits.
- Observed live during this run (dogfooding datapoints): the plan card correctly correlated jobs by runId and showed "4 completed" before the lead session's monitor surfaced it (finding 6); the card's fanout row displayed a resolved default model (GPT-5.6-Sol) rather than the approved gpt-5.6-luna because approval edits live in chat text, not in the card's rendering of the original fence (finding 14/4c).
