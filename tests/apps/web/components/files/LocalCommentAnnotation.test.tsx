// tests/apps/web/components/files/LocalCommentAnnotation.test.tsx
// verify comment focus wins editor layout and retired focus frames are cancelled

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'

import { LocalCommentAnnotation } from '../../../../../apps/web/src/components/files/LocalCommentAnnotation'

it('focuses the comment after editor layout without scrolling and cancels retired frames', () =>
{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  {
    frames.set(++sequence, callback)
    return sequence
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const container = document.createElement('div')
  const editor = document.createElement('textarea')
  document.body.append(container, editor)
  const root = createRoot(container)
  const props = {
    rangeLabel: '1-2',
    text: '',
    onCancel: vi.fn(),
    onComment: vi.fn(),
    onDelete: vi.fn(),
  }
  try
  {
    act(() => root.render(<LocalCommentAnnotation {...props} kind="draft" />))
    const textarea = container.querySelector('textarea')!
    const focus = vi.spyOn(textarea, 'focus')
    editor.focus()
    expect(document.activeElement).toBe(editor)
    expect(frames.size).toBe(1)
    act(() =>
    {
      for (const [id, callback] of frames)
      {
        frames.delete(id)
        callback(0)
      }
    })
    expect(document.activeElement).toBe(textarea)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })

    act(() => root.render(<LocalCommentAnnotation {...props} kind="comment" />))
    act(() => root.render(<LocalCommentAnnotation {...props} kind="draft" />))
    expect(frames.size).toBe(1)
    act(() => root.render(<LocalCommentAnnotation {...props} kind="comment" />))
    expect(frames.size).toBe(0)
    act(() => root.render(<LocalCommentAnnotation {...props} kind="draft" />))
    expect(frames.size).toBe(1)
  }
  finally
  {
    act(() => root.unmount())
    expect(frames.size).toBe(0)
    container.remove()
    editor.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
