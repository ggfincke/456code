// tests/apps/web/components/thread-terminal/TerminalViewport.test.tsx
// verify xterm clipboard and context menu runtime arbitration

// @vitest-environment happy-dom

import type { ResolvedKeybindingsConfig, ScopedThreadRef, ThreadId } from '@t3tools/contracts'
import { Terminal } from '@xterm/xterm'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const harness = vi.hoisted(() => ({
  terminal: null as unknown,
  keyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  writeText: vi.fn(),
  showContextMenu: vi.fn(),
  closeContextMenu: vi.fn(),
  runAtomCommand: vi.fn(),
}))

vi.mock('@t3tools/client-runtime/state/runtime', () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (failure: unknown) => failure,
}))

vi.mock('~/hooks/useCopyToClipboard', () => ({
  writeTextToClipboard: (text: string, target: string) => harness.writeText(text, target),
}))

vi.mock('../../../../../apps/web/src/lib/editorPreferences', () => ({
  useOpenInPreferredEditor: () => vi.fn(),
}))

vi.mock('~/localApi', () => ({
  readLocalApi: () => ({
    contextMenu: {
      show: harness.showContextMenu,
      close: harness.closeContextMenu,
    },
  }),
}))

vi.mock('../../../../../apps/web/src/state/terminalSessions', () => ({
  useAttachedTerminalSession: () => ({
    buffer: '',
    error: null,
    status: 'closed',
    version: 0,
  }),
}))

vi.mock('../../../../../apps/web/src/state/server', async () =>
{
  const { Atom } = await import('effect/unstable/reactivity')
  return {
    serverEnvironment: { configValueAtom: () => Atom.make(undefined) },
  }
})

vi.mock('../../../../../apps/web/src/state/preview', () => ({
  previewEnvironment: { open: Symbol('preview.open') },
}))

vi.mock('../../../../../apps/web/src/state/terminal', () => ({
  terminalEnvironment: {
    write: Symbol('terminal.write'),
    resize: Symbol('terminal.resize'),
  },
}))

vi.mock('../../../../../apps/web/src/state/use-atom-command', () => ({
  useAtomCommand: () => harness.runAtomCommand,
}))

vi.mock('../../../../../apps/web/src/components/preview/openTerminalLinkInPreview', () => ({
  openTerminalLinkInPreview: vi.fn(),
}))

import { TerminalViewport } from '../../../../../apps/web/src/components/thread-terminal/TerminalViewport'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement
let root: Root

function activeTerminal(): Terminal
{
  if (harness.terminal === null)
  {
    throw new Error('Terminal did not initialize')
  }
  return harness.terminal as Terminal
}

function runTerminalKey(event: KeyboardEvent): boolean
{
  if (!harness.keyHandler)
  {
    throw new Error('Terminal key handler did not initialize')
  }
  return harness.keyHandler(event)
}

async function selectTerminalText(text: string): Promise<void>
{
  const terminal = activeTerminal()
  terminal.reset()
  await new Promise<void>((resolve) => terminal.write(text, resolve))
  terminal.select(0, 0, text.length)
}

function terminalMount(): HTMLElement
{
  const mount = container.firstElementChild
  if (!(mount instanceof HTMLElement))
  {
    throw new Error('Terminal viewport did not mount')
  }
  return mount
}

beforeEach(async () =>
{
  harness.terminal = null
  harness.keyHandler = null
  harness.writeText.mockReset().mockResolvedValue(true)
  harness.showContextMenu.mockReset().mockResolvedValue(null)
  harness.closeContextMenu.mockReset().mockResolvedValue(undefined)
  harness.runAtomCommand.mockReset().mockResolvedValue({ _tag: 'Success', value: undefined })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
  {
    callback(0)
    return 1
  })
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
  const attachCustomKeyEventHandler = Terminal.prototype.attachCustomKeyEventHandler
  vi.spyOn(Terminal.prototype, 'attachCustomKeyEventHandler').mockImplementation(function (
    this: Terminal,
    handler: (event: KeyboardEvent) => boolean,
  )
  {
    harness.terminal = this
    harness.keyHandler = handler
    attachCustomKeyEventHandler.call(this, handler)
  })

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
  {
    root.render(
      <TerminalViewport
        threadRef={{ environmentId: 'local', threadId: 'thread-1' } as unknown as ScopedThreadRef}
        threadId={'thread-1' as ThreadId}
        terminalId="terminal-1"
        terminalLabel="Terminal 1"
        cwd="/tmp/project"
        onSessionExited={vi.fn()}
        onAddTerminalContext={vi.fn()}
        focusRequestId={0}
        autoFocus={false}
        resizeEpoch={0}
        drawerHeight={240}
        keybindings={[] as unknown as ResolvedKeybindingsConfig}
      />,
    )
    await Promise.resolve()
  })
})

afterEach(async () =>
{
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('TerminalViewport clipboard and context menu runtime', () =>
{
  it('lets native shifted-copy beat the async Clipboard API while retaining its fallback', async () =>
  {
    const terminal = activeTerminal()
    await selectTerminalText('native selection')
    const setData = vi.fn()
    const execCommand = vi.fn(() =>
    {
      const copyEvent = new Event('copy', { bubbles: true, cancelable: true })
      Object.defineProperty(copyEvent, 'clipboardData', {
        value: { setData },
      })
      terminal.element?.dispatchEvent(copyEvent)
      return true
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    runTerminalKey(
      new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    )
    await act(async () =>
    {
      await Promise.resolve()
    })

    expect(execCommand).toHaveBeenCalledOnce()
    expect(setData).toHaveBeenCalledWith('text/plain', 'native selection')
    expect(harness.writeText).not.toHaveBeenCalled()

    await selectTerminalText('fallback selection')
    execCommand.mockImplementation(() => false)
    runTerminalKey(
      new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    )
    await act(async () =>
    {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(harness.writeText).toHaveBeenCalledOnce()
    expect(harness.writeText).toHaveBeenCalledWith('fallback selection', 'terminal selection')
  })

  it('closes a stale selection popup before opening the right-click menu', async () =>
  {
    let resolveSelectionMenu: ((value: 'add-to-chat' | 'copy' | null) => void) | undefined
    harness.showContextMenu
      .mockImplementationOnce(
        () =>
          new Promise((resolve) =>
          {
            resolveSelectionMenu = resolve
          }),
      )
      .mockResolvedValueOnce(null)
    harness.closeContextMenu.mockImplementation(async () =>
    {
      resolveSelectionMenu?.(null)
    })
    await selectTerminalText('selected output')

    terminalMount().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    window.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: 20,
        detail: 1,
      }),
    )
    await act(async () =>
    {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(harness.showContextMenu).toHaveBeenCalledTimes(1)

    terminalMount().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }))
    terminalMount().dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        clientX: 30,
        clientY: 30,
        cancelable: true,
      }),
    )
    await act(async () =>
    {
      await Promise.resolve()
    })

    expect(harness.closeContextMenu).toHaveBeenCalledOnce()
    expect(harness.showContextMenu).toHaveBeenCalledTimes(2)
    expect(harness.closeContextMenu.mock.invocationCallOrder[0]).toBeLessThan(
      harness.showContextMenu.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    )
  })

  it('keeps unmodified tracked right-clicks with the TUI but allows selection modifiers', async () =>
  {
    await new Promise<void>((resolve) => activeTerminal().write('\u001b[?1003h', resolve))
    expect(activeTerminal().modes.mouseTrackingMode).toBe('any')
    const trackedEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      button: 2,
      cancelable: true,
    })

    terminalMount().dispatchEvent(trackedEvent)

    expect(trackedEvent.defaultPrevented).toBe(true)
    expect(harness.showContextMenu).not.toHaveBeenCalled()

    const selectionOverrideEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      button: 2,
      shiftKey: true,
      cancelable: true,
    })
    terminalMount().dispatchEvent(selectionOverrideEvent)
    await act(async () =>
    {
      await Promise.resolve()
    })

    expect(selectionOverrideEvent.defaultPrevented).toBe(true)
    expect(harness.showContextMenu).toHaveBeenCalledOnce()
  })
})
