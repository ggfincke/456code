// apps/mobile/src/features/threads/thread-settings-sheet-state.test.ts
// protects native model selection and effort editing lifecycle

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { ProviderInstanceId, type ProviderOptionSelection } from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";

import type { ModelOption } from "../../lib/modelOptions";
import { appAtomRegistry } from "../../state/atom-registry";
import { modelOptionMemoryAtom } from "../../state/use-composer-drafts";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import {
  canCommitPendingModel,
  createEffortSelectionSession,
  pendingModelAfterPress,
  resolvePendingCatalogModel,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        },
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          options: [
            { id: "default", label: "Standard", isDefault: true },
            { id: "priority", label: "Fast" },
          ],
          currentValue: "default",
        },
      ],
    },
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  appAtomRegistry.set(modelOptionMemoryAtom, {});
});

describe("thread settings sheet state", () => {
  it("invalidates staged effort when the live catalog replaces, hides, or removes its model", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);
    const onCommit = vi.fn();
    let models = [pending];
    const current = () =>
      resolvePendingCatalogModel(pending, [
        { providerKey: "codex", providerLabel: "Codex", models },
      ]);
    expect(current()?.selection.options).toEqual([{ id: "effort", value: "high" }]);
    const { options: _options, ...withoutOptions } = pending.selection;
    expect(
      resolvePendingCatalogModel({ ...pending, selection: withoutOptions }, [
        { providerKey: "codex", providerLabel: "Codex", models },
      ])?.selection,
    ).not.toHaveProperty("options");
    const identity = () => JSON.stringify(current());
    const selection = createEffortSelectionSession(
      {
        identity: identity(),
        choices: [
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
        currentValue: "medium",
        defaultIndex: 0,
      },
      () => ({ identity: identity(), disabled: current() === null, onCommit }),
    );
    models = [
      {
        ...pending,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [{ id: "low", label: "Low", isDefault: true }],
            },
          ],
        },
      },
    ];
    expect(selection.commit(1)).toBe(false);
    expect(current()?.selection.options).toEqual([{ id: "effort", value: "low" }]);
    models = [{ ...pending, isHidden: true }];
    expect(current()).toBeNull();
    expect(selection.commit(1)).toBe(false);
    models = [{ ...pending, isUnavailable: true }];
    expect(current()).toBeNull();
    models = [];
    expect(current()).toBeNull();
    expect(selection.commit(1)).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("previews effort locally, commits a release once, and resets through the provider default", () => {
    const onCommit = vi.fn();
    const selection = createEffortSelectionSession(
      {
        identity: "codex:gpt-next:effort",
        choices: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
        currentValue: "low",
        defaultIndex: 1,
      },
      () => ({ identity: "codex:gpt-next:effort", disabled: false, onCommit }),
    );
    expect(selection.preview(2)?.id).toBe("high");
    expect(onCommit).not.toHaveBeenCalled();
    expect(selection.commit(2)).toBe(true);
    expect(selection.commit(2)).toBe(false);
    expect(onCommit.mock.calls).toEqual([["high"]]);
    expect(selection.reset()).toBe(true);
    expect(selection.reset()).toBe(false);
    expect(selection.commit(0)).toBe(true);
    expect(onCommit.mock.calls).toEqual([["high"], ["medium"], ["low"]]);
  });

  it("rejects disabled, stale model/catalog, and dismissed effort callbacks", () => {
    const onCommit = vi.fn();
    let live: { identity: string; disabled: boolean; onCommit: typeof onCommit } | null = {
      identity: "provider:model:choices",
      disabled: false,
      onCommit,
    };
    const initial = live;
    const selection = createEffortSelectionSession(
      {
        identity: initial.identity,
        choices: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
        currentValue: "low",
        defaultIndex: 0,
      },
      () => live,
    );
    live = { ...initial, disabled: true };
    expect(selection.preview(1)).toBeUndefined();
    expect(selection.commit(1)).toBe(false);
    live = { ...initial, identity: "other-provider:model:new-choices" };
    expect(selection.commit(1)).toBe(false);
    live = null;
    expect(selection.commit(1)).toBe(false);
    selection.dispose();
    live = initial;
    expect(selection.commit(1)).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("preserves in-progress edits when the staged model is pressed again", () => {
    rememberModelOptions("codex", "gpt-next", [{ id: "effort", value: "medium" }]);
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
        restoreSelection: withRememberedModelOptions,
      })?.selection.options,
    ).toEqual([{ id: "effort", value: "high" }]);
  });

  it("previews remembered options before Save when switching models", () => {
    const remembered = [
      { id: "effort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ];
    rememberModelOptions("codex", "gpt-other", remembered);
    const pressed = modelOption("gpt-other");

    const pending = pendingModelAfterPress({
      current: modelOption("gpt-next"),
      pressed,
      pressedIsApplied: false,
      restoreSelection: withRememberedModelOptions,
    });

    expect(pending?.selection).toEqual({ ...pressed.selection, options: remembered });
    const preview = getProviderOptionDescriptors({
      caps: pressed.capabilities!,
      selections: pending?.selection.options,
    });
    expect(preview.map(({ id, currentValue }) => ({ id, value: currentValue }))).toEqual(
      remembered,
    );
    expect(pending?.selection).toEqual(withRememberedModelOptions(pressed.selection));
  });

  it("keeps catalog defaults for scheduled-task picks even when options are remembered", () => {
    rememberModelOptions("codex", "gpt-other", [
      { id: "effort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ]);
    const pressed = modelOption("gpt-other");

    const pending = pendingModelAfterPress({
      current: modelOption("gpt-next"),
      pressed,
      pressedIsApplied: false,
    });

    expect(pending?.selection).toEqual(pressed.selection);
    const preview = getProviderOptionDescriptors({
      caps: pressed.capabilities!,
      selections: pending?.selection.options,
    });
    expect(preview.map(({ id, currentValue }) => ({ id, value: currentValue }))).toEqual([
      { id: "effort", value: "medium" },
      { id: "serviceTier", value: "default" },
    ]);
  });

  // regression: #16816 sync model favorites and visibility across clients
  it("cannot select a hidden model exposed only for visibility management", () => {
    const pending = modelOption("gpt-next");
    expect(
      canCommitPendingModel(pending, [
        { providerKey: "codex", providerLabel: "Codex", models: [{ ...pending, isHidden: true }] },
      ]),
    ).toBe(false);
  });

  it("cannot save a staged model after sign-out removes it from the catalog", () => {
    const pending = modelOption("gemini-native");
    const group = { providerKey: "codex", providerLabel: "Codex", models: [pending] };

    expect(canCommitPendingModel(pending, [group])).toBe(true);
    expect(canCommitPendingModel(pending, [])).toBe(false);
    expect(
      canCommitPendingModel(pending, [
        {
          ...group,
          models: [{ ...pending, isUnavailable: true }],
        },
      ]),
    ).toBe(false);
  });
});
