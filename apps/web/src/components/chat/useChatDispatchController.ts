// apps/web/src/components/chat/useChatDispatchController.ts
// coordinates draft promotion, interruption, and provider handoff behavior

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from '@t3tools/client-runtime/state/runtime'
import { scopedThreadKey, scopeThreadRef } from '@t3tools/client-runtime/environment'
import type {
  EnvironmentId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
} from '@t3tools/contracts'
import type { UnifiedSettings } from '@t3tools/contracts/settings'
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  buildThreadTurnInterruptInput,
  chatActionErrorMessage,
  getStartedThreadModelChangeBlockReason,
  getStartedThreadProviderSwitchBlockReason,
  shouldReconcileComposerDraftModelSelection,
  threadHasStarted,
  type LocalThreadErrorEntry,
  type UserSetComposerModelSelection,
} from '../ChatView.logic'
import { resolveAppModelSelectionForInstance } from '~/modelSelection'
import { deriveProviderInstanceEntries } from '~/providerInstances'
import {
  canApplyProviderSwitchRetry,
  formatProviderSwitchFailureToastDescription,
  formatProviderSwitchSendBlockedNotice,
  formatProviderSwitchTargetLabel,
  reconcileProviderSwitchAnnouncements,
  resolveProviderSwitchRetryTarget,
  type ComposerProviderSwitchState,
  type ProviderSwitchAnnouncementState,
  type ProviderSwitchInstanceResolver,
  type ProviderSwitchTimelineEvent,
} from '~/providerSwitchPresentation'
import { type SessionPhase, type Thread } from '~/types'
import { stackedThreadToast, toastManager } from '../ui/toast'

interface UseDraftErrorPromotionInput
{
  readonly activeServerThread: Thread | null
  readonly draftId: string | null
  readonly localDraftErrorsByDraftId: Readonly<Record<string, LocalThreadErrorEntry | undefined>>
  readonly routeThreadKey: string
  readonly setLocalDraftErrorsByDraftId: Dispatch<
    SetStateAction<Record<string, LocalThreadErrorEntry>>
  >
  readonly setLocalServerErrorsByThreadKey: Dispatch<
    SetStateAction<Record<string, LocalThreadErrorEntry>>
  >
}

// keep the error-key migration at the same render position as the route
// promotion state that triggers it
export function useDraftErrorPromotion(input: UseDraftErrorPromotionInput): void
{
  const {
    activeServerThread,
    draftId,
    localDraftErrorsByDraftId,
    routeThreadKey,
    setLocalDraftErrorsByDraftId,
    setLocalServerErrorsByThreadKey,
  } = input

  useEffect(() =>
  {
    if (!activeServerThread || !draftId)
    {
      return
    }
    const pendingDraftEntry = localDraftErrorsByDraftId[draftId]
    if (pendingDraftEntry === undefined)
    {
      return
    }
    setLocalDraftErrorsByDraftId((existing) =>
    {
      if (existing[draftId] === undefined)
      {
        return existing
      }
      const next = { ...existing }
      delete next[draftId]
      return next
    })
    setLocalServerErrorsByThreadKey((existing) =>
    {
      const currentEntry = existing[routeThreadKey]
      if (
        currentEntry !== undefined &&
        (currentEntry.at > pendingDraftEntry.at ||
          currentEntry.message === pendingDraftEntry.message)
      )
      {
        return existing
      }
      return {
        ...existing,
        [routeThreadKey]: pendingDraftEntry,
      }
    })
  }, [
    activeServerThread,
    draftId,
    localDraftErrorsByDraftId,
    routeThreadKey,
    setLocalDraftErrorsByDraftId,
    setLocalServerErrorsByThreadKey,
  ])
}

interface ProviderSwitchConfirmation
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly targetModelSelection: ModelSelection
  // configured instance name plus the model it will run, so the dialog names
  // the same target the pill and the outcome do
  readonly targetLabel: string
  readonly expectedCurrentInstanceId: ProviderInstanceId
}

type InterruptThreadTurnMutation = (input: {
  readonly environmentId: EnvironmentId
  readonly input: ReturnType<typeof buildThreadTurnInterruptInput>
}) => Promise<AtomCommandResult<unknown, unknown>>

type SwitchThreadProviderMutation = (input: {
  readonly environmentId: EnvironmentId
  readonly input: {
    readonly threadId: ThreadId
    readonly targetModelSelection: ModelSelection
    readonly expectedCurrentInstanceId: ProviderInstanceId
  }
}) => Promise<AtomCommandResult<unknown, unknown>>

interface UseChatDispatchControllerInput
{
  readonly activeLatestTurnRunning: boolean
  readonly activeThread: Thread | null
  readonly composerModelSelection: ModelSelection | null
  readonly environmentId: EnvironmentId
  readonly interruptThreadTurn: InterruptThreadTurnMutation
  readonly isSendBusy: boolean
  readonly lockedProvider: ProviderDriverKind | null
  readonly pendingApprovalCount: number
  readonly pendingUserInputCount: number
  readonly phase: SessionPhase
  readonly providerStatuses: readonly ServerProvider[]
  readonly providerSwitchTimelineEvents: readonly ProviderSwitchTimelineEvent[]
  readonly resolveProviderSwitchInstance: ProviderSwitchInstanceResolver
  readonly routeKind: 'draft' | 'server'
  readonly routeThreadKey: string
  readonly routeThreadRef: ScopedThreadRef
  readonly scheduleComposerFocus: () => void
  readonly setComposerDraftModelSelection: (
    threadRef: ScopedThreadRef,
    modelSelection: ModelSelection,
    opts?: { readonly replaceOptions?: boolean },
  ) => void
  readonly setStickyComposerModelSelection: (modelSelection: ModelSelection) => void
  readonly setThreadError: (threadId: ThreadId | null, error: string | null) => void
  readonly settings: UnifiedSettings
  readonly switchThreadProvider: SwitchThreadProviderMutation
  // true only once the thread detail is live; a cached or syncing snapshot can
  // still be missing switch outcomes
  readonly threadDetailSynchronized: boolean
  readonly verifiedImportProviderInstanceId: ProviderInstanceId | null
}

export function useChatDispatchController(input: UseChatDispatchControllerInput)
{
  const {
    activeLatestTurnRunning,
    activeThread,
    composerModelSelection,
    environmentId,
    interruptThreadTurn,
    isSendBusy,
    lockedProvider,
    pendingApprovalCount,
    pendingUserInputCount,
    phase,
    providerStatuses,
    providerSwitchTimelineEvents,
    resolveProviderSwitchInstance,
    routeKind,
    routeThreadKey,
    routeThreadRef,
    scheduleComposerFocus,
    setComposerDraftModelSelection,
    setStickyComposerModelSelection,
    setThreadError,
    settings,
    switchThreadProvider,
    threadDetailSynchronized,
    verifiedImportProviderInstanceId,
  } = input
  const [providerSwitchConfirmation, setProviderSwitchConfirmation] =
    useState<ProviderSwitchConfirmation | null>(null)
  const [switchingProviderThreadKey, setSwitchingProviderThreadKey] = useState<string | null>(null)
  const isSwitchingProvider = switchingProviderThreadKey === routeThreadKey

  const activeProviderSwitch = activeThread?.providerSwitch ?? null
  const activeProviderSwitchTarget = activeProviderSwitch
    ? resolveProviderSwitchInstance(activeProviderSwitch.targetInstanceId)
    : null
  const activeProviderSwitchTargetLabel = activeProviderSwitch
    ? formatProviderSwitchTargetLabel({
        instanceId: activeProviderSwitch.targetInstanceId,
        displayName: activeProviderSwitchTarget?.displayName,
        model: activeProviderSwitch.targetModel,
      })
    : null
  const composerProviderSwitch = useMemo<ComposerProviderSwitchState | null>(
    () =>
      activeProviderSwitch
        ? {
            notice: formatProviderSwitchSendBlockedNotice(activeProviderSwitchTargetLabel),
            // a switch keeps the session "running" while it compacts, but
            // there is no turn behind it to stop
            hidesRunningTurn: !activeLatestTurnRunning,
          }
        : null,
    [activeLatestTurnRunning, activeProviderSwitch, activeProviderSwitchTargetLabel],
  )

  const providerSwitchBlockReason = getStartedThreadProviderSwitchBlockReason({
    isSwitchingProvider: isSwitchingProvider || activeProviderSwitch !== null,
    isTurnRunning: phase === 'running' || isSendBusy,
    hasPendingApproval: pendingApprovalCount > 0,
    hasPendingUserInput: pendingUserInputCount > 0,
  })
  const currentProviderInstanceId = activeThread
    ? activeThread.pendingHandoff
      ? activeThread.modelSelection.instanceId
      : (activeThread.session?.providerInstanceId ?? activeThread.modelSelection.instanceId)
    : null

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null =>
    {
      if (!activeThread)
      {
        return null
      }
      if (
        verifiedImportProviderInstanceId !== null &&
        instanceId !== verifiedImportProviderInstanceId
      )
      {
        return 'This imported session is locked to its verified provider instance until its first native turn.'
      }
      if (threadHasStarted(activeThread) && instanceId !== activeThread.modelSelection.instanceId)
      {
        return providerSwitchBlockReason
      }
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId,
        nextModelSelection: { instanceId, model },
      })
      return reason ? `${reason.description} Start a new thread to use this model.` : null
    },
    [
      activeThread,
      currentProviderInstanceId,
      providerStatuses,
      providerSwitchBlockReason,
      verifiedImportProviderInstanceId,
    ],
  )

  // the pick the user last made through the picker, with the projection it
  // superseded. The reconciliation effect reads it to tell a fresh user choice
  // from a draft that merely went stale.
  const userSetComposerSelectionRef = useRef<UserSetComposerModelSelection | null>(null)

  // `replaceOptions` marks a complete snapshot of the selection: the projection
  // is the whole truth, so options it no longer carries must go. A picker change
  // is model-only and keeps preserving the draft's existing options.
  const applyComposerModelSelection = useCallback(
    (
      threadRef: ScopedThreadRef,
      nextModelSelection: ModelSelection,
      opts?: { readonly replaceOptions?: boolean },
    ) =>
    {
      setComposerDraftModelSelection(threadRef, nextModelSelection, opts)
      setStickyComposerModelSelection(nextModelSelection)
    },
    [setComposerDraftModelSelection, setStickyComposerModelSelection],
  )

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) =>
    {
      if (!activeThread) return
      if (
        verifiedImportProviderInstanceId !== null &&
        instanceId !== verifiedImportProviderInstanceId
      )
      {
        scheduleComposerFocus()
        return
      }
      // resolve against the exact configured instance so custom provider
      // models never collapse into the built-in default
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId)
      if (!entry)
      {
        scheduleComposerFocus()
        return
      }
      const resolvedDriverKind = entry.driver
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      )
      {
        scheduleComposerFocus()
        return
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId)
      {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        )
        if (
          currentEntry?.continuation?.groupKey &&
          entry.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        )
        {
          scheduleComposerFocus()
          return
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      )
      if (!resolvedModel)
      {
        scheduleComposerFocus()
        return
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      }
      if (threadHasStarted(activeThread) && instanceId !== activeThread.modelSelection.instanceId)
      {
        if (providerSwitchBlockReason)
        {
          toastManager.add({
            type: 'warning',
            title: 'Provider switch unavailable',
            description: providerSwitchBlockReason,
          })
          scheduleComposerFocus()
          return
        }
        setProviderSwitchConfirmation({
          environmentId: activeThread.environmentId,
          threadId: activeThread.id,
          targetModelSelection: nextModelSelection,
          targetLabel: formatProviderSwitchTargetLabel({
            instanceId,
            displayName:
              deriveProviderInstanceEntries([entry])[0]?.displayName ?? entry.displayName,
            model: nextModelSelection.model,
          }),
          expectedCurrentInstanceId:
            currentProviderInstanceId ?? activeThread.modelSelection.instanceId,
        })
        return
      }
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId,
        nextModelSelection,
      })
      if (modelChangeBlockReason)
      {
        toastManager.add({
          type: 'warning',
          title: modelChangeBlockReason.title,
          description: modelChangeBlockReason.description,
        })
        scheduleComposerFocus()
        return
      }
      const targetThreadRef = scopeThreadRef(activeThread.environmentId, activeThread.id)
      // record the projection this pick replaced so the reconciliation effect
      // does not hand the thread back its older selection
      userSetComposerSelectionRef.current = {
        threadKey: scopedThreadKey(targetThreadRef),
        selection: nextModelSelection,
        supersededProjection: activeThread.modelSelection,
      }
      applyComposerModelSelection(targetThreadRef, nextModelSelection)
      scheduleComposerFocus()
    },
    [
      activeThread,
      applyComposerModelSelection,
      currentProviderInstanceId,
      lockedProvider,
      providerSwitchBlockReason,
      providerStatuses,
      scheduleComposerFocus,
      settings,
      verifiedImportProviderInstanceId,
    ],
  )

  const confirmProviderSwitch = useCallback(async () =>
  {
    const confirmation = providerSwitchConfirmation
    if (!confirmation || isSwitchingProvider)
    {
      return
    }
    const targetThreadRef = scopeThreadRef(confirmation.environmentId, confirmation.threadId)
    const targetThreadKey = scopedThreadKey(targetThreadRef)
    const targetProvider = providerStatuses.find(
      (provider) => provider.instanceId === confirmation.targetModelSelection.instanceId,
    )
    if (!targetProvider)
    {
      setProviderSwitchConfirmation(null)
      toastManager.add({
        type: 'error',
        title: 'Could not switch provider',
        description: 'The selected provider instance is no longer available.',
      })
      return
    }

    setSwitchingProviderThreadKey(targetThreadKey)
    const result = await switchThreadProvider({
      environmentId: confirmation.environmentId,
      input: {
        threadId: confirmation.threadId,
        targetModelSelection: confirmation.targetModelSelection,
        expectedCurrentInstanceId: confirmation.expectedCurrentInstanceId,
      },
    })
    // acceptance only queues the switch; the composer follows the server's
    // projected selection once the handoff completes
    if (result._tag !== 'Success' && !isAtomCommandInterrupted(result))
    {
      const error = squashAtomCommandFailure(result)
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Could not switch provider',
          description: chatActionErrorMessage(error),
        }),
      )
    }
    setProviderSwitchConfirmation((current) => (current === confirmation ? null : current))
    setSwitchingProviderThreadKey((current) => (current === targetThreadKey ? null : current))
    scheduleComposerFocus()
  }, [
    isSwitchingProvider,
    providerStatuses,
    providerSwitchConfirmation,
    scheduleComposerFocus,
    switchThreadProvider,
  ])

  const inFlightProviderSwitchTargetRef = useRef<{
    threadKey: string
    instanceId: ProviderInstanceId
    model: string | null
  } | null>(null)
  useEffect(() =>
  {
    if (activeProviderSwitch === null)
    {
      return
    }
    inFlightProviderSwitchTargetRef.current = {
      threadKey: routeThreadKey,
      instanceId: activeProviderSwitch.targetInstanceId,
      model: activeProviderSwitch.targetModel,
    }
  }, [activeProviderSwitch, routeThreadKey])

  // the retry runs long after its toast was built, so it dispatches through the
  // current selection handler. That handler re-reads the live switch block
  // reason, which keeps a retry from racing ahead of the failed projection
  // clearing this thread's providerSwitch marker.
  const onProviderModelSelectRef = useRef(onProviderModelSelect)
  useEffect(() =>
  {
    onProviderModelSelectRef.current = onProviderModelSelect
  }, [onProviderModelSelect])

  // the same handler is bound to whatever thread the route currently shows, so
  // the retry also needs the live route key to compare its captured one against
  const routeThreadKeyRef = useRef(routeThreadKey)
  useEffect(() =>
  {
    routeThreadKeyRef.current = routeThreadKey
  }, [routeThreadKey])

  // seed existing outcomes on first synchronized view so history never replays
  // as a toast
  const providerSwitchAnnouncementsRef = useRef<ProviderSwitchAnnouncementState | null>(null)
  useEffect(() =>
  {
    const decision = reconcileProviderSwitchAnnouncements({
      events: providerSwitchTimelineEvents,
      state: providerSwitchAnnouncementsRef.current,
      synchronized: threadDetailSynchronized,
      threadKey: routeThreadKey,
    })
    providerSwitchAnnouncementsRef.current = decision.state
    // the outcome belongs to the thread that was on screen when it landed;
    // scoping the toast to that ref keeps it out of every other thread's view
    const announcedThreadKey = routeThreadKey
    const announcedThreadRef = routeThreadRef
    for (const event of decision.announce)
    {
      if (event.status === 'completed')
      {
        toastManager.add(
          stackedThreadToast({
            type: 'success',
            title: 'Provider switched',
            description: event.label,
            data: { threadRef: announcedThreadRef },
          }),
        )
        continue
      }
      const retryTarget = resolveProviderSwitchRetryTarget({
        event,
        fallback: inFlightProviderSwitchTargetRef.current,
        threadKey: announcedThreadKey,
      })
      inFlightProviderSwitchTargetRef.current = null
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Provider switch failed',
          description: formatProviderSwitchFailureToastDescription({
            reasonCode: event.reasonCode,
            targetLabel: event.targetLabel,
          }),
          data: { threadRef: announcedThreadRef },
          ...(retryTarget
            ? {
                actionProps: {
                  children: 'Try again',
                  onClick: () =>
                    {
                    if (
                      !canApplyProviderSwitchRetry({
                        announcedThreadKey,
                        routeThreadKey: routeThreadKeyRef.current,
                      })
                    )
                      {
                      return
                    }
                    onProviderModelSelectRef.current(
                      retryTarget.instanceId,
                      retryTarget.model ?? '',
                    )
                  },
                },
              }
            : {}),
        }),
      )
    }
  }, [providerSwitchTimelineEvents, routeThreadKey, routeThreadRef, threadDetailSynchronized])

  const lastSyncedThreadSelectionRef = useRef<{
    threadKey: string
    selection: ModelSelection
  } | null>(null)
  const activeThreadProjectedSelection =
    routeKind === 'server' ? (activeThread?.modelSelection ?? null) : null
  const activeThreadHasStarted = routeKind === 'server' && threadHasStarted(activeThread)
  useEffect(() =>
  {
    if (activeThreadProjectedSelection === null)
    {
      lastSyncedThreadSelectionRef.current = null
      userSetComposerSelectionRef.current = null
      return
    }
    const previous = lastSyncedThreadSelectionRef.current
    lastSyncedThreadSelectionRef.current = {
      threadKey: routeThreadKey,
      selection: activeThreadProjectedSelection,
    }
    if (
      !shouldReconcileComposerDraftModelSelection({
        composerSelection: composerModelSelection,
        hasStarted: activeThreadHasStarted,
        previousProjection: previous,
        projectedSelection: activeThreadProjectedSelection,
        threadKey: routeThreadKey,
        userSetSelection: userSetComposerSelectionRef.current,
      })
    )
    {
      return
    }
    const provider = providerStatuses.find(
      (snapshot) => snapshot.instanceId === activeThreadProjectedSelection.instanceId,
    )
    if (!provider)
    {
      return
    }
    // the projection won this round, so the pick it replaced is spent
    userSetComposerSelectionRef.current = null
    applyComposerModelSelection(routeThreadRef, activeThreadProjectedSelection, {
      replaceOptions: true,
    })
  }, [
    activeThreadHasStarted,
    activeThreadProjectedSelection,
    applyComposerModelSelection,
    composerModelSelection,
    providerStatuses,
    routeThreadKey,
    routeThreadRef,
  ])

  const onInterrupt = useCallback(async () =>
  {
    if (!activeThread) return
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(activeThread),
    })
    if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
    {
      const error = squashAtomCommandFailure(result)
      setThreadError(
        activeThread.id,
        chatActionErrorMessage(error, 'Failed to interrupt the current turn.'),
      )
    }
  }, [activeThread, environmentId, interruptThreadTurn, setThreadError])

  const onProviderSwitchConfirmationOpenChange = useCallback(
    (open: boolean) =>
    {
      if (!open && !isSwitchingProvider)
      {
        setProviderSwitchConfirmation(null)
      }
    },
    [isSwitchingProvider],
  )

  return {
    activeProviderSwitch,
    activeProviderSwitchTarget,
    activeProviderSwitchTargetLabel,
    composerProviderSwitch,
    confirmProviderSwitch,
    getModelDisabledReason,
    isSwitchingProvider,
    onInterrupt,
    onProviderModelSelect,
    onProviderSwitchConfirmationOpenChange,
    providerSwitchConfirmation,
  }
}
