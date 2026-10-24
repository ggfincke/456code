// apps/mobile/src/features/threads/thread-settings-options.test.ts
// protects provider reasoning choices and prompt restrictions

import {
  getPromptControlledTraits,
  getTraitSelectChange,
} from "@t3tools/client-runtime/model-traits";
import { ProviderInstanceId, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveEffortSlider, selectableChoices } from "./thread-settings-options";

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
  it("includes prompt-injected and workflow choices in declared order", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
      "ultrathink",
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
      "ultrathink",
      "ultracode",
    ]);
    expect(slider?.currentIndex).toBe(4);
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

  it("shows prompt-controlled Ultrathink and locks body-controlled reasoning", () => {
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
    ).toMatchObject({ currentValue: "ultrathink", currentIndex: 3, locked: false });
    expect(
      resolveEffortSlider({
        ...input,
        promptTraits: getPromptControlledTraits([effortDescriptor], "please ultrathink about this"),
      }),
    ).toMatchObject({ currentIndex: 3, locked: true });
  });
});

describe("prompt-controlled reasoning", () => {
  it("adds Ultrathink to the prompt without persisting an injected option", () => {
    const descriptors = [effortDescriptor];
    const change = getTraitSelectChange(
      { ...getPromptControlledTraits(descriptors, "solve it"), descriptors },
      effortDescriptor,
      "solve it",
      "ultrathink",
    );
    expect(change).toEqual({ prompt: "Ultrathink:\nsolve it" });
    expect(
      getPromptControlledTraits(descriptors, change?.prompt ?? "").ultrathinkPromptControlled,
    ).toBe(true);
    expect(
      getTraitSelectChange(
        { ...getPromptControlledTraits(descriptors, ""), descriptors },
        effortDescriptor,
        "",
        "ultrathink",
      ),
    ).toEqual({ prompt: "Ultrathink:\n" });
  });

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

  it("keeps body-controlled Ultrathink locked and preserves slash commands", () => {
    const descriptors = [effortDescriptor];
    const prompt = "please ultrathink about this";
    const selected = { ...getPromptControlledTraits(descriptors, prompt), descriptors };
    expect(selected.ultrathinkInBodyText).toBe(true);
    expect(getTraitSelectChange(selected, effortDescriptor, prompt, "low")).toBeNull();
    expect(
      getTraitSelectChange(
        { ...getPromptControlledTraits(descriptors, "/review"), descriptors },
        effortDescriptor,
        "/review",
        "ultrathink",
      ),
    ).toEqual({ prompt: "/review" });
  });
});
