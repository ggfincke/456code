// tests/apps/web/lib/terminalFocus.test.ts
// verify is terminal focused behavior

import { afterEach, describe, expect, it } from 'vite-plus/test'

import {
  getTerminalFocusOwner,
  isTerminalFocused,
  subscribeToTerminalFocusChanges,
} from '../../../../apps/web/src/lib/terminalFocus'

class MockHTMLElement
{
  isConnected = false
  className = ''
  terminalOwner: string | null = null
  readonly dataset: { terminalOwner?: string } = {}

  readonly classList = {
    contains: (value: string) => this.className.split(/\s+/).includes(value),
  }

  closest(selector: string): MockHTMLElement | null
  {
    if (!this.isConnected)
    {
      return null
    }
    if (selector === '[data-terminal-owner]' && this.terminalOwner !== null)
    {
      return this
    }
    return null
  }
}

const originalDocument = globalThis.document
const originalHTMLElement = globalThis.HTMLElement
const originalWindow = globalThis.window

afterEach(() =>
{
  if (originalDocument === undefined)
  {
    delete (globalThis as { document?: Document }).document
  }
  else
  {
    globalThis.document = originalDocument
  }

  if (originalHTMLElement === undefined)
  {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement
  }
  else
  {
    globalThis.HTMLElement = originalHTMLElement
  }

  if (originalWindow === undefined)
  {
    delete (globalThis as { window?: Window }).window
  }
  else
  {
    globalThis.window = originalWindow
  }
})

describe('isTerminalFocused', () =>
{
  it('returns false for detached xterm helper textareas', () =>
  {
    const detached = new MockHTMLElement()
    detached.className = 'xterm-helper-textarea'

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement
    globalThis.document = { activeElement: detached } as unknown as Document

    expect(isTerminalFocused()).toBe(false)
  })

  it('returns the drawer owner for connected xterm helper textareas', () =>
  {
    const attached = new MockHTMLElement()
    attached.className = 'xterm-helper-textarea'
    attached.isConnected = true
    attached.terminalOwner = 'drawer'
    attached.dataset.terminalOwner = 'drawer'

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement
    globalThis.document = { activeElement: attached } as unknown as Document

    expect(getTerminalFocusOwner()).toBe('drawer')
    expect(isTerminalFocused()).toBe(true)
  })

  it('returns the right panel owner for focus inside its terminal UI', () =>
  {
    const sidebarButton = new MockHTMLElement()
    sidebarButton.className = 'terminal-sidebar-button'
    sidebarButton.isConnected = true
    sidebarButton.terminalOwner = 'right-panel'
    sidebarButton.dataset.terminalOwner = 'right-panel'

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement
    globalThis.document = { activeElement: sidebarButton } as unknown as Document

    expect(getTerminalFocusOwner()).toBe('right-panel')
    expect(isTerminalFocused()).toBe(true)
  })
})

describe('subscribeToTerminalFocusChanges', () =>
{
  it('notifies on focus transitions until unsubscribed', () =>
  {
    const listeners = new Map<string, Set<() => void>>()
    globalThis.window = {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      {
        const callbacks = listeners.get(type) ?? new Set<() => void>()
        callbacks.add(listener as () => void)
        listeners.set(type, callbacks)
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      {
        listeners.get(type)?.delete(listener as () => void)
      },
    } as unknown as Window & typeof globalThis
    let notifications = 0

    const unsubscribe = subscribeToTerminalFocusChanges(() =>
    {
      notifications += 1
    })

    for (const listener of listeners.get('focusin') ?? []) listener()
    for (const listener of listeners.get('focusout') ?? []) listener()
    expect(notifications).toBe(2)

    unsubscribe()
    for (const listener of listeners.get('focusin') ?? []) listener()
    expect(notifications).toBe(2)
  })
})
