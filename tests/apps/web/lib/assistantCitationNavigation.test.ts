// tests/apps/web/lib/assistantCitationNavigation.test.ts
// verify durable citation route encoding and repeat activation

import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from '@t3tools/contracts'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { describe, expect, it } from 'vite-plus/test'

import {
  assistantCitationFromLocation,
  assistantCitationNavigation,
} from '../../../../apps/web/src/lib/assistantCitationNavigation'

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make('environment-one'),
  threadId: ThreadId.make('thread-one'),
  messageId: MessageId.make('assistant-one'),
  text: 'first line\n\tsecond line (with a #hash & spaces) 🚀',
  start: 12,
  end: 59,
  prefix: 'Before:\n',
  suffix: '\nAfter.',
}

function createCitationRouter(initialEntry = '/environment-one/thread-one')
{
  const root = createRootRoute()
  const thread = createRoute({ getParentRoute: () => root, path: '/$environmentId/$threadId' })
  return createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
}

describe('assistant citation navigation', () =>
{
  it('preserves encoded quote whitespace and reactivates an identical citation', async () =>
  {
    const router = createCitationRouter()
    await router.navigate(assistantCitationNavigation(citation))
    const firstActivation = router.state.location.state.assistantCitationActivation
    expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation)

    await router.navigate(assistantCitationNavigation(citation))
    expect(router.state.location.state.assistantCitationActivation).not.toBe(firstActivation)
    expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation)
  })

  it('rejects ordinary, invalid, and oversized fragments', () =>
  {
    expect(assistantCitationFromLocation('/environment-one/thread-one#ordinary')).toBeNull()
    expect(assistantCitationFromLocation('/a/b#assistant-citation=%invalid')).toBeNull()
    expect(
      assistantCitationFromLocation(`/a/b#assistant-citation=${'a'.repeat(140_000)}`),
    ).toBeNull()
  })
})
