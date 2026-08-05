// apps/server/src/orchestration/Layers/ProviderSwitchPolicy.ts
// centralizes outgoing-provider compaction models and the handoff prompt

import type { ProviderDriverKind } from '@t3tools/contracts'

const KEEP_CURRENT_MODEL = null

const DEFAULT_COMPACTION_MODEL_BY_DRIVER: Readonly<Record<string, string | null>> = {
  claude: 'claude-sonnet-5',
  claudeAgent: 'claude-sonnet-5',
  codex: 'gpt-5.6-luna',
  // cursor and grok keep the current model until their catalogs expose a verified cheaper slug
  cursor: KEEP_CURRENT_MODEL,
  grok: KEEP_CURRENT_MODEL,
  opencode: null,
}

export const PROVIDER_SWITCH_COMPACTION_PROMPT = [
  'Produce a complete handoff summary for a successor agent.',
  "Include the conversation's intent, decisions, completed work including files changed,",
  'unresolved work, and constraints.',
  'Explicitly distinguish completed tool effects from proposed actions.',
  'Return only the handoff summary.',
].join(' ')

export function resolveProviderSwitchCompactionModel(input: {
  readonly driverKind: ProviderDriverKind
  readonly currentModel: string
  readonly availableModels: ReadonlyArray<string>
}): string
{
  const candidate = DEFAULT_COMPACTION_MODEL_BY_DRIVER[input.driverKind]
  if (candidate === null || candidate === undefined)
  {
    return input.currentModel
  }
  return input.availableModels.includes(candidate) ? candidate : input.currentModel
}
