// apps/web/src/components/files/fileLinkReveal.ts
// reveal and scroll to a target line in pierre file previews

import { VirtualizedFile } from '@pierre/diffs'
import type { FileOptions } from '@pierre/diffs/react'
import { useCallback, useEffect, useRef, useState } from 'react'

export const FILE_LINK_REVEAL_ATTRIBUTE = 'data-file-link-reveal'
export const FILE_LINK_REVEAL_UNSAFE_CSS = `
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`
export type FilePostRender = NonNullable<FileOptions<unknown>['onPostRender']>

export function clampFileLine(contents: string, requestedLine: number): number
{
  let lineCount = 1
  for (let index = 0; index < contents.length; index += 1)
  {
    const character = contents.charCodeAt(index)
    if (character === 10)
    {
      lineCount += 1
    }
    else if (character === 13)
    {
      lineCount += 1
      if (contents.charCodeAt(index + 1) === 10) index += 1
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount)
}

export function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void
{
  const root = fileContainer.shadowRoot ?? fileContainer
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`))
  {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE)
  }
  if (line === null) return

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, '')
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, '')
}

export function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
): FilePostRender
{
  const [handledRequestIdsByPath] = useState(() => new Map<string, number>())
  const [latestRequestIdsByPath] = useState(() => new Map<string, number>())
  const [pendingFramesByPath] = useState(() => new Map<string, number>())

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) =>
    {
      if (relativePath === null) return

      const cancelPendingReveal = () =>
      {
        const frameId = pendingFramesByPath.get(relativePath)
        if (frameId !== undefined)
        {
          cancelAnimationFrame(frameId)
          pendingFramesByPath.delete(relativePath)
        }
      }

      if (phase === 'unmount')
      {
        cancelPendingReveal()
        return
      }

      const targetLine =
        revealLine === null ? null : clampFileLine(instance.file?.contents ?? '', revealLine)
      updateFileLinkReveal(fileContainer, targetLine)

      if (!(instance instanceof VirtualizedFile)) return

      if (latestRequestIdsByPath.get(relativePath) !== revealRequestId)
      {
        cancelPendingReveal()
        latestRequestIdsByPath.set(relativePath, revealRequestId)
      }

      if (targetLine === null)
      {
        fileContainer.style.minHeight = ''
        return
      }

      const scrollContainer = fileContainer.closest<HTMLElement>('.file-preview-virtualizer')
      if (!scrollContainer) return
      fileContainer.style.minHeight = `${Math.ceil(
        Math.max(instance.height, scrollContainer.clientHeight),
      )}px`

      if (
        handledRequestIdsByPath.get(relativePath) === revealRequestId ||
        pendingFramesByPath.has(relativePath)
      )
      {
        return
      }

      const reveal = () =>
      {
        pendingFramesByPath.delete(relativePath)
        if (
          latestRequestIdsByPath.get(relativePath) !== revealRequestId ||
          !fileContainer.isConnected
        )
        {
          return
        }

        const linePosition = instance.getLinePosition(targetLine)
        if (!linePosition) return

        const fileTop =
          scrollContainer.scrollTop +
          fileContainer.getBoundingClientRect().top -
          scrollContainer.getBoundingClientRect().top
        const centeredTop = Math.max(
          0,
          fileTop +
            linePosition.top -
            Math.max(0, (scrollContainer.clientHeight - linePosition.height) / 2),
        )
        const maxScrollTop = Math.max(
          0,
          scrollContainer.scrollHeight - scrollContainer.clientHeight,
        )

        scrollContainer.scrollTop = Math.min(centeredTop, maxScrollTop)
        handledRequestIdsByPath.set(relativePath, revealRequestId)
      }

      pendingFramesByPath.set(relativePath, requestAnimationFrame(reveal))
    },
    [
      handledRequestIdsByPath,
      latestRequestIdsByPath,
      pendingFramesByPath,
      relativePath,
      revealLine,
      revealRequestId,
    ],
  )
}
