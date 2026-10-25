// apps/mobile/src/features/threads/thread-settings-options.ts
// resolves supported native runtime and reasoning choices

import type { ModelSelection, ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";
import {
  getDescriptorStringValue,
  getPromptControlledTraits,
  REASONING_SELECT_DESCRIPTOR_IDS,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  {
    mode: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  {
    mode: "auto",
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
  },
  {
    mode: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
];

export function runtimeModeChoicesForSupportedModes(
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  return supportedRuntimeModes && supportedRuntimeModes.length > 0
    ? RUNTIME_MODE_CHOICES.filter((choice) => supportedRuntimeModes.includes(choice.mode))
    : RUNTIME_MODE_CHOICES;
}

export function compatibleRuntimeModeForChoices(
  runtimeMode: RuntimeMode,
  choices: ReadonlyArray<{ readonly mode: RuntimeMode }>,
): RuntimeMode {
  return choices.some((choice) => choice.mode === runtimeMode)
    ? runtimeMode
    : (choices[0]?.mode ?? runtimeMode);
}

export { selectableProviderOptionChoices as selectableChoices } from "@t3tools/client-runtime/model-traits";

export function resolveEffortSlider(input: {
  readonly descriptor: ProviderOptionDescriptor | undefined;
  readonly modelAvailable: boolean;
  readonly selection: ModelSelection | null;
  readonly reportedSelection: ModelSelection | null;
  readonly promptTraits: ReturnType<typeof getPromptControlledTraits>;
}) {
  const descriptor = input.descriptor;
  if (
    !input.modelAvailable ||
    descriptor?.type !== "select" ||
    !REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id) ||
    descriptor.options.length < 2
  )
    return null;
  const choices = selectableProviderOptionChoices(descriptor);
  const isPrimary = descriptor.id === input.promptTraits.primarySelectDescriptor?.id;
  const currentValue =
    isPrimary && input.promptTraits.ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(descriptor, input.selection, input.reportedSelection);
  const defaultIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.isDefault),
  );
  const selectedIndex = choices.findIndex((choice) => choice.id === currentValue);
  return {
    choices,
    currentValue,
    currentIndex: selectedIndex < 0 ? defaultIndex : selectedIndex,
    defaultIndex,
    locked: isPrimary && input.promptTraits.ultrathinkInBodyText,
  };
}
