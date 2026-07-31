// tests/apps/server/provider/Layers/CodexProvider.test.ts
// verifies Codex model capabilities and account usage normalization
import { assert, it } from "@effect/vitest";

import {
  applyPreferredCodexDefaultModel,
  mapCodexAccountUsage,
  mapCodexModelCapabilities,
  resolveCodexAccountUsage,
} from "../../../../../apps/server/src/provider/Layers/CodexProvider.ts";

it("normalizes and de-duplicates Codex account usage windows", () => {
  const mirrored = {
    limitId: "codex",
    limitName: "Codex",
    primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 84, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
  } as const;
  const usage = mapCodexAccountUsage(
    {
      rateLimits: mirrored,
      rateLimitsByLimitId: {
        codex: mirrored,
        reviews: {
          limitId: "reviews",
          limitName: "Code reviews",
          primary: { usedPercent: 120, windowDurationMins: 1_440, resetsAt: null },
        },
      },
    },
    "2026-04-10T00:00:00.000Z",
  );

  assert.deepStrictEqual(usage, {
    status: "available",
    observedAt: "2026-04-10T00:00:00.000Z",
    windows: [
      {
        id: "account:primary",
        label: "5h",
        usedPercent: 62,
        resetsAt: "2027-01-15T08:00:00.000Z",
      },
      {
        id: "account:secondary",
        label: "Week",
        usedPercent: 84,
        resetsAt: "2027-01-21T02:53:20.000Z",
      },
      {
        id: "reviews:primary",
        label: "1d",
        scopeLabel: "Code reviews",
        usedPercent: 100,
        resetsAt: null,
      },
    ],
  });
});

it("keeps a missing Codex rate-limit response non-fatal to account status", () => {
  const usage = resolveCodexAccountUsage(
    {
      account: {
        account: { type: "chatgpt", email: "dev@example.com", planType: "plus" },
        requiresOpenaiAuth: true,
      },
      rateLimits: undefined,
      version: "1.0.0",
      models: [],
      skills: [],
    },
    "2026-04-10T00:00:00.000Z",
  );

  assert.deepStrictEqual(usage, {
    status: "unavailable",
    observedAt: "2026-04-10T00:00:00.000Z",
    message: "Codex plan usage is temporarily unavailable.",
  });
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
