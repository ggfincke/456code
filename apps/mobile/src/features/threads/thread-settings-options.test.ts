// apps/mobile/src/features/threads/thread-settings-options.test.ts
// protects provider reasoning choices and prompt restrictions

import {
  getPromptControlledTraits,
  getTraitSelectChange,
} from "@t3tools/client-runtime/model-traits";
import type {
  ManagedPolicySummary,
  ProviderOptionDescriptor,
  RuntimeMode,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  RUNTIME_MODE_CHOICES,
  resolveNewThreadRuntimeMode,
  selectableChoices,
  withManagedRuntimeModeLimits,
} from "./thread-settings-options";

const policy = (organization: string, maxRuntimeMode?: RuntimeMode): ManagedPolicySummary => ({
  organization,
  lockedSettings: [],
  ...(maxRuntimeMode === undefined ? {} : { limits: { maxRuntimeMode } }),
});

describe("managed runtime mode limits", () => {
  it("disables modes above the strictest target's ceiling with that target's reason", () => {
    const choices = withManagedRuntimeModeLimits(RUNTIME_MODE_CHOICES, [
      policy("Wide Corp", "auto"),
      undefined,
      policy("Narrow Corp", "auto-accept-edits"),
    ]);

    expect(choices.map((choice) => [choice.mode, choice.disabledReason])).toEqual([
      ["approval-required", undefined],
      ["auto-accept-edits", undefined],
      ["auto", "Narrow Corp limits threads to Auto-accept edits."],
      ["full-access", "Wide Corp limits threads to Auto."],
    ]);
  });

  it("drops a new thread's draft mode above the ceiling for the default", () => {
    const capped = policy("Corp", "auto");
    expect(resolveNewThreadRuntimeMode("full-access", "auto", capped)).toBe("auto");
    expect(resolveNewThreadRuntimeMode("approval-required", "auto", capped)).toBe(
      "approval-required",
    );
    expect(resolveNewThreadRuntimeMode(undefined, "auto", capped)).toBe("auto");
    expect(resolveNewThreadRuntimeMode("full-access", "auto", undefined)).toBe("full-access");
  });
});
import { resolveEffortSlider } from "./thread-settings-options";

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "ultracode", label: "Ultracode" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

describe("selectableChoices", () => {
  // regression: #21406 bring model controls in line with web
  it("leaves out prompt-injected choices and keeps workflow choices in declared order", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
      "ultracode",
    ]);
  });
});

describe("native effort slider", () => {
  it("keeps provider order, resolves reported values, and anchors unknown values at the default", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-next",
      options: [],
    };
    const input = {
      descriptor: effortDescriptor,
      modelAvailable: true,
      selection,
      reportedSelection: { ...selection, options: [{ id: "effort", value: "ultracode" }] },
      promptTraits: getPromptControlledTraits([effortDescriptor], ""),
    };
    const slider = resolveEffortSlider(input);
    expect(slider?.choices.map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
      "ultracode",
    ]);
    expect(slider?.currentIndex).toBe(3);
    expect(slider?.defaultIndex).toBe(1);
    expect(
      resolveEffortSlider({
        ...input,
        reportedSelection: { ...selection, options: [{ id: "effort", value: "unknown" }] },
      })?.currentIndex,
    ).toBe(1);
    expect(resolveEffortSlider({ ...input, modelAvailable: false })).toBeNull();
    expect(
      resolveEffortSlider({ ...input, descriptor: { ...effortDescriptor, id: "serviceTier" } }),
    ).toBeNull();
    expect(
      resolveEffortSlider({
        ...input,
        descriptor: { ...effortDescriptor, options: effortDescriptor.options.slice(0, 1) },
      }),
    ).toBeNull();
  });

  // Ultrathink is typed, not picked, so the slider rests on the default while it controls effort.
  it("reports prompt-controlled Ultrathink and locks body-controlled reasoning", () => {
    const input = {
      descriptor: effortDescriptor,
      modelAvailable: true,
      selection: null,
      reportedSelection: null,
    };
    expect(
      resolveEffortSlider({
        ...input,
        promptTraits: getPromptControlledTraits([effortDescriptor], "Ultrathink:\nsolve it"),
      }),
    ).toMatchObject({ currentValue: "ultrathink", currentIndex: 1, locked: false });
    expect(
      resolveEffortSlider({
        ...input,
        promptTraits: getPromptControlledTraits([effortDescriptor], "please ultrathink about this"),
      }),
    ).toMatchObject({ currentIndex: 1, locked: true });
  });
});

describe("prompt-controlled reasoning", () => {
  it("removes the prefix when choosing a regular effort and saves Ultracode as an option", () => {
    const descriptors = [effortDescriptor];
    const prompt = "Ultrathink:\nsolve it";
    expect(
      getTraitSelectChange(
        { ...getPromptControlledTraits(descriptors, prompt), descriptors },
        effortDescriptor,
        prompt,
        "ultracode",
      ),
    ).toEqual({ prompt: "solve it", modelOptions: [{ id: "effort", value: "ultracode" }] });
  });

  it("keeps body-controlled Ultrathink locked", () => {
    const descriptors = [effortDescriptor];
    const prompt = "please ultrathink about this";
    const selected = { ...getPromptControlledTraits(descriptors, prompt), descriptors };
    expect(selected.ultrathinkInBodyText).toBe(true);
    expect(getTraitSelectChange(selected, effortDescriptor, prompt, "low")).toBeNull();
  });
});
