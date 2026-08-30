// apps/mobile/src/features/home/useThreadListActions.ts
// manage thread list actions through a React hook

import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'
import { canSettle } from '@t3tools/client-runtime/state/thread-settled'
import * as Cause from 'effect/Cause'
import * as Haptics from 'expo-haptics'
import { useCallback, useRef } from 'react'
import { Alert } from 'react-native'

import { showConfirmDialog } from '../../components/ConfirmDialogHost'
import { scopedThreadKey } from '../../lib/scopedEntities'
import { refreshArchivedThreadsForEnvironment } from '../archive/useArchivedThreadSnapshots'
import { appAtomRegistry } from '../../state/atom-registry'
import { environmentServerConfigsAtom } from '../../state/server'
import { threadEnvironment } from '../../state/threads'
import { useAtomCommand } from '../../state/use-atom-command'
import { canPinThread, isImportedHistoryOnlyThread } from '../threads/thread-list-pinning'

// version skew: never send settle/unsettle to a server that predates them
// (capability defaults false on decode for older servers).
function environmentSupportsSettlement(environmentId: EnvironmentThreadShell['environmentId'])
{
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  )
}

// version skew: pin controls stay hidden and commands stay local when the
// connected server predates thread.pin/thread.unpin.
function environmentSupportsPinning(environmentId: EnvironmentThreadShell['environmentId'])
{
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinning === true
  )
}

type ThreadListAction = 'archive' | 'unarchive' | 'delete' | 'settle' | 'unsettle' | 'pin' | 'unpin'

const ACTION_VERBS: Record<ThreadListAction, string> = {
  archive: 'archived',
  unarchive: 'unarchived',
  delete: 'deleted',
  settle: 'settled',
  unsettle: 'un-settled',
  pin: 'pinned',
  unpin: 'unpinned',
}

function actionFailureMessage(action: ThreadListAction, cause: Cause.Cause<unknown>): string
{
  const error = Cause.squash(cause)
  if (error instanceof Error && error.message.trim().length > 0)
  {
    return error.message
  }
  return `The thread could not be ${ACTION_VERBS[action]}.`
}

function selectionHaptic(): void
{
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
}

function actionFailureTitle(action: ThreadListAction): string
{
  if (action === 'archive') return 'Could not archive thread'
  if (action === 'unarchive') return 'Could not unarchive thread'
  if (action === 'settle') return 'Could not settle thread'
  if (action === 'unsettle') return 'Could not un-settle thread'
  if (action === 'pin') return 'Could not pin thread'
  if (action === 'unpin') return 'Could not unpin thread'
  return 'Could not delete thread'
}

// resolves to true iff the action was dispatched and succeeded.
function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
)
{
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false })
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false })
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false })
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false })
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false })
  const pinMutation = useAtomCommand(threadEnvironment.pin, { reportFailure: false })
  const unpinMutation = useAtomCommand(threadEnvironment.unpin, { reportFailure: false })
  const inFlightThreadKeys = useRef(new Set<string>())

  const executeAction = useCallback(
    async (action: ThreadListAction, thread: EnvironmentThreadShell) =>
    {
      const key = scopedThreadKey(thread.environmentId, thread.id)
      if (inFlightThreadKeys.current.has(key))
      {
        return false
      }

      inFlightThreadKeys.current.add(key)
      selectionHaptic()
      try
      {
        if (
          (action === 'settle' || action === 'unsettle') &&
          !environmentSupportsSettlement(thread.environmentId)
        )
        {
          Alert.alert(
            actionFailureTitle(action),
            "This environment's server does not support settling yet. Update the server to use Settle.",
          )
          return false
        }
        if (
          (action === 'pin' || action === 'unpin') &&
          !canPinThread(thread, environmentSupportsPinning(thread.environmentId))
        )
        {
          Alert.alert(
            actionFailureTitle(action),
            isImportedHistoryOnlyThread(thread)
              ? 'Imported history-only threads cannot be pinned.'
              : "This environment's server does not support pinning yet. Update the server to use Pin.",
          )
          return false
        }
        // settle may only target what effectiveSettled could classify as
        // settled: not starting/running sessions, not threads waiting on
        // approvals or user input. Anything else would hide live work.
        if (action === 'settle' && !canSettle(thread, { now: new Date().toISOString() }))
        {
          Alert.alert(
            actionFailureTitle(action),
            'This thread still needs attention. Resolve or interrupt it first, then try again.',
          )
          return false
        }
        // archive keeps its original, narrower guard: never interrupt a
        // thread mid-turn.
        if (
          action === 'archive' &&
          thread.session?.status === 'running' &&
          thread.session.activeTurnId != null
        )
        {
          Alert.alert(
            actionFailureTitle(action),
            'This thread is working. Interrupt it first, then try again.',
          )
          return false
        }
        // a user unsettle pin suppresses auto-settle until real activity clears it server-side
        const result =
          action === 'unsettle'
            ? await unsettleMutation({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, reason: 'user' },
              })
            : await (
                action === 'settle'
                  ? settleMutation
                  : action === 'pin'
                    ? pinMutation
                    : action === 'unpin'
                      ? unpinMutation
                      : action === 'archive'
                        ? archiveMutation
                        : action === 'unarchive'
                          ? unarchiveMutation
                          : deleteMutation
              )({
                environmentId: thread.environmentId,
                input: { threadId: thread.id },
              })
        if (result._tag === 'Failure')
        {
          Alert.alert(actionFailureTitle(action), actionFailureMessage(action, result.cause))
          return false
        }
        // settled threads stay in the live shell stream; only the archive
        // lifecycle still feeds the archived-snapshot surface.
        if (action === 'archive' || action === 'unarchive' || action === 'delete')
        {
          refreshArchivedThreadsForEnvironment(thread.environmentId)
        }
        onCompleted?.(action, thread)
        return true
      }
      finally
      {
        inFlightThreadKeys.current.delete(key)
      }
    },
    [
      archiveMutation,
      deleteMutation,
      onCompleted,
      pinMutation,
      settleMutation,
      unarchiveMutation,
      unpinMutation,
      unsettleMutation,
    ],
  )

  return executeAction
}

function useConfirmDeleteThread(
  executeAction: (action: ThreadListAction, thread: EnvironmentThreadShell) => Promise<boolean>,
)
{
  return useCallback(
    (thread: EnvironmentThreadShell) =>
    {
      const title = 'Delete thread?'
      const message = `“${thread.title}” will be permanently deleted, including its terminal history.`
      if (process.env.EXPO_OS === 'ios')
      {
        Alert.alert(title, message, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () =>
            {
              void executeAction('delete', thread)
            },
          },
        ])
        return
      }
      showConfirmDialog({
        title,
        message,
        confirmText: 'Delete',
        destructive: true,
        onConfirm: () =>
        {
          void executeAction('delete', thread)
        },
      })
    },
    [executeAction],
  )
}

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => void
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void
  readonly settleThread: (thread: EnvironmentThreadShell) => Promise<boolean>
  readonly unsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>
  readonly pinThread: (thread: EnvironmentThreadShell) => Promise<boolean>
  readonly unpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>
}
{
  const executeAction = useThreadActionExecutor()

  const archiveThread = useCallback(
    (thread: EnvironmentThreadShell) =>
    {
      void executeAction('archive', thread)
    },
    [executeAction],
  )
  const settleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction('settle', thread)) === true,
    [executeAction],
  )
  const unsettleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction('unsettle', thread)) === true,
    [executeAction],
  )
  const pinThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction('pin', thread)) === true,
    [executeAction],
  )
  const unpinThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction('unpin', thread)) === true,
    [executeAction],
  )

  const confirmDeleteThread = useConfirmDeleteThread(executeAction)

  return {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    unsettleThread,
    pinThread,
    unpinThread,
  }
}

export function useArchivedThreadListActions(
  onCompleted: (thread: EnvironmentThreadShell) => void,
): {
  readonly unarchiveThread: (thread: EnvironmentThreadShell) => void
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void
}
{
  const handleCompleted = useCallback(
    (_action: ThreadListAction, thread: EnvironmentThreadShell) =>
    {
      onCompleted(thread)
    },
    [onCompleted],
  )
  const executeAction = useThreadActionExecutor(handleCompleted)
  const unarchiveThread = useCallback(
    (thread: EnvironmentThreadShell) =>
    {
      void executeAction('unarchive', thread)
    },
    [executeAction],
  )
  const confirmDeleteThread = useConfirmDeleteThread(executeAction)

  return { unarchiveThread, confirmDeleteThread }
}
