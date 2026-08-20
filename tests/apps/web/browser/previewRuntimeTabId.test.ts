// tests/apps/web/browser/previewRuntimeTabId.test.ts
// verify desktop preview runtime identity

import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { previewRuntimeTabId } from '../../../../apps/web/src/browser/previewRuntimeTabId'

describe('previewRuntimeTabId', () =>
{
  it('scopes a server tab to its environment, thread, and server epoch', () =>
  {
    const ref = {
      environmentId: EnvironmentId.make('environment-a'),
      threadId: ThreadId.make('thread-a'),
    }
    const runtimeTabId = previewRuntimeTabId(ref, 'epoch-a', 'tab_1')

    expect(runtimeTabId).toBe(JSON.stringify(['environment-a', 'thread-a', 'epoch-a', 'tab_1']))
    expect(runtimeTabId).not.toBe(
      previewRuntimeTabId(
        { ...ref, environmentId: EnvironmentId.make('environment-b') },
        'epoch-a',
        'tab_1',
      ),
    )
    expect(runtimeTabId).not.toBe(
      previewRuntimeTabId({ ...ref, threadId: ThreadId.make('thread-b') }, 'epoch-a', 'tab_1'),
    )
    expect(runtimeTabId).not.toBe(previewRuntimeTabId(ref, 'epoch-b', 'tab_1'))
  })
})
