// apps/web/src/components/chat/orchestrate-plan/orchestratePlanStore.ts
// owns bounded revision, lifecycle, and supersession state for orchestrate plan cards
import type { ProviderInstanceId } from '@t3tools/contracts'

// a stage binding as edited in the card; provider tracks the picked model's
// driver kind when the broker can launch it, else stays with the plan's
export interface OrchestrateStageSelection
{
  provider: string
  model: string
  instanceId: ProviderInstanceId | null
}

// idle -> sending -> sent is the response path; editing means the fallback
// reply went to the composer instead, which leaves the card interactive
export type OrchestratePlanCardStatus = 'idle' | 'sending' | 'sent' | 'editing'

export interface OrchestratePlanCardState
{
  readonly selections: Readonly<Record<string, OrchestrateStageSelection>>
  // the lead's own pick, kept out of `selections` so a stage rowKey can never
  // collide with it and out of the composer draft so an unrelated composer
  // model change cannot leak into an approval
  readonly lead?: OrchestrateStageSelection | undefined
  readonly efforts: Readonly<Record<string, string>>
  readonly workers?: Readonly<Record<string, number>>
  readonly note?: string
  // null -> the plan's own maxWorkers is still in effect
  readonly maxWorkers: number | null
  readonly status: OrchestratePlanCardStatus
  readonly error: string | null
}

export const EMPTY_ORCHESTRATE_PLAN_CARD_STATE: OrchestratePlanCardState = {
  selections: {},
  efforts: {},
  maxWorkers: null,
  status: 'idle',
  error: null,
}

export interface OrchestratePlanEmissionOrder
{
  readonly messageIndex: number
  readonly planIndex: number
}

interface OrchestratePlanRevisionEpoch
{
  readonly order: OrchestratePlanEmissionOrder
  readonly tieBreaker: number
}

interface OrchestrateRunState
{
  readonly revisions: Map<string, OrchestratePlanRevisionEpoch>
  startedRevisionKey: string | null
}

const MAX_CARD_STATES = 256
const MAX_RUNS = 128
const MAX_REVISIONS_PER_RUN = 16

// cards remount whenever the timeline virtualizes, so unsent picker edits and
// lifecycle markers live outside React under their message-qualified revision
const cardStates = new Map<string, OrchestratePlanCardState>()
const runStates = new Map<string, OrchestrateRunState>()
const listeners = new Set<() => void>()
let epochTieBreaker = 0

function emit(): void
{
  for (const listener of listeners) listener()
}

function deleteOldestEntry<Key, Value>(map: Map<Key, Value>): void
{
  const oldest = map.keys().next()
  if (!oldest.done) map.delete(oldest.value)
}

function trimMap<Key, Value>(map: Map<Key, Value>, maximumSize: number): void
{
  while (map.size > maximumSize) deleteOldestEntry(map)
}

function touchRunState(runId: string, state: OrchestrateRunState): void
{
  runStates.delete(runId)
  runStates.set(runId, state)
  trimMap(runStates, MAX_RUNS)
}

function compareEmissionOrder(
  left: OrchestratePlanEmissionOrder,
  right: OrchestratePlanEmissionOrder,
): number
{
  return left.messageIndex - right.messageIndex || left.planIndex - right.planIndex
}

function compareEpoch(
  left: OrchestratePlanRevisionEpoch,
  right: OrchestratePlanRevisionEpoch,
): number
{
  return compareEmissionOrder(left.order, right.order) || left.tieBreaker - right.tieBreaker
}

function trimRunRevisions(revisions: Map<string, OrchestratePlanRevisionEpoch>): void
{
  while (revisions.size > MAX_REVISIONS_PER_RUN)
  {
    let oldest: readonly [string, OrchestratePlanRevisionEpoch] | null = null
    for (const entry of revisions)
    {
      if (oldest === null || compareEpoch(entry[1], oldest[1]) < 0) oldest = entry
    }
    if (oldest === null) return
    revisions.delete(oldest[0])
  }
}

export function subscribeOrchestratePlanStore(listener: () => void): () => void
{
  listeners.add(listener)
  return () =>
  {
    listeners.delete(listener)
  }
}

export function createOrchestratePlanCardStateKey(
  runId: string | null,
  revisionKey: string,
): string
{
  return runId === null ? `plan:${revisionKey}` : `run:${runId}:plan:${revisionKey}`
}

export function readOrchestratePlanCardState(key: string): OrchestratePlanCardState
{
  return cardStates.get(key) ?? EMPTY_ORCHESTRATE_PLAN_CARD_STATE
}

function updateCardState(
  key: string,
  updater: (current: OrchestratePlanCardState) => OrchestratePlanCardState,
): void
{
  const current = readOrchestratePlanCardState(key)
  const next = updater(current)
  if (next === current) return
  cardStates.delete(key)
  cardStates.set(key, next)
  trimMap(cardStates, MAX_CARD_STATES)
  emit()
}

export function setOrchestrateStageSelection(
  key: string,
  rowKey: string,
  selection: OrchestrateStageSelection,
): void
{
  updateCardState(key, (current) => ({
    ...current,
    selections: { ...current.selections, [rowKey]: selection },
  }))
}

export function setOrchestrateLeadSelection(
  key: string,
  selection: OrchestrateStageSelection,
): void
{
  updateCardState(key, (current) => ({ ...current, lead: selection }))
}

export function setOrchestrateStageEffort(key: string, rowKey: string, effort: string): void
{
  updateCardState(key, (current) => ({
    ...current,
    efforts: { ...current.efforts, [rowKey]: effort },
  }))
}

export function setOrchestrateStageWorkers(key: string, rowKey: string, workers: number): void
{
  updateCardState(key, (current) => ({
    ...current,
    workers: { ...current.workers, [rowKey]: workers },
  }))
}

export function setOrchestratePlanNote(key: string, note: string): void
{
  updateCardState(key, (current) => ({ ...current, note }))
}

export function setOrchestratePlanMaxWorkers(key: string, maxWorkers: number): void
{
  updateCardState(key, (current) => ({ ...current, maxWorkers }))
}

export function setOrchestratePlanCardStatus(
  key: string,
  status: OrchestratePlanCardStatus,
  error: string | null = null,
): void
{
  updateCardState(key, (current) =>
    current.status === status && current.error === error ? current : { ...current, status, error },
  )
}

// message order is supplied independently of mount order, so an older
// virtualized row can never supersede a newer row merely by mounting later
export function registerOrchestratePlanCard(
  runId: string,
  revisionKey: string,
  order: OrchestratePlanEmissionOrder,
): void
{
  const state: OrchestrateRunState = runStates.get(runId) ?? {
    revisions: new Map(),
    startedRevisionKey: null,
  }
  const current = state.revisions.get(revisionKey)
  if (current !== undefined)
  {
    touchRunState(runId, state)
    return
  }

  epochTieBreaker += 1
  state.revisions.set(revisionKey, { order, tieBreaker: epochTieBreaker })
  trimRunRevisions(state.revisions)
  touchRunState(runId, state)
  emit()
}

export function isOrchestratePlanCardSuperseded(
  runId: string,
  revisionKey: string,
  order?: OrchestratePlanEmissionOrder,
): boolean
{
  const revisions = runStates.get(runId)?.revisions
  const own = revisions?.get(revisionKey)
  if (revisions === undefined) return false
  if (own === undefined)
  {
    if (order === undefined) return false
    for (const epoch of revisions.values())
    {
      if (compareEmissionOrder(epoch.order, order) > 0) return true
    }
    return false
  }
  for (const epoch of revisions.values())
  {
    if (compareEpoch(epoch, own) > 0) return true
  }
  return false
}

export function markOrchestratePlanRevisionStarted(runId: string, revisionKey: string): void
{
  const state: OrchestrateRunState = runStates.get(runId) ?? {
    revisions: new Map(),
    startedRevisionKey: null,
  }
  if (state.startedRevisionKey === revisionKey) return
  state.startedRevisionKey = revisionKey
  touchRunState(runId, state)
  emit()
}

export function isOrchestratePlanRevisionStarted(runId: string, revisionKey: string): boolean
{
  return runStates.get(runId)?.startedRevisionKey === revisionKey
}

export function resetOrchestratePlanStoreForTests(): void
{
  cardStates.clear()
  runStates.clear()
  epochTieBreaker = 0
  emit()
}

export function readOrchestratePlanStoreSizeForTests(): {
  readonly cardStates: number
  readonly runs: number
  readonly revisions: number
}
{
  let revisions = 0
  for (const state of runStates.values()) revisions += state.revisions.size
  return { cardStates: cardStates.size, runs: runStates.size, revisions }
}

// djb2 over the plan's canonical text -> a short stable id for one rendered plan
export function hashOrchestratePlanText(text: string): string
{
  let hash = 5381
  for (let index = 0; index < text.length; index += 1)
  {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}
