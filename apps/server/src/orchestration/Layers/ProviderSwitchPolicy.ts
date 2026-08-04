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
  'Intent and decisions: state the user goal, constraints, and decisions.',
  'Workspace: state the current working directory and repo state, including branch and an uncommitted-change summary.',
  'Open requests: include pending approvals or user-input requests and their exact content.',
  'Execution: include in-flight or recently failed tool calls and their outcomes.',
  'Plan and mode: state whether the proposed plan is accepted or pending, plus the current interaction and runtime modes.',
  'Completed effects: list completed work and files changed; explicitly instruct the successor not to redo completed work.',
  'Next work: state unresolved work and distinguish proposed actions from completed tool effects.',
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
