// tests/apps/web/components/ThreadTerminalDrawer.test.ts
// verify terminal selection and clipboard interaction behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalSelectionMouseUp,
} from '../../../../apps/web/src/components/ThreadTerminalDrawer'
import {
  resolveTerminalClipboardShortcut,
  shouldClearTerminalSelectionAction,
  terminalContextMenuItems,
  terminalSelectionMenuItems,
} from '../../../../apps/web/src/components/thread-terminal/selectionHelpers'

describe('resolveTerminalSelectionActionPosition', () =>
{
  it('prefers the selection rect over the last pointer position', () =>
  {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    })
  })

  it('falls back to the pointer position when no selection rect is available', () =>
  {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    })
  })

  it('clamps the pointer fallback into the terminal drawer bounds', () =>
  {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    })

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    })
  })

  it('only handles mouseup when the selection gesture started in the terminal', () =>
  {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true)
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false)
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false)
  })
})

describe('terminal clipboard interactions', () =>
{
  it('copies only a selection while leaving unselected Ctrl+C to the terminal', () =>
  {
    const windowsCtrlC = {
      type: 'keydown',
      key: 'c',
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    }
    expect(resolveTerminalClipboardShortcut(windowsCtrlC, true, 'Win32')).toBe('copy')
    expect(resolveTerminalClipboardShortcut(windowsCtrlC, false, 'Win32')).toBeNull()
    expect(
      resolveTerminalClipboardShortcut({ ...windowsCtrlC, type: 'keyup' }, true, 'Win32'),
    ).toBeNull()
    expect(
      resolveTerminalClipboardShortcut(
        { ...windowsCtrlC, ctrlKey: false, metaKey: true },
        true,
        'MacIntel',
      ),
    ).toBe('copy')
    expect(
      resolveTerminalClipboardShortcut(
        { ...windowsCtrlC, key: 'Insert', ctrlKey: false, shiftKey: true },
        false,
        'Win32',
      ),
    ).toBe('paste')
    expect(
      resolveTerminalClipboardShortcut(
        { ...windowsCtrlC, key: 'v', shiftKey: true },
        false,
        'Win32',
      ),
    ).toBe('paste')
  })

  it('keeps selection actions while making Paste available for every right click', () =>
  {
    expect(terminalSelectionMenuItems()).toEqual([
      { id: 'add-to-chat', label: 'Add to chat' },
      { id: 'copy', label: 'Copy' },
    ])
    expect(terminalContextMenuItems({ hasSelection: false })).toEqual([
      { id: 'add-to-chat', label: 'Add to chat', disabled: true },
      { id: 'copy', label: 'Copy', disabled: true },
      { id: 'paste', label: 'Paste' },
    ])
    expect(terminalContextMenuItems({ hasSelection: true })).toEqual([
      { id: 'add-to-chat', label: 'Add to chat', disabled: false },
      { id: 'copy', label: 'Copy', disabled: false },
      { id: 'paste', label: 'Paste' },
    ])
    expect(
      shouldClearTerminalSelectionAction({
        timerPending: false,
        openMenuRequestId: 3,
        currentRequestId: 4,
      }),
    ).toBe(false)
    expect(
      shouldClearTerminalSelectionAction({
        timerPending: false,
        openMenuRequestId: 4,
        currentRequestId: 4,
      }),
    ).toBe(true)
  })
})
