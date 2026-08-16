// apps/web/src/components/preview/PreviewPanelShell.tsx
// render preview panel shell

import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { isElectron } from '~/env'
import { useResizableWidth } from '~/hooks/useResizableWidth'
import { cn } from '~/lib/utils'

import { RightPanelResizeHandle } from './RightPanelResizeHandle'

export type PreviewPanelMode = 'inline' | 'sheet' | 'sidebar' | 'embedded'

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = '456code:preview-panel-width'
const PREVIEW_PANEL_MIN_WIDTH = 360
// fraction of the viewport allowed, preserving the remaining space for chat.
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7
const PREVIEW_PANEL_DEFAULT_WIDTH = 540
const SIBLING_COLUMN_MIN_WIDTH = 360

export function getPreviewPanelMaxWidth(viewportWidth: number, containerWidth?: number): number
{
  const fractionCap = Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION)
  const containerCap =
    containerWidth === undefined ? Infinity : Math.floor(containerWidth) - SIBLING_COLUMN_MIN_WIDTH
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap))
}

// shell for the preview panel. In inline mode the panel is user-resizable
// via a drag handle on the left edge; width persists per browser. In
// sheet/sidebar modes the parent owns the size.
export function PreviewPanelShell(props: {
  mode: PreviewPanelMode
  maximized?: boolean
  children: ReactNode
})
{
  const useDragRegion = isElectron && props.mode !== 'sheet' && props.mode !== 'embedded'
  const isInline = props.mode === 'inline'
  const hostRef = useRef<HTMLDivElement | null>(null)
  const maxWidth = useClampedMaxWidth(hostRef, isInline && !props.maximized)
  const { width, handlers } = useResizableWidth({
    storageKey: PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: PREVIEW_PANEL_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: 'left',
  })

  return (
    <div
      ref={hostRef}
      className={cn(
        'relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background',
        isInline
          ? props.maximized
            ? 'flex-1 border-l border-border'
            : 'shrink-0 border-l border-border'
          : 'w-full',
      )}
      style={isInline && !props.maximized ? { width: `${width}px` } : undefined}
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={props.maximized ? 'true' : 'false'}
    >
      {isInline && !props.maximized ? <RightPanelResizeHandle handlers={handlers} /> : null}
      {useDragRegion ? <div className="electron-drag-region h-0 w-full" aria-hidden /> : null}
      {props.children}
    </div>
  )
}

// track the viewport and flex row so the sibling column keeps a usable width.
function useClampedMaxWidth(hostRef: RefObject<HTMLDivElement | null>, enabled: boolean): number
{
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined)
  useEffect(() =>
  {
    if (typeof window === 'undefined') return
    let frame = 0
    const onResize = () =>
    {
      // coalesce rapid resize events into one rAF tick.
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() =>
      {
        frame = 0
        setVw(window.innerWidth)
      })
    }
    window.addEventListener('resize', onResize)
    return () =>
    {
      window.removeEventListener('resize', onResize)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [])
  useLayoutEffect(() =>
  {
    if (!enabled) return
    const parent = hostRef.current?.parentElement
    if (!parent) return
    const measure = () => setContainerWidth(parent.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [enabled, hostRef])
  return getPreviewPanelMaxWidth(vw, containerWidth)
}
