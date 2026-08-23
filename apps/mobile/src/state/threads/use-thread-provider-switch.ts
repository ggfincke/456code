// apps/mobile/src/state/threads/use-thread-provider-switch.ts
// drives confirmed provider switches and their lifecycle notice for the selected thread

import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderRuntimeCapabilities,
} from '@t3tools/contracts'
import { hasBlockingApprovalOutcome } from '@t3tools/client-runtime/state/thread-settled'
import { useCallback, useMemo, useState } from 'react'
import { Alert } from 'react-native'

import { scopedThreadKey } from '../../lib/scopedEntities'
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  sortThreadActivities,
} from '../../lib/threadActivity'
import {
  deriveLatestProviderSwitchOutcome,
  formatProviderSwitchTargetLabel,
  providerSwitchBlockReason,
  providerSwitchConfirmationCopy,
  PROVIDER_SWITCH_BLOCKED_TITLE,
  resolveThreadProviderSwitchNotice,
  threadProviderSwitchRequired,
  type ThreadProviderSwitchNotice,
} from '../../lib/thread-activity/provider-switch'
import { threadEnvironment } from './threads'
import { useAtomCommand } from '../use-atom-command'
import {
  updateComposerDraftSettings,
  type ComposerDraftSettingsUpdate,
} from './use-composer-drafts'
import { useRemoteEnvironmentRuntime } from '../use-remote-environment-registry'
import { useSelectedThreadDetail } from './use-thread-detail'
import { useThreadSelection } from './use-thread-selection'

export interface ThreadProviderSwitchState
{
  // a switch is in flight: the composer must read as busy and uncancelable.
  readonly active: boolean
  // why a handoff cannot start right now, or null when one may start.
  readonly blockReason: string | null
  readonly notice: ThreadProviderSwitchNotice | null
  readonly onDismissNotice: () => void
  readonly onRetry: () => void
  // returns true when the selection was routed through the switch flow, so the
  // caller must not also write it into the local draft.
  readonly requestProviderSwitch: (selection: ModelSelection) => boolean
}

interface DismissedOutcome
{
  readonly threadKey: string
  readonly outcomeId: string
}

export function resolveConfirmedProviderSwitchDraftSettings(
  capabilities: Pick<ProviderRuntimeCapabilities, 'defaultRuntimeMode'> | undefined,
): ComposerDraftSettingsUpdate
{
  return {
    modelSelection: undefined,
    ...(capabilities?.defaultRuntimeMode !== undefined
      ? { runtimeMode: capabilities.defaultRuntimeMode }
      : {}),
  }
}

export function useThreadProviderSwitch(): ThreadProviderSwitchState
{
  const { selectedThread } = useThreadSelection()
  const selectedThreadDetail = useSelectedThreadDetail()
  const environmentRuntime = useRemoteEnvironmentRuntime(selectedThread?.environmentId ?? null)
  const switchProvider = useAtomCommand(threadEnvironment.switchProvider, 'thread provider switch')
  const [dismissed, setDismissed] = useState<DismissedOutcome | null>(null)

  const threadKey = selectedThread
    ? scopedThreadKey(selectedThread.environmentId, selectedThread.id)
    : null
  const providerSwitch = selectedThread?.providerSwitch ?? null
  const activities = selectedThreadDetail?.activities
  const latestOutcome = useMemo(
    () => (activities ? deriveLatestProviderSwitchOutcome(activities) : null),
    [activities],
  )

  // the pre-flight gate reads the same four conditions as web. Pending state is
  // merged from three sources on purpose: a shell synthesized from detail
  // reports both pending flags as false (thread-shell-fallback.ts), so only an
  // OR keeps that fallback from clearing an authoritative approval outcome.
  const sortedActivities = useMemo(
    () => (activities ? sortThreadActivities(activities) : []),
    [activities],
  )
  const approvalOutcomeSource = selectedThreadDetail ?? selectedThread
  const hasPendingApproval = useMemo(
    () =>
      (selectedThread?.hasPendingApprovals ?? false) ||
      (approvalOutcomeSource !== null && hasBlockingApprovalOutcome(approvalOutcomeSource)) ||
      derivePendingApprovals(sortedActivities, approvalOutcomeSource?.approvalOutcomes).length > 0,
    [approvalOutcomeSource, selectedThread?.hasPendingApprovals, sortedActivities],
  )
  const hasPendingUserInput = useMemo(
    () =>
      (selectedThread?.hasPendingUserInput ?? false) ||
      derivePendingUserInputs(sortedActivities).length > 0,
    [selectedThread?.hasPendingUserInput, sortedActivities],
  )
  // a live session is mobile's running turn, the same rule the composer uses to
  // read the thread as busy.
  const blockReason = providerSwitchBlockReason({
    isSwitchingProvider: providerSwitch !== null,
    isTurnRunning:
      selectedThread?.session?.status === 'running' ||
      selectedThread?.session?.status === 'starting',
    hasPendingApproval,
    hasPendingUserInput,
  })

  const providers = environmentRuntime?.serverConfig?.providers
  const resolveInstanceDisplayName = useCallback(
    (instanceId: ProviderInstanceId) =>
      providers?.find((provider) => provider.instanceId === instanceId)?.displayName ?? null,
    [providers],
  )

  const notice = useMemo(
    () =>
      resolveThreadProviderSwitchNotice({
        providerSwitch,
        latestOutcome,
        dismissedOutcomeId:
          dismissed !== null && dismissed.threadKey === threadKey ? dismissed.outcomeId : null,
        resolveInstanceDisplayName,
      }),
    [dismissed, latestOutcome, providerSwitch, resolveInstanceDisplayName, threadKey],
  )

  const dispatchSwitch = useCallback(
    (selection: ModelSelection) =>
    {
      if (!selectedThread)
      {
        return
      }
      // the draft's provider override would keep naming the outgoing instance
      // once the handoff lands. Drop that one setting — draft text, images, and
      // the outbox are untouched — so the composer tracks the thread's real
      // provider for the whole switch. Runtime mode changes with the confirmed
      // dispatch so blocked or canceled switches leave the draft untouched.
      const targetCapabilities = providers?.find(
        (provider) => provider.instanceId === selection.instanceId,
      )?.capabilities
      updateComposerDraftSettings(
        scopedThreadKey(selectedThread.environmentId, selectedThread.id),
        resolveConfirmedProviderSwitchDraftSettings(targetCapabilities),
      )
      void switchProvider({
        environmentId: selectedThread.environmentId,
        input: {
          threadId: selectedThread.id,
          targetModelSelection: selection,
          expectedCurrentInstanceId: selectedThread.modelSelection.instanceId,
        },
      })
    },
    [providers, selectedThread, switchProvider],
  )

  const onDismissNotice = useCallback(() =>
  {
    if (threadKey === null || notice === null || notice.kind === 'switching')
    {
      return
    }
    setDismissed({ threadKey, outcomeId: notice.outcomeId })
  }, [notice, threadKey])

  // retry re-dispatches the outcome's durable target, so a failure survives an
  // app restart with a working retry instead of only an in-memory one.
  const onRetry = useCallback(() =>
  {
    if (threadKey === null || notice === null || notice.kind !== 'failed')
    {
      return
    }
    const selection = notice.retrySelection
    if (selection === null)
    {
      return
    }
    setDismissed({ threadKey, outcomeId: notice.outcomeId })
    dispatchSwitch(selection)
  }, [dispatchSwitch, notice, threadKey])

  const requestProviderSwitch = useCallback(
    (selection: ModelSelection) =>
    {
      if (!selectedThread)
      {
        return false
      }
      const threadStarted =
        selectedThread.session !== null ||
        selectedThread.latestTurn !== null ||
        selectedThread.latestUserMessageAt !== null
      if (
        !threadProviderSwitchRequired({
          threadStarted,
          currentInstanceId: selectedThread.modelSelection.instanceId,
          nextInstanceId: selection.instanceId,
        })
      )
      {
        return false
      }
      // the handoff is refused, not deferred: returning true keeps the rejected
      // selection out of the draft so the composer keeps naming the provider
      // the thread is actually on.
      if (blockReason !== null)
      {
        Alert.alert(PROVIDER_SWITCH_BLOCKED_TITLE, blockReason)
        return true
      }

      const copy = providerSwitchConfirmationCopy(
        formatProviderSwitchTargetLabel({
          instanceId: selection.instanceId,
          displayName: resolveInstanceDisplayName(selection.instanceId),
          model: selection.model,
        }),
      )
      Alert.alert(copy.title, copy.message, [
        { text: 'Cancel', style: 'cancel' },
        { text: copy.confirmLabel, onPress: () => dispatchSwitch(selection) },
      ])
      return true
    },
    [blockReason, dispatchSwitch, resolveInstanceDisplayName, selectedThread],
  )

  return {
    active: providerSwitch !== null,
    blockReason,
    notice,
    onDismissNotice,
    onRetry,
    requestProviderSwitch,
  }
}
