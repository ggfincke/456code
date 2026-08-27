// packages/client-runtime/src/state/threads/threadDetail.ts
// reduces thread detail projection state

import type {
  ApprovalOutcome,
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ScopedThreadRef,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { AsyncResult, Atom } from 'effect/unstable/reactivity'

import type { EnvironmentThread, EnvironmentThreadShell } from '../session/models.ts'
import { scopeThread } from '../session/models.ts'
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from './threadState.ts'
import { parseThreadKey, threadKey } from '../workspace/entities.ts'
import { THREAD_STATE_IDLE_TTL_MS } from './threadRetention.ts'

const EMPTY_MESSAGES: ReadonlyArray<OrchestrationMessage> = Object.freeze([])
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = Object.freeze([])
const EMPTY_PROPOSED_PLANS: ReadonlyArray<OrchestrationProposedPlan> = Object.freeze([])
const EMPTY_CHECKPOINTS: ReadonlyArray<OrchestrationCheckpointSummary> = Object.freeze([])
const EMPTY_APPROVAL_OUTCOMES: ReadonlyArray<ApprovalOutcome> = Object.freeze([])

function mergeApprovalOutcomes(
  detail: ReadonlyArray<ApprovalOutcome> | undefined,
  shell: ReadonlyArray<ApprovalOutcome> | undefined,
): ReadonlyArray<ApprovalOutcome>
{
  if (detail === undefined)
  {
    return shell ?? EMPTY_APPROVAL_OUTCOMES
  }
  if (shell === undefined || shell === detail)
  {
    return detail
  }

  const outcomes = new Map(detail.map((outcome) => [outcome.requestId, outcome]))
  for (const outcome of shell)
  {
    const current = outcomes.get(outcome.requestId)
    if (current === undefined || outcome.updatedAt >= current.updatedAt)
    {
      outcomes.set(outcome.requestId, outcome)
    }
  }
  return [...outcomes.values()]
}

// combine detail-only collections with the shell's authoritative thread metadata.
//
// shell and detail subscriptions are intentionally independent. A cached detail can
// therefore briefly outlive a newer shell snapshot after reconnecting. Workspace
// consumers must use the shell branch/worktree/project fields so they do not target
// a stale checkout while retaining messages, activities, plans, and checkpoints
// from the detail subscription.
//
// * providerSwitch belongs to the same shell-authoritative group as modelSelection
//   and session: taking it from the detail lets a warm cache pair an old selection
//   with a cleared switch (or hide a newer shell's active switch), which the switch
//   pill and the composer send gate both read as a torn state.
export function mergeEnvironmentThread(
  detail: EnvironmentThread | null,
  shell: EnvironmentThreadShell | null,
): EnvironmentThread | null
{
  if (detail === null)
  {
    return null
  }
  const normalizedDetail =
    detail.approvalOutcomes === undefined
      ? { ...detail, approvalOutcomes: EMPTY_APPROVAL_OUTCOMES }
      : detail
  if (shell === null)
  {
    return normalizedDetail
  }
  if (detail.environmentId !== shell.environmentId || detail.id !== shell.id)
  {
    return normalizedDetail
  }

  return {
    ...normalizedDetail,
    environmentId: shell.environmentId,
    id: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    modelSelection: shell.modelSelection,
    providerSwitch: shell.providerSwitch,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    orchestrate: shell.orchestrate ?? false,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    // this literal enumerates every shell-sourced field, so a new shell field is
    // invisible to the detail surfaces until it is named here. the diff panel and
    // the chat view both read the merged detail, and that is exactly where a
    // 29-commit run stayed unreadable: the surfaces resolved a tree the run never
    // wrote to. an older server omits the execution key and must preserve detail,
    // while an exact-capable null owns both the retained legacy root and its clear
    ...(shell.orchestrateRunExecution === undefined
      ? {
          ...(shell.orchestrateRunWorktreePath === undefined
            ? {}
            : { orchestrateRunWorktreePath: shell.orchestrateRunWorktreePath }),
          ...(shell.orchestrateRunBranch === undefined
            ? {}
            : { orchestrateRunBranch: shell.orchestrateRunBranch }),
        }
      : shell.orchestrateRunExecution === null
        ? {
            orchestrateRunExecution: null,
            orchestrateRunWorktreePath: shell.orchestrateRunWorktreePath ?? null,
            orchestrateRunBranch: shell.orchestrateRunBranch ?? null,
          }
        : {
            orchestrateRunExecution: shell.orchestrateRunExecution,
            orchestrateRunWorktreePath:
              shell.orchestrateRunExecution.availability === 'available'
                ? shell.orchestrateRunExecution.integrationRoot
                : null,
            orchestrateRunBranch:
              shell.orchestrateRunExecution.availability === 'available'
                ? shell.orchestrateRunExecution.integrationBranch
                : null,
          }),
    origin: shell.origin,
    latestTurn: shell.latestTurn,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    archivedAt: shell.archivedAt,
    settledOverride: shell.settledOverride,
    settledAt: shell.settledAt,
    unsettledAt: shell.unsettledAt ?? null,
    snoozedUntil: shell.snoozedUntil,
    snoozedAt: shell.snoozedAt,
    session: shell.session,
    approvalOutcomes: mergeApprovalOutcomes(detail.approvalOutcomes, shell.approvalOutcomes),
  }
}

export function createEnvironmentThreadDetailAtoms<E>(
  threadStateAtom: (
    environmentId: ScopedThreadRef['environmentId'],
    threadId: ScopedThreadRef['threadId'],
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>,
)
{
  const threadStateValueAtomFamily = Atom.family((key: string) =>
  {
    const ref = parseThreadKey(key)
    return Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(threadStateAtom(ref.environmentId, ref.threadId))),
        () => EMPTY_ENVIRONMENT_THREAD_STATE,
      ),
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-state-value:${key}`),
    )
  })

  const threadDetailAtomFamily = Atom.family((key: string) =>
  {
    const ref = parseThreadKey(key)
    let previousSource: OrchestrationThread | null = null
    let previousValue: EnvironmentThread | null = null
    return Atom.make((get) =>
    {
      const source = Option.getOrNull(get(threadStateValueAtomFamily(key)).data)
      if (source === previousSource)
      {
        return previousValue
      }
      previousSource = source
      previousValue =
        source === null
          ? null
          : scopeThread(ref.environmentId, {
              ...source,
              approvalOutcomes: source.approvalOutcomes ?? EMPTY_APPROVAL_OUTCOMES,
            })
      return previousValue
    }).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-detail:${key}`),
    )
  })

  const threadStatusAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).status).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-status:${key}`),
    ),
  )

  const threadErrorAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => Option.getOrNull(get(threadStateValueAtomFamily(key)).error)).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-error:${key}`),
    ),
  )

  const threadMessagesAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationMessage> =>
        get(threadDetailAtomFamily(key))?.messages ?? EMPTY_MESSAGES,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-messages:${key}`),
    ),
  )

  const threadActivitiesAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationThreadActivity> =>
        get(threadDetailAtomFamily(key))?.activities ?? EMPTY_ACTIVITIES,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-activities:${key}`),
    ),
  )

  const threadProposedPlansAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationProposedPlan> =>
        get(threadDetailAtomFamily(key))?.proposedPlans ?? EMPTY_PROPOSED_PLANS,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-proposed-plans:${key}`),
    ),
  )

  const threadCheckpointsAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationCheckpointSummary> =>
        get(threadDetailAtomFamily(key))?.checkpoints ?? EMPTY_CHECKPOINTS,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-checkpoints:${key}`),
    ),
  )

  const threadSessionAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): OrchestrationSession | null => get(threadDetailAtomFamily(key))?.session ?? null,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-session:${key}`),
    ),
  )

  const threadLatestTurnAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): OrchestrationLatestTurn | null => get(threadDetailAtomFamily(key))?.latestTurn ?? null,
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-latest-turn:${key}`),
    ),
  )

  return {
    stateAtom: (ref: ScopedThreadRef) => threadStateValueAtomFamily(threadKey(ref)),
    detailAtom: (ref: ScopedThreadRef) => threadDetailAtomFamily(threadKey(ref)),
    statusAtom: (ref: ScopedThreadRef) => threadStatusAtomFamily(threadKey(ref)),
    errorAtom: (ref: ScopedThreadRef) => threadErrorAtomFamily(threadKey(ref)),
    messagesAtom: (ref: ScopedThreadRef) => threadMessagesAtomFamily(threadKey(ref)),
    activitiesAtom: (ref: ScopedThreadRef) => threadActivitiesAtomFamily(threadKey(ref)),
    proposedPlansAtom: (ref: ScopedThreadRef) => threadProposedPlansAtomFamily(threadKey(ref)),
    checkpointsAtom: (ref: ScopedThreadRef) => threadCheckpointsAtomFamily(threadKey(ref)),
    sessionAtom: (ref: ScopedThreadRef) => threadSessionAtomFamily(threadKey(ref)),
    latestTurnAtom: (ref: ScopedThreadRef) => threadLatestTurnAtomFamily(threadKey(ref)),
  }
}
