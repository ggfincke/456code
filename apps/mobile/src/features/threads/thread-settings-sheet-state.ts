// apps/mobile/src/features/threads/thread-settings-sheet-state.ts
// guards native model and effort selection sessions

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type { ModelSelection, ProviderInstanceId, ProviderOptionChoice } from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export function createEffortSelectionSession(
  snapshot: {
    readonly identity: string;
    readonly choices: ReadonlyArray<ProviderOptionChoice>;
    readonly currentValue: string | null;
    readonly defaultIndex: number;
  },
  readCurrent: () => {
    readonly identity: string;
    readonly disabled: boolean;
    readonly onCommit: (value: string) => void;
  } | null,
) {
  let active = true;
  let lastCommitted = snapshot.currentValue;
  const preview = (index: number) => {
    const current = readCurrent();
    return active &&
      current?.identity === snapshot.identity &&
      !current.disabled &&
      Number.isInteger(index)
      ? snapshot.choices[index]
      : undefined;
  };
  const commit = (index: number) => {
    const choice = preview(index);
    const current = readCurrent();
    if (!choice || !current || choice.id === lastCommitted) return false;
    lastCommitted = choice.id;
    current.onCommit(choice.id);
    return true;
  };
  return {
    activate: () => {
      active = true;
    },
    preview,
    commit,
    reset: () => commit(snapshot.defaultIndex),
    dispose: () => {
      active = false;
    },
  };
}

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  return [...favorites, ...others];
}

export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
  readonly restoreSelection?: (selection: ModelSelection) => ModelSelection;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  if (input.current?.key === input.pressed.key) {
    return input.current;
  }
  return input.restoreSelection
    ? { ...input.pressed, selection: input.restoreSelection(input.pressed.selection) }
    : input.pressed;
}

export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some(
      (model) => model.key === pending.key && !model.isUnavailable && !model.isHidden,
    ),
  );
}

export function resolvePendingCatalogModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): ModelOption | null {
  const model = groups
    .flatMap((group) => group.models)
    .find((candidate) => candidate.key === pending.key);
  if (!model || model.isHidden || model.isUnavailable) return null;
  const { options: _catalogOptions, ...selection } = model.selection;
  const options = model.capabilities
    ? buildExplicitProviderOptionSelectionsFromDescriptors(
        getProviderOptionDescriptors({
          caps: model.capabilities,
          selections: pending.selection.options,
        }),
        pending.selection.options,
      )
    : pending.selection.options;
  return {
    ...model,
    selection: {
      ...selection,
      ...(options ? { options } : {}),
    },
  };
}

export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}
