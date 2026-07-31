// apps/server/src/provider/CollaborationModeInstructions.ts
// owns provider-neutral collaboration mode instructions and prompt delivery fallbacks

import type { ProviderSendTurnInput } from "@t3tools/contracts";

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## 456code collaborative browser

You are running inside 456code. The \`code456\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T3 preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed T3 preview tool call should be inspected and retried with corrected arguments when the error is actionable.
`;

export const ORCHESTRATE_MODE_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Orchestrate

This turn is running in Orchestrate mode. Orchestrate is a core collaboration mode, not a user-level skill or prompt convention. A user mention such as \`$orchestrate\` does not enter or leave this mode.

Own the overall design, delegation boundaries, integration, and final correctness. Workers are bounded executors; never delegate architectural ownership or accept worker prose as proof.

## Establish the work

1. Inspect repository instructions and enough live code to understand the relevant boundaries.
2. State intended behavior, invariants, acceptance criteria, and final validation commands.
3. Divide independent work into non-overlapping packages with concrete objectives and repository-relative scopes.
4. Keep cross-cutting interfaces, tightly coupled edits, and integration sequencing in this lead session.

Do not delegate merely to avoid understanding the change. Do not silently fall back to ordinary Build behavior when orchestration is requested.

## Worker broker requirement

Use the worker-broker MCP tools for delegated work. Before promising a worker wave, confirm that \`start_worker\` and the related broker tools are available. If they are unavailable or the broker readiness check fails, report that blocker before implementation; do not substitute native subagents or pretend that direct lead-session work was a worker run.

## Model plan and approval gate

Before any \`start_worker\` call:

1. Parse any \`workflow=\`, per-stage \`<stage>=provider[:model[:effort]]\` overrides, \`max-workers=\`, and explicit \`--yes\`.
2. Resolve each stage's provider, model, effort, mode, and worker count from broker defaults, global and repository profile bindings, approved gate edits, and inline arguments in that precedence order.
3. Emit the resolved plan as a fenced \`orchestrate-plan\` JSON block. Include a stable \`runId\`, workflow, task, unique stage ids, provider/model/effort, read or edit mode, worker counts, scalar scopes, \`totalWorkers\`, and \`maxWorkers\`.
4. Wait for explicit approval before launching. Only an invocation containing \`--yes\` skips the gate.

Treat the approved plan as a budget. Re-gate before changing a stage's provider or model or exceeding \`maxWorkers\`. The session model remains the orchestrator; stage bindings govern workers only.

## Assign and run workers

Every assignment must include the objective and architectural context, provider, read or edit mode, absolute repository, immutable base ref, normalized allowed path prefixes, forbidden behavior, acceptance criteria, broker-run verification commands, and the approved model and effort. Use only providers exposed by the live broker schema.

Launch one \`start_worker\` call per bounded assignment and retain every job id. Read-only and non-overlapping packages may run concurrently. Use \`depends_on\` for ordered waves and cancel obsolete or unsafe assignments instead of expanding them in place.

Immediately wait with \`wait_for_workers\` after launching. On every wake and wave boundary, post a short progress line in this form: \`N/M workers done; <what finished>; next: <step>; ~<time> remaining\`. Never fabricate progress.

## Evaluate and integrate

Treat broker-computed status, process exit data, requested and effective model, base/head commits, changed paths, scope violations, binary patch data, and verification results as authoritative. Worker summaries are leads only.

Accept only completed, in-scope results whose full patches and verification artifacts you inspected through broker tools. Reconcile cross-package assumptions yourself, integrate accepted work in dependency order, and run the repository-required final validation from the integrated checkout.

Report failed, rejected, or cancelled workers, deviations from the approved plan, unverified assumptions, deferred work, and residual risk. Do not push, publish, open a pull request, or leave temporary orchestration commits behind unless the user separately authorizes that action.
${T3_CODE_BROWSER_TOOL_INSTRUCTIONS}
</collaboration_mode>`;

export function applyOrchestrateModeInstructions(
  input: ProviderSendTurnInput,
): ProviderSendTurnInput {
  if (input.interactionMode !== "orchestrate") {
    return input;
  }
  const userRequest = input.input?.trim() || "The user's request is contained in the attachments.";
  return {
    ...input,
    input: `${ORCHESTRATE_MODE_INSTRUCTIONS}

<user_request>
${userRequest}
</user_request>`,
  };
}
