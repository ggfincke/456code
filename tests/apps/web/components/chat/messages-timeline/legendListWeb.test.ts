// tests/apps/web/components/chat/messages-timeline/legendListWeb.test.ts
// verify installed LegendList web anchor and temporary-padding behavior

// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from 'node:fs'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import * as NodeVM from 'node:vm'
import { describe, expect, it, vi } from 'vite-plus/test'

const require = NodeModule.createRequire(import.meta.url)
const packageDirectory = NodePath.dirname(require.resolve('@legendapp/list/react'))

// run the installed web implementation, without exporting private dependency APIs
function loadFunction<T>(bundle: string, name: string, bindings: Record<string, unknown>): T
{
  const source = NodeFS.readFileSync(NodePath.join(packageDirectory, bundle), 'utf8')
  const start = source.indexOf(`function ${name}(`)
  const end = source.indexOf('\n}', start)
  if (start < 0 || end < 0) throw new Error(`Missing ${name} in ${bundle}`)
  return NodeVM.runInNewContext(`${source.slice(start, end + 2)}\n${name}`, bindings) as T
}

describe.each(['react.js', 'react.mjs'])('installed LegendList %s', (bundle) =>
{
  it('shrinks reserved anchor space as known rows grow without regrowing an unknown tail', () =>
  {
    const values = new Map<string, number>([['anchoredEndSpaceSize', 600]])
    const sizes: Array<number | undefined> = [200, undefined, 400]
    const onReady = vi.fn()
    const onSizeChanged = vi.fn()
    const updateScroll = vi.fn()
    const context = {
      values,
      state: {
        props: {
          data: ['anchor', 'unknown', 'growing-tool'],
          stylePaddingBottom: 0,
          anchoredEndSpace: {
            anchorIndex: 0,
            anchorOffset: 16,
            includeInEndInset: true,
            onReady,
            onSizeChanged,
          },
        },
        scroll: 0,
        scrollLength: 700,
        anchoredEndSpaceReadyAnchorIndex: 0,
        anchoredEndSpaceReadyAnchorKey: 'anchor',
      },
    }
    const update = loadFunction<(ctx: typeof context) => number>(
      bundle,
      'maybeUpdateAnchoredEndSpace',
      {
        peek$: (_ctx: unknown, key: string) => values.get(key),
        set$: (_ctx: unknown, key: string, value: number) => values.set(key, value),
        getId: (_state: unknown, index: number) => context.state.props.data[index],
        getKnownOrFixedItemSize: (_ctx: unknown, index: number) => sizes[index],
        updateScroll,
      },
    )

    expect(update(context)).toBe(84)
    expect(values.get('anchoredEndSpaceSize')).toBe(84)
    expect(onSizeChanged).toHaveBeenLastCalledWith(84)
    expect(updateScroll).toHaveBeenCalledWith(context, 0, true)
    expect(onReady).not.toHaveBeenCalled()

    sizes[2] = 40
    expect(update(context)).toBe(84)
    expect(onSizeChanged).toHaveBeenCalledOnce()
    sizes[1] = 30
    expect(update(context)).toBe(414)
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('restores the original padding after the browser normalizes a temporary fractional value', () =>
  {
    const contentNode = document.createElement('div')
    contentNode.style.paddingBottom = '18.25px'
    Object.defineProperty(contentNode, 'scrollHeight', { value: 100 })
    const scrollElement = {
      scrollTop: 0,
      clientHeight: 100,
      scrollBy: vi.fn(),
    }
    const context = {
      state: {
        props: { horizontal: false },
        scroll: 60.123456789,
        adjustingFromInitialMount: false,
      },
    }
    const values = new Map<string, number>([
      ['scrollAdjust', 0],
      ['scrollAdjustUserOffset', 0],
    ])
    const listeners = new Map<string, () => void>()
    const frames = new Map<number, () => void>()
    let nextFrame = 0
    const reactHooks = {
      useRef: (current: unknown) => ({ current }),
      useCallback: (callback: () => void) => callback,
    }
    const render = loadFunction<() => void>(bundle, 'ScrollAdjust', {
      useStateContext: () => context,
      React3: reactHooks,
      React3__namespace: reactHooks,
      useValueListener$: (key: string, callback: () => void) => listeners.set(key, callback),
      peek$: (_ctx: unknown, key: string) => values.get(key),
      getScrollAdjustTarget: () => ({ contentNode, scrollElement }),
      getScrollAdjustAxis: loadFunction(bundle, 'getScrollAdjustAxis', {}),
      scrollAdjustBy: loadFunction(bundle, 'scrollAdjustBy', {}),
      requestAnimationFrame: (callback: () => void) =>
      {
        frames.set(++nextFrame, callback)
        return nextFrame
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    })

    render()
    values.set('scrollAdjust', 1)
    listeners.get('scrollAdjust')?.()
    const temporaryPadding = contentNode.style.paddingBottom
    expect(temporaryPadding).not.toBe('18.25px')
    contentNode.style.paddingBottom = `${Number.parseFloat(temporaryPadding).toFixed(3)}px`
    expect(contentNode.style.paddingBottom).not.toBe(temporaryPadding)
    expect(frames.size).toBe(1)
    for (const frame of frames.values()) frame()
    expect(contentNode.style.paddingBottom).toBe('18.25px')
    expect(scrollElement.scrollBy).toHaveBeenCalledOnce()
  })
})
