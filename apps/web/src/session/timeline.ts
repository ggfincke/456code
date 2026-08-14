// apps/web/src/session/timeline.ts
// derives plan and timeline presentation state

import {
  type OrchestrationLatestTurn,
  type OrchestrationProposedPlanId,
  type OrchestrationThreadActivity,
  type ThreadId,
  type TurnId,
} from '@t3tools/contracts'
import { compareOrchestrationThreadActivities } from '@t3tools/shared/orchestrationActivityOrder'
import * as Arr from 'effect/Array'
import * as Option from 'effect/Option'

import type { ProviderSwitchTimelineEvent } from '../providerSwitchPresentation'
import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from '../types'
import { deriveWorkerVerdictEntries, type WorkerVerdictEntry, type WorkLogEntry } from './worklog'

export interface ActivePlanState
{
  createdAt: string
  turnId: TurnId | null
  explanation?: string | null
  steps: Array<{
    step: string
    status: 'pending' | 'inProgress' | 'completed'
  }>
}

export interface LatestProposedPlanState
{
  id: OrchestrationProposedPlanId
  createdAt: string
  updatedAt: string
  turnId: TurnId | null
  planMarkdown: string
  implementedAt: string | null
  implementationThreadId: ThreadId | null
}

export type TimelineEntry =
  | {
      id: string
      kind: 'message'
      createdAt: string
      message: ChatMessage
    }
  | {
      id: string
      kind: 'proposed-plan'
      createdAt: string
      proposedPlan: ProposedPlan
    }
  | {
      id: string
      kind: 'work'
      createdAt: string
      entry: WorkLogEntry
    }
  | {
      id: string
      kind: 'provider-switch'
      createdAt: string
      providerSwitch: ProviderSwitchTimelineEvent
    }
  | {
      id: string
      kind: 'worker-verdict'
      createdAt: string
      workerVerdict: WorkerVerdictEntry
    }

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null
{
  const ordered = [...activities].toSorted(compareOrchestrationThreadActivities)
  const allPlanActivities = ordered.filter((activity) => activity.kind === 'turn.plan.updated')
  // prefer plan from the current turn; fall back to the most recent plan from any turn
  // so that TodoWrite tasks persist across follow-up messages.
  const latest = Option.firstSomeOf([
    ...(latestTurnId
      ? Arr.findLast(allPlanActivities, (activity) => activity.turnId === latestTurnId)
      : Option.none()),
    Arr.last(allPlanActivities),
  ]).pipe(Option.getOrNull)
  if (!latest)
  {
    return null
  }
  const payload =
    latest.payload && typeof latest.payload === 'object'
      ? (latest.payload as Record<string, unknown>)
      : null
  const rawPlan = payload?.plan
  if (!Array.isArray(rawPlan))
  {
    return null
  }
  const steps: Array<{
    step: string
    status: 'pending' | 'inProgress' | 'completed'
  }> = []
  for (const entry of rawPlan)
  {
    if (!entry || typeof entry !== 'object')
    {
      continue
    }
    const record = entry as Record<string, unknown>
    if (typeof record.step !== 'string')
    {
      continue
    }
    const status =
      record.status === 'completed' || record.status === 'inProgress' ? record.status : 'pending'
    steps.push({
      step: record.step,
      status,
    })
  }
  if (steps.length === 0)
  {
    return null
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && 'explanation' in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  }
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null
{
  if (latestTurnId)
  {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1)
    if (matchingTurnPlan)
    {
      return toLatestProposedPlanState(matchingTurnPlan)
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1)
  if (!latestPlan)
  {
    return null
  }

  return toLatestProposedPlanState(latestPlan)
}

export function findSidebarProposedPlan(input: {
  threads: ReadonlyArray<Pick<Thread, 'id' | 'proposedPlans'>>
  latestTurn: Pick<OrchestrationLatestTurn, 'turnId' | 'sourceProposedPlan'> | null
  latestTurnSettled: boolean
  threadId: ThreadId | string | null | undefined
}): LatestProposedPlanState | null
{
  const activeThreadPlans =
    input.threads.find((thread) => thread.id === input.threadId)?.proposedPlans ?? []

  if (!input.latestTurnSettled)
  {
    const sourceProposedPlan = input.latestTurn?.sourceProposedPlan
    if (sourceProposedPlan)
    {
      const sourcePlan = input.threads
        .find((thread) => thread.id === sourceProposedPlan.threadId)
        ?.proposedPlans.find((plan) => plan.id === sourceProposedPlan.planId)
      if (sourcePlan)
      {
        return toLatestProposedPlanState(sourcePlan)
      }
    }
  }

  return findLatestProposedPlan(activeThreadPlans, input.latestTurn?.turnId ?? null)
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, 'implementedAt'> | null,
): boolean
{
  return proposedPlan !== null && proposedPlan.implementedAt === null
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState
{
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  }
}

// tie-break order for entries that share a timestamp
const TIMELINE_ENTRY_KIND_RANK = {
  message: 0,
  'proposed-plan': 1,
  work: 2,
  'provider-switch': 3,
  'worker-verdict': 4,
} as const satisfies Record<TimelineEntry['kind'], number>

function timelineEntryKindRank(entry: TimelineEntry): number
{
  return TIMELINE_ENTRY_KIND_RANK[entry.kind]
}

export function deriveTimelineEntries(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<ProposedPlan>,
  workEntries: ReadonlyArray<WorkLogEntry>,
  providerSwitchEvents: ReadonlyArray<ProviderSwitchTimelineEvent> = [],
  activities: ReadonlyArray<OrchestrationThreadActivity> = [],
): TimelineEntry[]
{
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: 'message',
    createdAt: message.createdAt,
    message,
  }))
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: 'proposed-plan',
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }))
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: 'work',
    createdAt: entry.createdAt,
    entry,
  }))
  const providerSwitchRows: TimelineEntry[] = providerSwitchEvents.map((providerSwitch) => ({
    id: providerSwitch.id,
    kind: 'provider-switch',
    createdAt: providerSwitch.createdAt,
    providerSwitch,
  }))
  const workerVerdictRows: TimelineEntry[] = deriveWorkerVerdictEntries(activities).map(
    (workerVerdict) => ({
      id: workerVerdict.id,
      kind: 'worker-verdict',
      createdAt: workerVerdict.createdAt,
      workerVerdict,
    }),
  )
  const rows = [
    ...messageRows,
    ...proposedPlanRows,
    ...workRows,
    ...providerSwitchRows,
    ...workerVerdictRows,
  ]
  const sourceOrder = new Map(rows.map((entry, index) => [entry, index]))
  return rows.toSorted((left, right) =>
  {
    const timestampOrder = left.createdAt.localeCompare(right.createdAt)
    if (timestampOrder !== 0)
    {
      return timestampOrder
    }
    const kindOrder = timelineEntryKindRank(left) - timelineEntryKindRank(right)
    return kindOrder !== 0
      ? kindOrder
      : (sourceOrder.get(left) ?? 0) - (sourceOrder.get(right) ?? 0)
  })
}

export function inferCheckpointTurnCountByTurnId(
  summaries: ReadonlyArray<TurnDiffSummary>,
): Record<TurnId, number>
{
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt))
  const result: Record<TurnId, number> = {}
  for (let index = 0; index < sorted.length; index += 1)
  {
    const summary = sorted[index]
    if (!summary) continue
    result[summary.turnId] = index + 1
  }
  return result
}

export function derivePhase(session: ThreadSession | null): SessionPhase
{
  if (
    !session ||
    session.status === 'stopped' ||
    session.status === 'interrupted' ||
    session.status === 'error'
  )
  {
    return 'disconnected'
  }
  if (session.status === 'starting') return 'connecting'
  if (session.status === 'running') return 'running'
  return 'ready'
}
