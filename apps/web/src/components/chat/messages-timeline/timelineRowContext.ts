// apps/web/src/components/chat/messages-timeline/timelineRowContext.ts
// shared timeline row context and row type aliases

import {
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type TurnId,
} from '@t3tools/contracts'
import { type TimestampFormat } from '@t3tools/contracts/settings'
import { createContext } from 'react'

import { deriveTimelineEntries } from '../../../session-logic'
import { type MessagesTimelineRow } from './MessagesTimeline.logic'
import type { OrchestratePlanActions } from '../OrchestratePlanCard'
import { type ExpandedImagePreview } from '../ExpandedImagePreview'

export interface TimelineRowSharedState
{
  timestampFormat: TimestampFormat
  routeThreadKey: string
  threadRef: ScopedThreadRef | null
  markdownCwd: string | undefined
  resolvedTheme: 'light' | 'dark'
  workspaceRoot: string | undefined
  skills: ReadonlyArray<Pick<ServerProviderSkill, 'name' | 'displayName'>>
  activeThreadEnvironmentId: EnvironmentId
  onRevertUserMessage: (messageId: MessageId) => void
  onImageExpand: (preview: ExpandedImagePreview) => void
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void
  onToggleTurnFold: (turnId: TurnId) => void
  onToggleWorkGroup: (groupId: string, anchorElement?: HTMLElement) => void
  orchestratePlanActions?: OrchestratePlanActions | undefined
}

export interface TimelineRowActivityState
{
  isWorking: boolean
  isRevertingCheckpoint: boolean
  activeTurnInProgress: boolean
  latestTurnId: TurnId | null
}

export const TimelineRowCtx = createContext<TimelineRowSharedState>(null!)
export const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!)

export type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number]
export type TimelineMessage = Extract<TimelineEntry, { kind: 'message' }>['message']
export type TimelineWorkEntry = Extract<
  MessagesTimelineRow,
  { kind: 'work' }
>['groupedEntries'][number]
export type TimelineRow = MessagesTimelineRow
