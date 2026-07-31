// apps/server/src/orchestration/Layers/ProviderSwitchPolicy.ts
// centralizes outgoing-provider compaction models and the handoff prompt

import type { ProviderDriverKind } from "@t3tools/contracts";

const DEFAULT_COMPACTION_MODEL_BY_DRIVER: Readonly<Record<string, string | null>> = {
  claude: "sonnet",
  claudeAgent: "sonnet",
  codex: "gpt-5.6-luna",
  cursor: "grok-4.5-fast",
  grok: "grok-4.5-fast",
  opencode: null,
};

export const PROVIDER_SWITCH_COMPACTION_PROMPT = [
  "Produce a complete handoff summary for a successor agent.",
  "Include the conversation's intent, decisions, completed work including files changed,",
  "unresolved work, and constraints.",
  "Explicitly distinguish completed tool effects from proposed actions.",
  "Return only the handoff summary.",
].join(" ");

export function resolveProviderSwitchCompactionModel(input: {
  readonly driverKind: ProviderDriverKind;
  readonly currentModel: string;
  readonly availableModels: ReadonlyArray<string>;
}): string {
  const candidate = DEFAULT_COMPACTION_MODEL_BY_DRIVER[input.driverKind];
  if (candidate === null || candidate === undefined) {
    return input.currentModel;
  }
  return input.availableModels.includes(candidate) ? candidate : input.currentModel;
}
