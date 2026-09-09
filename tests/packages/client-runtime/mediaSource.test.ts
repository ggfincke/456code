// tests/packages/client-runtime/mediaSource.test.ts
// verify authored media source resolution

import { ThreadId } from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'

import { resolveMediaSource } from '../../../packages/client-runtime/src/mediaSource.ts'

const threadId = ThreadId.make('thread-media')

describe('resolveMediaSource', () =>
{
  it('keeps remote images direct and preserves their fragment', () =>
  {
    expect(
      resolveMediaSource('https://example.test/diagram.svg#layer', {
        threadId,
        workspaceRoot: '/workspace',
        imageEmbed: true,
      }),
    ).toEqual({
      access: 'direct',
      kind: 'image',
      mimeType: 'image/svg+xml',
      name: 'diagram.svg',
      srcFragment: '#layer',
      uri: 'https://example.test/diagram.svg#layer',
    })
  })

  it('routes workspace images through the existing signed asset contract', () =>
  {
    expect(
      resolveMediaSource('images/result.png', {
        threadId,
        workspaceRoot: '/workspace/project',
        imageEmbed: true,
      }),
    ).toEqual({
      access: 'environment',
      kind: 'image',
      mimeType: 'image/png',
      name: 'result.png',
      srcFragment: '',
      resource: {
        _tag: 'workspace-file',
        threadId,
        path: '/workspace/project/images/result.png',
      },
    })
  })

  it('marks workspace media unavailable without thread provenance', () =>
  {
    expect(
      resolveMediaSource('/workspace/result.webp', {
        threadId: undefined,
        imageEmbed: true,
      }),
    ).toMatchObject({ access: 'unavailable', kind: 'image' })
  })

  it('rejects unsupported schemes', () =>
  {
    expect(resolveMediaSource('content://media/image/1', { threadId, imageEmbed: true })).toBeNull()
  })
})
