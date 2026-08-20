// apps/web/src/components/chat/messages-timeline/TimelineRows.tsx
// renders timeline message, work, plan, verdict, and fold rows

import { memo } from 'react'
import { cn } from '~/lib/utils'

import { AssistantTimelineRow } from './AssistantTimelineRow'
import {
  OrchestratePlanTimelineRow,
  ProposedPlanTimelineRow,
  ProviderSwitchTimelineRow,
  TurnFoldTimelineRow,
  WorkerVerdictTimelineRow,
} from './MiscTimelineRows'
import { UserTimelineRow } from './UserTimelineRow'
import {
  LiveWorkEntryTimelineRow,
  WorkGroupSection,
  WorkGroupToggleTimelineRow,
  WorkingTimelineRow,
} from './WorkTimelineRows'
import { TimelineRowActivityCtx, TimelineRowCtx, type TimelineRow } from './timelineRowContext'

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow })
{
  const isExpandedToolGroupEntry = row.kind === 'work' && row.isExpandedToolGroupEntry
  const isLastExpandedToolGroupEntry = row.kind === 'work' && row.isLastExpandedToolGroupEntry
  const isExpandedToolGroupHeader =
    (row.kind === 'work-toggle' && row.summary !== null && row.onlyToolEntries && row.expanded) ||
    (row.kind === 'work-live' && row.expanded)

  return (
    <div
      className={cn(
        // commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        isExpandedToolGroupEntry
          ? isLastExpandedToolGroupEntry
            ? 'pb-1'
            : 'pb-0'
          : isExpandedToolGroupHeader
            ? 'pb-0'
            : row.kind === 'turn-fold' || row.kind === 'working'
              ? 'pb-1.5'
              : (row.kind === 'message' &&
                    row.message.role === 'assistant' &&
                    !row.showAssistantMeta) ||
                  row.kind === 'work' ||
                  row.kind === 'work-live' ||
                  row.kind === 'work-toggle'
                ? 'pb-2'
                : 'pb-4',
        row.kind === 'message' && row.message.role === 'assistant' ? 'group/assistant' : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === 'message' ? row.message.id : undefined}
      data-message-role={row.kind === 'message' ? row.message.role : undefined}
    >
      {row.kind === 'work' ? (
        <WorkGroupSection
          groupedEntries={row.groupedEntries}
          isExpandedToolGroupEntry={row.isExpandedToolGroupEntry}
        />
      ) : null}
      {row.kind === 'work-live' ? <LiveWorkEntryTimelineRow row={row} /> : null}
      {row.kind === 'work-toggle' ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === 'turn-fold' ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === 'message' && row.message.role === 'user' ? <UserTimelineRow row={row} /> : null}
      {row.kind === 'message' && row.message.role === 'assistant' ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === 'proposed-plan' ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === 'orchestrate-plan' ? <OrchestratePlanTimelineRow row={row} /> : null}
      {row.kind === 'provider-switch' ? <ProviderSwitchTimelineRow row={row} /> : null}
      {row.kind === 'worker-verdict' ? <WorkerVerdictTimelineRow row={row} /> : null}
      {row.kind === 'working' ? <WorkingTimelineRow row={row} /> : null}
    </div>
  )
})

export { TimelineRowActivityCtx, TimelineRowContent, TimelineRowCtx }
export type { TimelineRowActivityState, TimelineRowSharedState } from './timelineRowContext'
