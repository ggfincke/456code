// tests/packages/client-runtime/markdownImages.test.ts
// verify authenticated markdown image source classification

import { describe, expect, it } from '@effect/vitest'

import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from '../../../packages/client-runtime/src/markdownImages.ts'

describe('classifyMarkdownImageSource', () =>
{
  it.each([
    'https://example.com/image.png',
    'data:image/png;base64,AAAA',
    'blob:https://app.456.codes/image-id',
    '//cdn.example.com/image.png',
  ])('keeps %s directly loadable', (uri) =>
  {
    expect(classifyMarkdownImageSource(uri, '/workspace/project')).toEqual({
      _tag: 'Direct',
      uri,
    })
  })

  it.each([
    ['images/result.png', '/workspace/project', '/workspace/project/images/result.png'],
    [
      'images\\result.png',
      'C:\\Users\\dara\\project',
      'C:\\Users\\dara\\project\\images\\result.png',
    ],
    ['file:///workspace/project/image%20one.png', null, '/workspace/project/image one.png'],
    ['file://server/share/image.png', null, '\\\\server\\share\\image.png'],
  ])('maps %s to a workspace file', (source, workspaceRoot, path) =>
  {
    expect(classifyMarkdownImageSource(source, workspaceRoot)).toEqual({
      _tag: 'WorkspaceFile',
      path,
    })
  })

  it.each(['', '#image', 'image.png', '~/image.png', 'javascript:alert(1)', 'content://image/1'])(
    'blocks unsupported or unresolved source %s',
    (source) =>
    {
      expect(classifyMarkdownImageSource(source)).toEqual({ _tag: 'Blocked' })
    },
  )
})

describe('markdownImageSourceFragment', () =>
{
  it('retains a fragment while leaving query-only sources unchanged', () =>
  {
    expect(markdownImageSourceFragment('<icons.svg?version=2#logo>')).toBe('#logo')
    expect(markdownImageSourceFragment('icons.svg?version=2')).toBe('')
  })
})
