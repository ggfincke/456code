// apps/mobile/src/lib/thread-activity/pending.ts
// manages mobile-only pending user input drafts

import type { UserInputQuestion } from '@t3tools/contracts'

export {
  derivePendingApprovals,
  derivePendingUserInputs,
  requestKindFromRequestType,
  type PendingApproval,
  type PendingUserInput,
} from '@t3tools/client-runtime/thread-activity'

export interface PendingUserInputDraftAnswer
{
  readonly selectedOptionLabel?: string
  readonly customAnswer?: string
}

function normalizeDraftAnswer(value: string | undefined): string | null
{
  if (typeof value !== 'string')
  {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function resolvePendingUserInputAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
): string | null
{
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer)
  if (customAnswer)
  {
    return customAnswer
  }
  return normalizeDraftAnswer(draft?.selectedOptionLabel)
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer
{
  const selectedOptionLabel =
    customAnswer.trim().length > 0 ? undefined : draft?.selectedOptionLabel
  return {
    customAnswer,
    ...(selectedOptionLabel ? { selectedOptionLabel } : {}),
  }
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string> | null
{
  const answers: Record<string, string> = {}

  for (const question of questions)
  {
    const answer = resolvePendingUserInputAnswer(draftAnswers[question.id])
    if (!answer)
    {
      return null
    }
    answers[question.id] = answer
  }

  return answers
}
