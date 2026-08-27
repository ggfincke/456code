// apps/mobile/src/features/threads/thread-feed-submission-anchor.ts
// resolves first-message anchoring without pulling follow-ups away from the live end

export function resolveThreadFeedSubmissionAnchor<AnchorId>(input: {
  readonly currentAnchorMessageId: AnchorId | null
  readonly submittedMessageId: AnchorId
  readonly hasStartedTurn: boolean
  readonly hasUserMessage: boolean
  readonly queuedMessageCount: number
}): AnchorId | null
{
  if (input.hasStartedTurn || input.hasUserMessage)
  {
    return null
  }
  if (input.currentAnchorMessageId !== null)
  {
    return input.currentAnchorMessageId
  }
  return input.queuedMessageCount > 0 ? null : input.submittedMessageId
}
