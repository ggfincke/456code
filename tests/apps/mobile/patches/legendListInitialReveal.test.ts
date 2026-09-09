// tests/apps/mobile/patches/legendListInitialReveal.test.ts
// verify native reveal and drag-anchor guards in the installed list bundles

import * as NodeFS from 'node:fs'
import * as NodeURL from 'node:url'
import * as NodeVM from 'node:vm'
import { describe, expect, it, vi } from 'vite-plus/test'

function readBundle(bundle: 'react-native.js' | 'react-native.mjs')
{
  return NodeFS.readFileSync(
    NodeURL.fileURLToPath(
      new URL(`../../../../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    ),
    'utf8',
  )
}

function createList(bundle: 'react-native.js' | 'react-native.mjs')
{
  const source = readBundle(bundle)
  const renderState = source.slice(
    source.indexOf('function setInitialRenderState('),
    source.indexOf('// src/core/finishInitialScroll.ts'),
  )
  const watchdog = source.slice(
    source.indexOf('var INSET_END_SETTLE_WATCHDOG_FRAMES'),
    source.indexOf('function dispatchInitialScroll('),
  )
  const frames: Array<() => void> = []
  const values = new Map<string, unknown>()
  const scrollTo = vi.fn()
  const state = {
    props: { data: ['message'], onLoad: vi.fn(), drawDistance: 500 },
    initialScroll: { index: 0, viewPosition: 1 },
    loadStartTime: 0,
    didContainersLayout: true,
    didFinishInitialScroll: true,
    didLoad: false,
    didUserDrag: false,
    scrollLength: 800,
    scroll: 400,
    lastNativeScroll: 200 as number | undefined,
    scrollingTo: undefined as { offset: number } | undefined,
    maintainingScrollAtEnd: false,
    refScroller: { current: { scrollTo } },
  }
  const ctx = { state }
  let contentSize = 1_200
  const api = NodeVM.runInNewContext(
    `${renderState}\n${watchdog}\n({ start: startInsetEndSettleWatchdog })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      getContentSize: () => contentSize,
      getContentInsetStartAdjustment: () => 100,
      peek$: (_ctx: unknown, key: string) => values.get(key),
      set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
      setAdaptiveRender: vi.fn(),
      scheduleFullDrawDistancePrewarm: vi.fn(),
      INITIAL_DRAW_DISTANCE: 250,
    },
  ) as { start: (context: typeof ctx) => void }

  return {
    state,
    scrollTo,
    start: () => api.start(ctx),
    ready: () => values.get('readyToRender') === true,
    advance(count: number): void
    {
      for (let index = 0; index < count; index += 1)
      {
        const batch = frames.splice(0)
        for (const frame of batch) frame()
      }
    },
    resize(size: number): void
    {
      contentSize = size
    },
  }
}

for (const bundle of ['react-native.js', 'react-native.mjs'] as const)
{
  describe(`initial inset reveal fence (${bundle})`, () =>
  {
    it('keeps the native iOS anchor active while JS restoration is disabled', () =>
    {
      const source = readBundle(bundle)
      const expression = source.match(
        /maintainVisibleContentPosition: ([^\n]+\? \{ minIndexForVisible: 0 \} : void 0),/,
      )?.[1]
      expect(expression).toBeDefined()
      const nativeAnchor = (os: string, size: boolean, data: boolean) =>
        NodeVM.runInNewContext(`(${expression})`, {
          Platform: { OS: os },
          maintainVisibleContentPosition: { size, data },
        })
      expect(nativeAnchor('ios', false, false)).toEqual({ minIndexForVisible: 0 })
      expect(nativeAnchor('ios', true, true)).toEqual({ minIndexForVisible: 0 })
      expect(nativeAnchor('android', false, false)).toBeUndefined()
      expect(nativeAnchor('android', false, true)).toEqual({ minIndexForVisible: 0 })
    })

    it('releases the near-end initial target after dragging but retains a genuinely anchored end', () =>
    {
      const source = readBundle(bundle)
      const clearFunction = source.slice(
        source.indexOf('function clearFinishedBootstrapInitialScrollTargetIfMovedAway('),
        source.indexOf('function startBootstrapInitialScrollOnMount('),
      )
      const target = { viewPosition: 1, preserveForBottomPadding: true }
      const state = {
        didFinishInitialScroll: true,
        didUserDrag: false,
        initialScroll: target as typeof target | undefined,
        scroll: 300,
        scrollLength: 800,
      }
      let atEnd = false
      const clear = NodeVM.runInNewContext(
        `${clearFunction}\nclearFinishedBootstrapInitialScrollTargetIfMovedAway`,
        {
          didFinishedInitialScrollMoveAwayFromTarget: () => true,
          getContentSize: () => 1200,
          getContentInsetEnd: () => 0,
          getContentInsetStartAdjustment: () => 100,
          isRetargetableBottomAlignedInitialScrollTarget: () => true,
          peek$: () => atEnd,
          shouldPreserveInitialScrollForFooterLayout: () => false,
          clearFinishedViewportRetargetableInitialScroll: () =>
          {
            state.initialScroll = undefined
          },
        },
      ) as (ctx: { state: typeof state }) => void
      clear({ state })
      expect(state.initialScroll).toBe(target)
      state.didUserDrag = true
      clear({ state })
      expect(state.initialScroll).toBeUndefined()
      state.initialScroll = target
      atEnd = true
      clear({ state })
      expect(state.initialScroll).toBe(target)
    })

    it('waits for the native end offset before revealing content', () =>
    {
      const list = createList(bundle)
      list.start()
      list.advance(8)
      expect(list.ready()).toBe(false)
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: 400 })
      list.state.lastNativeScroll = 400
      list.advance(7)
      expect(list.ready()).toBe(true)
    })

    it('releases the initial target when the user starts dragging', () =>
    {
      const list = createList(bundle)
      list.start()
      list.state.didUserDrag = true
      list.advance(1)
      expect(list.ready()).toBe(true)
    })

    it('bounds the hold when native scroll events never arrive', () =>
    {
      const list = createList(bundle)
      list.resize(1_400)
      list.state.lastNativeScroll = undefined
      list.start()
      list.advance(39)
      expect(list.ready()).toBe(false)
      list.advance(1)
      expect(list.ready()).toBe(true)
    })
  })
}
