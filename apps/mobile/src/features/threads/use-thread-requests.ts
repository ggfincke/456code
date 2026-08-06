// apps/mobile/src/features/threads/use-thread-requests.ts
// adds multi-answer input support to selected thread requests

import { useAtomValue } from '@effect/atom-react'
import {
  ApprovalRequestId,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
} from '@t3tools/contracts'
import { Atom } from 'effect/unstable/reactivity'
import { useCallback, useMemo, useState } from 'react'

import { scopedRequestKey } from '../../lib/scopedEntities'
import { appAtomRegistry } from '../../state/atom-registry'
import { threadEnvironment } from '../../state/threads'
import { useAtomCommand } from '../../state/use-atom-command'
import { useSelectedThreadRequests } from '../../state/use-selected-thread-requests'
import { useThreadSelection } from '../../state/use-thread-selection'

export interface MobilePendingUserInputDraftAnswer
{
  readonly selectedOptionLabels?: ReadonlyArray<string>
  readonly customAnswer?: string
}

const multiSelectionsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, ReadonlyArray<string>>>
>({}).pipe(Atom.keepAlive, Atom.withLabel('mobile:multi-user-input-selections'))

function normalizeOptionLabels(labels: ReadonlyArray<string> | undefined): ReadonlyArray<string>
{
  return labels?.filter((label) => label.trim().length > 0) ?? []
}

function updateMultiSelection(requestKey: string, questionId: string, label: string): void
{
  const current = appAtomRegistry.get(multiSelectionsByRequestKeyAtom)
  const selected = normalizeOptionLabels(current[requestKey]?.[questionId])
  const next = selected.includes(label)
    ? selected.filter((selectedLabel) => selectedLabel !== label)
    : [...selected, label]
  appAtomRegistry.set(multiSelectionsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [questionId]: next,
    },
  })
}

function clearMultiSelection(requestKey: string, questionId: string): void
{
  const current = appAtomRegistry.get(multiSelectionsByRequestKeyAtom)
  const requestSelections = current[requestKey]
  if (!requestSelections?.[questionId])
  {
    return
  }
  const nextRequestSelections = { ...requestSelections }
  delete nextRequestSelections[questionId]
  appAtomRegistry.set(multiSelectionsByRequestKeyAtom, {
    ...current,
    [requestKey]: nextRequestSelections,
  })
}

function resolveUserInputAnswer(
  question: UserInputQuestion,
  draft: MobilePendingUserInputDraftAnswer | undefined,
): string | ReadonlyArray<string> | null
{
  const customAnswer = draft?.customAnswer?.trim()
  if (customAnswer)
  {
    return customAnswer
  }

  const selectedOptionLabels = normalizeOptionLabels(draft?.selectedOptionLabels)
  if (question.multiSelect)
  {
    return selectedOptionLabels.length > 0 ? selectedOptionLabels : null
  }
  return selectedOptionLabels[0] ?? null
}

export function buildMobilePendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  drafts: Record<string, MobilePendingUserInputDraftAnswer>,
): ProviderUserInputAnswers | null
{
  const answers: Record<string, unknown> = {}
  for (const question of questions)
  {
    const answer = resolveUserInputAnswer(question, drafts[question.id])
    if (answer === null)
    {
      return null
    }
    answers[question.id] = answer
  }
  return answers satisfies ProviderUserInputAnswers
}

export function useThreadRequests()
{
  const requests = useSelectedThreadRequests()
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    'thread user input response',
  )
  const { selectedThread } = useThreadSelection()
  const multiSelectionsByRequestKey = useAtomValue(multiSelectionsByRequestKeyAtom)
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(null)
  const pendingUserInput = requests.activePendingUserInput
  const requestKey =
    pendingUserInput && selectedThread
      ? scopedRequestKey(selectedThread.environmentId, pendingUserInput.requestId)
      : null
  const activePendingUserInputDrafts = useMemo(() =>
  {
    if (!pendingUserInput || !requestKey)
    {
      return {}
    }

    return Object.fromEntries(
      pendingUserInput.questions.map((question) =>
      {
        const baseDraft = requests.activePendingUserInputDrafts[question.id]
        const selectedOptionLabels = question.multiSelect
          ? multiSelectionsByRequestKey[requestKey]?.[question.id]
          : baseDraft?.selectedOptionLabel
            ? [baseDraft.selectedOptionLabel]
            : undefined
        return [
          question.id,
          {
            ...(baseDraft?.customAnswer !== undefined
              ? { customAnswer: baseDraft.customAnswer }
              : {}),
            ...(selectedOptionLabels ? { selectedOptionLabels } : {}),
          },
        ]
      }),
    )
  }, [
    multiSelectionsByRequestKey,
    pendingUserInput,
    requestKey,
    requests.activePendingUserInputDrafts,
  ])
  const activePendingUserInputAnswers = pendingUserInput
    ? buildMobilePendingUserInputAnswers(pendingUserInput.questions, activePendingUserInputDrafts)
    : null

  const onSelectUserInputOption = useCallback(
    (requestId: ApprovalRequestId, questionId: string, label: string) =>
    {
      const question = pendingUserInput?.questions.find((entry) => entry.id === questionId)
      if (!question || !selectedThread)
      {
        return
      }
      if (!question.multiSelect)
      {
        requests.onSelectUserInputOption(requestId, questionId, label)
        return
      }

      updateMultiSelection(
        scopedRequestKey(selectedThread.environmentId, requestId),
        questionId,
        label,
      )
      requests.onChangeUserInputCustomAnswer(requestId, questionId, '')
    },
    [pendingUserInput?.questions, requests, selectedThread],
  )

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: ApprovalRequestId, questionId: string, customAnswer: string) =>
    {
      requests.onChangeUserInputCustomAnswer(requestId, questionId, customAnswer)
      if (selectedThread && customAnswer.trim().length > 0)
      {
        clearMultiSelection(scopedRequestKey(selectedThread.environmentId, requestId), questionId)
      }
    },
    [requests, selectedThread],
  )

  const onSubmitUserInput = useCallback(async () =>
  {
    if (!selectedThread || !pendingUserInput || !activePendingUserInputAnswers)
    {
      return
    }

    setRespondingUserInputId(pendingUserInput.requestId)
    const result = await respondToUserInput({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        requestId: pendingUserInput.requestId,
        answers: activePendingUserInputAnswers,
      },
    })
    setRespondingUserInputId((current) => (current === pendingUserInput.requestId ? null : current))
    return result
  }, [activePendingUserInputAnswers, pendingUserInput, respondToUserInput, selectedThread])

  return {
    ...requests,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    respondingUserInputId,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
  }
}
