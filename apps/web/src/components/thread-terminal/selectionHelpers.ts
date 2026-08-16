// apps/web/src/components/thread-terminal/selectionHelpers.ts
// derive terminal selection and clipboard interactions

import { type ContextMenuItem } from '@t3tools/contracts'

import { isMacPlatform } from '../../lib/utils'

const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260

export function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null
{
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
  {
    return null
  }

  const range = selection.getRangeAt(0)
  const commonAncestor = range.commonAncestorContainer
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot))
  {
    return null
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  )
  if (rects.length > 0)
  {
    return rects[rects.length - 1] ?? null
  }

  const boundingRect = range.getBoundingClientRect()
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number }
  selectionRect: { right: number; bottom: number } | null
  pointer: { x: number; y: number } | null
  viewport?: { width: number; height: number } | null
}): { x: number; y: number }
{
  const { bounds, selectionRect, pointer, viewport } = options
  const viewportWidth =
    viewport?.width ??
    (typeof window === 'undefined' ? bounds.left + bounds.width + 8 : window.innerWidth)
  const viewportHeight =
    viewport?.height ??
    (typeof window === 'undefined' ? bounds.top + bounds.height + 8 : window.innerHeight)
  const drawerLeft = Math.round(bounds.left)
  const drawerTop = Math.round(bounds.top)
  const drawerRight = Math.round(bounds.left + bounds.width)
  const drawerBottom = Math.round(bounds.top + bounds.height)
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight))
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom))
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  }
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number
{
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean
{
  return selectionGestureActive && button === 0
}

type TerminalClipboardKeyboardEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'type'
>

export type TerminalClipboardShortcutAction = 'copy' | 'paste'
export type TerminalContextMenuAction = 'add-to-chat' | 'copy' | 'paste'

export function resolveTerminalClipboardShortcut(
  event: TerminalClipboardKeyboardEvent,
  hasSelection: boolean,
  platform = navigator.platform,
): TerminalClipboardShortcutAction | null
{
  if (event.type !== 'keydown' || event.altKey)
  {
    return null
  }

  const key = event.key.toLowerCase()
  const isMac = isMacPlatform(platform)
  const isCopy =
    key === 'c' && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  if (isCopy)
  {
    return hasSelection ? 'copy' : null
  }

  const isPaste =
    (key === 'insert' && !isMac && event.shiftKey && !event.ctrlKey && !event.metaKey) ||
    (key === 'v' &&
      (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey))
  return isPaste ? 'paste' : null
}

export function terminalSelectionMenuItems(): ContextMenuItem<'add-to-chat' | 'copy'>[]
{
  return [
    { id: 'add-to-chat', label: 'Add to chat' },
    { id: 'copy', label: 'Copy' },
  ]
}

export function terminalContextMenuItems(options: {
  hasSelection: boolean
}): ContextMenuItem<TerminalContextMenuAction>[]
{
  return [
    ...terminalSelectionMenuItems().map((item) => ({
      ...item,
      disabled: !options.hasSelection,
    })),
    { id: 'paste', label: 'Paste' },
  ]
}

export function shouldClearTerminalSelectionAction(options: {
  timerPending: boolean
  openMenuRequestId: number | null
  currentRequestId: number
}): boolean
{
  return options.timerPending || options.openMenuRequestId === options.currentRequestId
}

export function shouldSuppressTerminalContextMenu(
  mouseTracking: boolean,
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): boolean
{
  return mouseTracking && !event.shiftKey && !event.ctrlKey && !event.metaKey
}

export async function readTerminalClipboardText(): Promise<string>
{
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.readText !== 'function')
  {
    throw new Error('Clipboard API is unavailable while reading terminal input.')
  }

  try
  {
    return await navigator.clipboard.readText()
  }
  catch
  {
    throw new Error('Failed to read terminal input from the clipboard.')
  }
}
