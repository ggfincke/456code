// apps/web/src/components/chat/proposedPlanGenerationStart.ts
// coordinates explicit proposal generation retries across mounted surfaces
import type { EnvironmentId, ProposalGeneration } from '@t3tools/contracts'
import { useCallback, useSyncExternalStore } from 'react'

export interface ProposalGenerationStartIdentity
{
  readonly environmentId: EnvironmentId
  readonly threadId: ProposalGeneration['threadId']
  readonly proposalId: ProposalGeneration['proposalId']
  readonly revision: number
}

export interface ProposalGenerationStartTarget
{
  readonly key: string
  readonly laneKey: string
}

export type ProposalGenerationStartState =
  | {
      readonly status: 'idle'
      readonly error: null
      readonly generation: null
      readonly attemptId: number
      readonly baselineGenerationId: ProposalGeneration['generationId'] | null
    }
  | {
      readonly status: 'starting'
      readonly error: null
      readonly generation: null
      readonly attemptId: number
      readonly baselineGenerationId: ProposalGeneration['generationId'] | null
    }
  | {
      readonly status: 'started'
      readonly error: null
      readonly generation: ProposalGeneration
      readonly attemptId: number
      readonly baselineGenerationId: ProposalGeneration['generationId'] | null
    }
  | {
      readonly status: 'failed'
      readonly error: string
      readonly generation: ProposalGeneration | null
      readonly attemptId: number
      readonly baselineGenerationId: ProposalGeneration['generationId'] | null
    }
  | {
      readonly status: 'superseded'
      readonly error: string
      readonly generation: null
      readonly attemptId: number
      readonly baselineGenerationId: ProposalGeneration['generationId'] | null
    }

type ProposalGenerationStartTransition =
  | {
      readonly type: 'claim'
      readonly attemptId: number
      readonly baselineGenerationId: ProposalGeneration['generationId'] | null
    }
  | {
      readonly type: 'started'
      readonly attemptId: number
      readonly generation: ProposalGeneration
    }
  | { readonly type: 'failed'; readonly attemptId: number; readonly error: string }
  | { readonly type: 'superseded'; readonly attemptId: number; readonly error: string }
  | {
      readonly type: 'observed-terminal'
      readonly attemptId: number
      readonly generation: ProposalGeneration
      readonly error: string
    }

export interface ProposalGenerationStartAttempt
{
  readonly key: string
  readonly laneKey: string
  readonly attemptId: number
}

export interface ProposalGenerationStartController
{
  readonly state: ProposalGenerationStartState
  readonly claimManual: (latest: ProposalGeneration | null) => ProposalGenerationStartAttempt | null
}

interface ProposalGenerationStartLane
{
  readonly key: string
  readonly attemptId: number
}

const IDLE_PROPOSAL_GENERATION_START_STATE: ProposalGenerationStartState = {
  status: 'idle',
  error: null,
  generation: null,
  attemptId: 0,
  baselineGenerationId: null,
}

const SUPERSEDED_PROPOSAL_GENERATION_START_MESSAGE =
  'The request to start exact architecture analysis was superseded by a newer revision.'

const startStates = new Map<string, ProposalGenerationStartState>()
const startLanes = new Map<string, ProposalGenerationStartLane>()
const listeners = new Set<() => void>()

function emit(): void
{
  for (const listener of listeners) listener()
}

export function createProposalGenerationStartTarget(
  identity: ProposalGenerationStartIdentity,
): ProposalGenerationStartTarget
{
  return {
    key: JSON.stringify([
      identity.environmentId,
      identity.threadId,
      identity.proposalId,
      identity.revision,
    ]),
    // the server admits one active proposal generation for the whole thread
    laneKey: JSON.stringify([identity.environmentId, identity.threadId]),
  }
}

export function createProposalGenerationStartKey(
  identity: ProposalGenerationStartIdentity,
): string
{
  return createProposalGenerationStartTarget(identity).key
}

// the retained baseline is the last fallback after a query is evicted during remount
export function proposalGenerationStartBaselineGenerationId(
  state: ProposalGenerationStartState,
  latest: ProposalGeneration | null,
): ProposalGeneration['generationId'] | null
{
  return state.generation?.generationId ?? latest?.generationId ?? state.baselineGenerationId
}

function transitionProposalGenerationStart(
  current: ProposalGenerationStartState,
  transition: ProposalGenerationStartTransition,
): ProposalGenerationStartState
{
  switch (transition.type)
  {
    case 'claim':
      return {
        status: 'starting',
        error: null,
        generation: null,
        attemptId: transition.attemptId,
        baselineGenerationId: transition.baselineGenerationId,
      }
    case 'started':
      return current.status === 'starting' && current.attemptId === transition.attemptId
        ? {
            status: 'started',
            error: null,
            generation: transition.generation,
            attemptId: current.attemptId,
            baselineGenerationId: current.baselineGenerationId,
          }
        : current
    case 'failed':
      return current.status === 'starting' && current.attemptId === transition.attemptId
        ? {
            status: 'failed',
            error: transition.error,
            generation: null,
            attemptId: current.attemptId,
            baselineGenerationId: current.baselineGenerationId,
          }
        : current
    case 'superseded':
      return current.status === 'starting' && current.attemptId === transition.attemptId
        ? {
            status: 'superseded',
            error: transition.error,
            generation: null,
            attemptId: current.attemptId,
            baselineGenerationId: current.baselineGenerationId,
          }
        : current
    case 'observed-terminal':
    {
      const terminal =
        transition.generation.state === 'failed' ||
        transition.generation.state === 'cancelled' ||
        transition.generation.state === 'abandoned'
      if (!terminal || current.attemptId !== transition.attemptId) return current
      if (current.status === 'idle')
      {
        return {
          status: 'failed',
          error: transition.error,
          generation: transition.generation,
          attemptId: current.attemptId,
          baselineGenerationId: transition.generation.generationId,
        }
      }
      if (
        current.status === 'failed' &&
        current.generation === null &&
        current.baselineGenerationId !== transition.generation.generationId
      )
      {
        return {
          status: 'failed',
          error: transition.error,
          generation: transition.generation,
          attemptId: current.attemptId,
          baselineGenerationId: current.baselineGenerationId,
        }
      }
      if (
        current.status === 'started' &&
        current.generation.generationId === transition.generation.generationId
      )
      {
        return {
          status: 'failed',
          error: transition.error,
          generation: transition.generation,
          attemptId: current.attemptId,
          baselineGenerationId: current.baselineGenerationId,
        }
      }
      return current
    }
  }
}

export function subscribeProposalGenerationStartStore(listener: () => void): () => void
{
  listeners.add(listener)
  return () =>
  {
    listeners.delete(listener)
  }
}

export function readProposalGenerationStartState(
  target: ProposalGenerationStartTarget | null,
): ProposalGenerationStartState
{
  return target === null
    ? IDLE_PROPOSAL_GENERATION_START_STATE
    : (startStates.get(target.key) ?? IDLE_PROPOSAL_GENERATION_START_STATE)
}

function applyTransition(
  target: ProposalGenerationStartTarget,
  transition: ProposalGenerationStartTransition,
): ProposalGenerationStartState
{
  const current = readProposalGenerationStartState(target)
  const next = transitionProposalGenerationStart(current, transition)
  if (next === current) return current
  startStates.set(target.key, next)
  emit()
  return next
}

function claimProposalGenerationStart(
  target: ProposalGenerationStartTarget,
  latest: ProposalGeneration | null,
): ProposalGenerationStartAttempt | null
{
  const current = readProposalGenerationStartState(target)
  const lane = startLanes.get(target.laneKey)
  if (
    lane?.key === target.key &&
    lane.attemptId === current.attemptId &&
    current.status === 'starting'
  )
  {
    return null
  }

  const attemptId = (lane?.attemptId ?? 0) + 1
  if (lane !== undefined && lane.key !== target.key)
  {
    applyTransition(
      { key: lane.key, laneKey: target.laneKey },
      {
        type: 'superseded',
        attemptId: lane.attemptId,
        error: SUPERSEDED_PROPOSAL_GENERATION_START_MESSAGE,
      },
    )
  }
  startLanes.set(target.laneKey, { key: target.key, attemptId })
  applyTransition(target, {
    type: 'claim',
    attemptId,
    baselineGenerationId: proposalGenerationStartBaselineGenerationId(current, latest),
  })
  return { ...target, attemptId }
}

export function claimManualProposalGenerationStart(
  target: ProposalGenerationStartTarget,
  latest: ProposalGeneration | null,
): ProposalGenerationStartAttempt | null
{
  return claimProposalGenerationStart(target, latest)
}

function ownsProposalGenerationStartAttempt(attempt: ProposalGenerationStartAttempt): boolean
{
  const lane = startLanes.get(attempt.laneKey)
  return lane?.key === attempt.key && lane.attemptId === attempt.attemptId
}

export function completeProposalGenerationStart(
  attempt: ProposalGenerationStartAttempt,
  generation: ProposalGeneration,
): boolean
{
  if (!ownsProposalGenerationStartAttempt(attempt)) return false
  const target = { key: attempt.key, laneKey: attempt.laneKey }
  const current = readProposalGenerationStartState(target)
  const next = applyTransition(target, {
    type: 'started',
    attemptId: attempt.attemptId,
    generation,
  })
  return next !== current
}

export function failProposalGenerationStart(
  attempt: ProposalGenerationStartAttempt,
  error: string,
): boolean
{
  if (!ownsProposalGenerationStartAttempt(attempt)) return false
  const target = { key: attempt.key, laneKey: attempt.laneKey }
  const current = readProposalGenerationStartState(target)
  const next = applyTransition(target, {
    type: 'failed',
    attemptId: attempt.attemptId,
    error,
  })
  return next !== current
}

export function recordObservedProposalGenerationFailure(
  target: ProposalGenerationStartTarget,
  attemptId: number,
  generation: ProposalGeneration,
  error: string,
): boolean
{
  const currentLane = startLanes.get(target.laneKey)
  if (currentLane === undefined)
  {
    if (attemptId !== 0) return false
    startLanes.set(target.laneKey, { key: target.key, attemptId })
  }
  else if (currentLane.key !== target.key || currentLane.attemptId !== attemptId)
  {
    return false
  }

  const current = readProposalGenerationStartState(target)
  const next = applyTransition(target, {
    type: 'observed-terminal',
    attemptId,
    generation,
    error,
  })
  return next !== current
}

export function useProposalGenerationStart(
  target: ProposalGenerationStartTarget | null,
): ProposalGenerationStartController
{
  const key = target?.key ?? null
  const laneKey = target?.laneKey ?? null
  const getSnapshot = useCallback(() => readProposalGenerationStartState(target), [key, laneKey])
  const state = useSyncExternalStore(
    subscribeProposalGenerationStartStore,
    getSnapshot,
    getSnapshot,
  )
  const claimManual = useCallback(
    (latest: ProposalGeneration | null): ProposalGenerationStartAttempt | null =>
      key === null || laneKey === null
        ? null
        : claimManualProposalGenerationStart({ key, laneKey }, latest),
    [key, laneKey],
  )

  return { state, claimManual }
}

export function resetProposalGenerationStartStoreForTests(): void
{
  startStates.clear()
  startLanes.clear()
  emit()
}
