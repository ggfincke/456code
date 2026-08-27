// tests/apps/mobile/features/threads/thread-feed-submission-anchor.test.ts
// verifies first-message anchoring and follow-up live-end resolution

import { describe, expect, it } from 'vite-plus/test'

import { resolveThreadFeedSubmissionAnchor } from '../../../../../apps/mobile/src/features/threads/thread-feed-submission-anchor'

describe('resolveThreadFeedSubmissionAnchor', () =>
{
  it('anchors the first user submission in an empty thread', () =>
  {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: 'first-message',
        hasStartedTurn: false,
        hasUserMessage: false,
        queuedMessageCount: 0,
      }),
    ).toBe('first-message')
  })

  it('does not anchor an existing-history or already-started thread', () =>
  {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: 'follow-up',
        hasStartedTurn: false,
        hasUserMessage: true,
        queuedMessageCount: 0,
      }),
    ).toBeNull()
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: 'follow-up',
        hasStartedTurn: true,
        hasUserMessage: false,
        queuedMessageCount: 0,
      }),
    ).toBeNull()
  })

  it('retains the first anchor while its optimistic message is still pending', () =>
  {
    for (const queuedMessageCount of [0, 1])
    {
      expect(
        resolveThreadFeedSubmissionAnchor({
          currentAnchorMessageId: 'first-message',
          submittedMessageId: 'queued-follow-up',
          hasStartedTurn: false,
          hasUserMessage: false,
          queuedMessageCount,
        }),
      ).toBe('first-message')
    }
  })

  it('keeps a submission behind queued work at the live end', () =>
  {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: 'queued-first-message',
        hasStartedTurn: false,
        hasUserMessage: false,
        queuedMessageCount: 1,
      }),
    ).toBeNull()
  })
})
