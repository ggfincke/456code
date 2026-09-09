// tests/apps/web/bootstrap.test.ts
// verify startup failures replace the boot splash without exposing production internals

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { showBootError } from '../../../apps/web/src/lib/bootError'

class BootElement extends EventTarget
{
  children: Array<BootElement> = []
  textContent = ''

  constructor(readonly tagName: string)
  {
    super()
  }

  setAttribute()
  {}

  append(child: BootElement)
  {
    this.children.push(child)
  }

  replaceChildren(...children: Array<BootElement>)
  {
    this.children = children
  }

  get text(): string
  {
    return this.textContent + this.children.map((child) => child.text).join(' ')
  }
}

describe('app startup failures', () =>
{
  let bootShell: BootElement | null

  beforeEach(() =>
  {
    vi.resetModules()
    bootShell = new BootElement('div')
    vi.stubGlobal('document', {
      getElementById: () => bootShell,
      createElement: (tagName: string) => new BootElement(tagName),
    })
    vi.spyOn(console, 'error').mockImplementation(() =>
    {})
  })

  afterEach(() =>
  {
    vi.doUnmock('../../../apps/web/src/main')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('shows failures from both module loading and asynchronous startup', async () =>
  {
    vi.doMock('../../../apps/web/src/main', () => ({
      startup: Promise.reject(new Error('Startup chunks failed')),
    }))

    await import('../../../apps/web/src/bootstrap')
    await vi.dynamicImportSettled()

    expect(bootShell?.text).toContain('Startup chunks failed')
  })

  it('offers a reload when the app import throws before main can run', async () =>
  {
    vi.doMock('../../../apps/web/src/main', () =>
    {
      throw new Error("@vitejs/plugin-react can't detect preamble. Something is wrong.")
    })
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { reload } })

    await import('../../../apps/web/src/bootstrap')
    await vi.dynamicImportSettled()

    expect(bootShell?.text).toContain('456code could not load.')
    const reloadButton = bootShell?.children[0]?.children.find(
      (element) => element.tagName === 'button',
    )
    expect(reloadButton?.text).toBe('Reload')
    reloadButton?.dispatchEvent(new Event('click'))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('keeps startup error details out of production', () =>
  {
    vi.stubEnv('DEV', false)

    showBootError(new Error('internal module path'))

    expect(bootShell?.text).toContain('456code could not load.')
    expect(bootShell?.text).not.toContain('internal module path')
  })
})
