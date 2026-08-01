// tests/apps/web/components/chat/OrchestratePlanCard.test.ts
// verifies defensive plan parsing and the exact orchestrate approval reply grammar
import { describe, expect, it } from "@effect/vitest";

import {
  buildOrchestrateApprovalReply,
  type OrchestratePlan,
  parseOrchestratePlan,
} from "../../../../../apps/web/src/components/chat/OrchestratePlanCard";

function parsePlan(value: Record<string, unknown>): OrchestratePlan {
  const plan = parseOrchestratePlan(JSON.stringify(value));
  if (plan === null) throw new Error("Expected a valid orchestrate plan fixture.");
  return plan;
}

const BASE_PLAN = {
  workflow: "review-and-fix",
  task: "Review the change and implement the fix",
  runId: "run-42",
  stages: [
    {
      id: "review",
      provider: "codex",
      model: "gpt-5.6",
      effort: "high",
      mode: "read",
      workers: 1,
      scope: "apps/web",
    },
    {
      id: "implement",
      provider: "claudeAgent",
      model: "claude-opus-5",
      effort: "medium",
      mode: "edit",
      workers: 1,
      scope: "apps/server",
    },
  ],
  totalWorkers: 2,
  maxWorkers: 2,
} satisfies Record<string, unknown>;

describe("parseOrchestratePlan", () => {
  it("normalizes optional descriptive fields while retaining run correlation", () => {
    const plan = parsePlan({
      workflow: "inspect",
      runId: "run-inspect",
      stages: [
        {
          id: "inspect",
          provider: "codex",
          model: null,
          mode: "read",
          workers: 2,
          scope: ["apps/web", "tests/apps/web"],
        },
      ],
    });

    expect(plan).toEqual({
      workflow: "inspect",
      task: "",
      runId: "run-inspect",
      stages: [
        {
          id: "inspect",
          provider: "codex",
          model: "",
          mode: "read",
          workers: 2,
          scope: "apps/web; tests/apps/web",
        },
      ],
      totalWorkers: 2,
      maxWorkers: 2,
      validationError: null,
    });
  });

  it("rejects structurally invalid plans", () => {
    expect(parseOrchestratePlan("not json")).toBeNull();
    expect(
      parseOrchestratePlan(
        JSON.stringify({
          workflow: "broken",
          stages: [{ id: "edit", provider: "codex", mode: "write", workers: 1 }],
        }),
      ),
    ).toBeNull();
  });

  it("flags duplicate stage IDs with an approval-blocking error", () => {
    const plan = parsePlan({
      ...BASE_PLAN,
      stages: [BASE_PLAN.stages[0], { ...BASE_PLAN.stages[1], id: "review" }],
    });

    expect(plan.validationError).toBe(
      'Duplicate stage ID "review". Stage IDs must be unique before approval.',
    );
  });
});

describe("buildOrchestrateApprovalReply", () => {
  it("emits the exact no-override grammar with run correlation", () => {
    const plan = parsePlan(BASE_PLAN);

    expect(buildOrchestrateApprovalReply(plan)).toBe("approve run=run-42");
  });

  it("emits provider, model-only, effort, and max-worker overrides in stage order", () => {
    const plan = parsePlan(BASE_PLAN);

    expect(
      buildOrchestrateApprovalReply(plan, {
        selections: {
          "0:review": {
            provider: "cursor",
            model: "cursor-pro",
            instanceId: null,
          },
          "1:implement": {
            provider: "claudeAgent",
            model: "claude-opus-5.1",
            instanceId: null,
          },
        },
        efforts: {
          "0:review": "xhigh",
          "1:implement": "high",
        },
        maxWorkers: 4,
      }),
    ).toBe(
      "approve run=run-42 review=cursor:cursor-pro:xhigh implement=claude-opus-5.1:high max-workers=4",
    );
  });

  it("emits a provider-only override for a provider-default model", () => {
    const plan = parsePlan({
      ...BASE_PLAN,
      stages: [{ ...BASE_PLAN.stages[0], model: null, effort: undefined }],
      totalWorkers: 1,
      maxWorkers: 1,
    });

    expect(
      buildOrchestrateApprovalReply(plan, {
        selections: {
          "0:review": { provider: "cursor", model: "", instanceId: null },
        },
      }),
    ).toBe("approve run=run-42 review=cursor");
  });
});
