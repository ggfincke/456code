// tests/apps/web/components/chat/workspaceFileDrop.test.ts
// verify chat workspace external-file drag routing

import { describe, expect, it, vi } from 'vite-plus/test'

import {
  makeWorkspaceFileDropHandlers,
  type WorkspaceFileDragEvent,
} from '../../../../../apps/web/src/components/chat/workspaceFileDrop'

function makeDragEvent(options?: {
  readonly types?: string[]
  readonly files?: File[]
  readonly movedWithinTarget?: boolean
})
{
  const preventDefault = vi.fn()
  const event = {
    dataTransfer: {
      types: options?.types ?? ['Files'],
      files: options?.files ?? [],
      dropEffect: 'none',
    },
    relatedTarget: options?.movedWithinTarget ? ({} as EventTarget) : null,
    currentTarget: {
      contains: () => options?.movedWithinTarget ?? false,
    },
    preventDefault,
  } satisfies WorkspaceFileDragEvent
  return { event, preventDefault }
}

describe('makeWorkspaceFileDropHandlers', () =>
{
  it('accepts external files across the target without flickering between children', () =>
  {
    const file = new File(['contents'], 'example.png', { type: 'image/png' })
    const setDragActive = vi.fn()
    const addFiles = vi.fn()
    const handlers = makeWorkspaceFileDropHandlers({ setDragActive, addFiles })

    handlers.onDragEnter(makeDragEvent().event)
    handlers.onDragLeave(makeDragEvent({ movedWithinTarget: true }).event)
    const drop = makeDragEvent({ files: [file] })
    handlers.onDragOver(drop.event)
    handlers.onDrop(drop.event)

    expect(drop.event.dataTransfer.dropEffect).toBe('copy')
    expect(setDragActive.mock.calls).toEqual([[true], [true], [false]])
    expect(addFiles).toHaveBeenCalledWith([file])
  })

  it('does not claim non-file drags', () =>
  {
    const setDragActive = vi.fn()
    const addFiles = vi.fn()
    const handlers = makeWorkspaceFileDropHandlers({ setDragActive, addFiles })
    const drag = makeDragEvent({ types: ['text/plain'] })

    handlers.onDragEnter(drag.event)
    handlers.onDragOver(drag.event)
    handlers.onDrop(drag.event)

    expect(drag.preventDefault).not.toHaveBeenCalled()
    expect(setDragActive).not.toHaveBeenCalled()
    expect(addFiles).not.toHaveBeenCalled()
  })
})
