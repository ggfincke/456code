// apps/web/src/components/chat/composer/pendingInputPromptSync.ts
// sync composer prompt text when pending user-input identity changes

export type PendingInputPromptIdentity = {
  requestId: string | null
  questionId: string | null
}

export function resolvePendingInputPromptSync(input: {
  draftPrompt: string
  currentPrompt: string
  pendingCustomAnswer: string | null
  pendingIdentity: PendingInputPromptIdentity
  previousIdentity: PendingInputPromptIdentity | null
}): { nextIdentity: PendingInputPromptIdentity | null; nextPrompt: string } | null
{
  if (input.pendingCustomAnswer === null)
  {
    return input.previousIdentity === null
      ? null
      : { nextIdentity: null, nextPrompt: input.draftPrompt }
  }

  const questionChanged =
    input.previousIdentity?.requestId !== input.pendingIdentity.requestId ||
    input.previousIdentity?.questionId !== input.pendingIdentity.questionId
  if (!questionChanged && input.currentPrompt === input.pendingCustomAnswer)
  {
    return null
  }

  return {
    nextIdentity: input.pendingIdentity,
    nextPrompt: input.pendingCustomAnswer,
  }
}
