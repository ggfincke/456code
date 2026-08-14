// apps/web/src/session-logic.ts
// exposes stable session presentation logic contracts

import { ProviderDriverKind } from '@t3tools/contracts'

export type ProviderPickerKind = ProviderDriverKind

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind
  label: string
  available: boolean
  pickerSidebarBadge?: 'new' | 'soon'
}> = [
  { value: ProviderDriverKind.make('codex'), label: 'Codex', available: true },
  { value: ProviderDriverKind.make('claudeAgent'), label: 'Claude', available: true },
  {
    value: ProviderDriverKind.make('opencode'),
    label: 'OpenCode',
    available: true,
    pickerSidebarBadge: 'new',
  },
  {
    value: ProviderDriverKind.make('cursor'),
    label: 'Cursor',
    available: true,
    pickerSidebarBadge: 'new',
  },
  {
    value: ProviderDriverKind.make('grok'),
    label: 'Grok',
    available: true,
    pickerSidebarBadge: 'new',
  },
  {
    value: ProviderDriverKind.make('coral'),
    label: 'Coral',
    available: true,
    pickerSidebarBadge: 'new',
  },
]

export {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
  type PendingUserInput,
} from './session/pending-turn'
export {
  deriveActiveWorkStartedAt,
  deriveWorkLogEntries,
  formatDuration,
  formatElapsed,
  isLatestTurnSettled,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
  type WorkLogEntry,
  type WorkLogToolLifecycleStatus,
} from './session/worklog'
export {
  deriveActivePlanState,
  derivePhase,
  deriveTimelineEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  inferCheckpointTurnCountByTurnId,
  type ActivePlanState,
  type LatestProposedPlanState,
  type TimelineEntry,
} from './session/timeline'
