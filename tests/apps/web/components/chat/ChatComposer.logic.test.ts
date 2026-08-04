// tests/apps/web/components/chat/ChatComposer.logic.test.ts
// verifies composer prompt-ref synchronization around pending user input
import { describe, expect, it } from 'vite-plus/test'

import { resolvePendingInputPromptSync } from '../../../../../apps/web/src/components/chat/ChatComposer'

describe('resolvePendingInputPromptSync', () =>
{
  const pendingIdentity = { requestId: 'request-1', questionId: 'question-1' }

  it('shows the pending answer without replacing the stored draft', () =>
  {
    expect(
      resolvePendingInputPromptSync({
        draftPrompt: 'visible draft',
        currentPrompt: 'visible draft',
        pendingCustomAnswer: 'answer',
        pendingIdentity,
        previousIdentity: null,
      }),
    ).toEqual({
      nextIdentity: pendingIdentity,
      nextPrompt: 'answer',
    })
  })

  it('restores the visible draft when pending input exits', () =>
  {
    expect(
      resolvePendingInputPromptSync({
        draftPrompt: 'visible draft',
        currentPrompt: 'answer',
        pendingCustomAnswer: null,
        pendingIdentity: { requestId: null, questionId: null },
        previousIdentity: pendingIdentity,
      }),
    ).toEqual({
      nextIdentity: null,
      nextPrompt: 'visible draft',
    })
  })
})
