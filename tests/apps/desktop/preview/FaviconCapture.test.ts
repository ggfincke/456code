// tests/apps/desktop/preview/FaviconCapture.test.ts
// verify bounded desktop preview favicon capture

import { describe, expect, it, vi } from 'vite-plus/test'

import { FAVICON_DATA_URL_MAX_LENGTH } from '@t3tools/contracts'
import {
  MAX_FAVICON_CANDIDATES,
  MAX_FAVICON_RESPONSE_BYTES,
  captureFavicon,
  selectFaviconCandidates,
} from '../../../../apps/desktop/src/preview/FaviconCapture.ts'

const RASTERIZED_PNG = 'data:image/png;base64,cG5n'
const SOURCE_PNG = Buffer.alloc(24)
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(SOURCE_PNG)
SOURCE_PNG.writeUInt32BE(1, 16)
SOURCE_PNG.writeUInt32BE(1, 20)
const SOURCE_PNG_URL = `data:image/png;base64,${SOURCE_PNG.toString('base64')}`

function sourceGif(width: number, height: number): Buffer
{
  const buffer = Buffer.alloc(26)
  buffer.write('GIF89a', 0, 'ascii')
  buffer.writeUInt16LE(width, 6)
  buffer.writeUInt16LE(height, 8)
  buffer[13] = 0x2c
  buffer.writeUInt16LE(width, 18)
  buffer.writeUInt16LE(height, 20)
  buffer[23] = 2
  buffer[24] = 0
  buffer[25] = 0x3b
  return buffer
}

function sourceJpeg(width: number, height: number): Buffer
{
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x07,
    0x08,
    height >>> 8,
    height & 0xff,
    width >>> 8,
    width & 0xff,
  ])
}

function sourceWebp(width: number, height: number): Buffer
{
  const buffer = Buffer.alloc(30)
  buffer.write('RIFF', 0, 'ascii')
  buffer.write('WEBP', 8, 'ascii')
  buffer.write('VP8X', 12, 'ascii')
  buffer.writeUIntLE(width - 1, 24, 3)
  buffer.writeUIntLE(height - 1, 27, 3)
  return buffer
}

function sourceIco(embedded: Buffer): Buffer
{
  const buffer = Buffer.alloc(22 + embedded.byteLength)
  buffer.writeUInt16LE(1, 2)
  buffer.writeUInt16LE(1, 4)
  buffer.writeUInt32LE(embedded.byteLength, 14)
  buffer.writeUInt32LE(22, 18)
  embedded.copy(buffer, 22)
  return buffer
}

function sourcePng(width: number, height: number): Buffer
{
  const buffer = Buffer.from(SOURCE_PNG)
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function makeWebContents(options?: {
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>
  readonly rasterize?: (code: string) => Promise<unknown>
})
{
  const fetch = vi.fn(
    options?.fetch ??
      (async () =>
        new Response(new Uint8Array(SOURCE_PNG), {
          headers: { 'content-type': 'image/png' },
        })),
  )
  const executeJavaScriptInIsolatedWorld = vi.fn(
    async (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) =>
      options?.rasterize ? options.rasterize(scripts[0]?.code ?? '') : RASTERIZED_PNG,
  )
  return {
    webContents: {
      session: { fetch },
      executeJavaScriptInIsolatedWorld,
    } as never,
    executeJavaScriptInIsolatedWorld,
    fetch,
  }
}

describe('desktop favicon capture', () =>
{
  it('bounds raw candidate work and applies the usable-candidate cap after filtering', () =>
  {
    const valid = Array.from(
      { length: MAX_FAVICON_CANDIDATES + 2 },
      (_, index) => `https://example.com/favicon-${index}.png`,
    )
    expect(
      selectFaviconCandidates([
        ...Array.from({ length: 64 }, () => 'javascript:alert(1)'),
        valid[0]!,
        valid[0]!,
        ...valid.slice(1),
      ]),
    ).toEqual(valid.slice(0, MAX_FAVICON_CANDIDATES))

    const expensiveInvalid = `javascript:${'x'.repeat(2_048)}`
    expect(
      selectFaviconCandidates([
        ...Array.from({ length: 128 }, () => expensiveInvalid),
        'https://example.com/too-late.png',
      ]),
    ).toEqual([])
  })

  it('includes credentials only for same-origin fetches and rejects redirects', async () =>
  {
    for (const testCase of [
      {
        pageUrl: 'https://example.com/page',
        faviconUrl: 'https://example.com/favicon.png',
        credentials: 'include',
      },
      {
        pageUrl: 'https://example.com/page',
        faviconUrl: 'https://cdn.example.net/favicon.png',
        credentials: 'omit',
      },
    ] as const)
    {
      const { webContents, fetch } = makeWebContents()
      expect(
        await captureFavicon({
          webContents,
          pageUrl: testCase.pageUrl,
          candidates: [testCase.faviconUrl],
          signal: new AbortController().signal,
        }),
      ).toEqual({ kind: 'captured', dataUrl: RASTERIZED_PNG })
      expect(fetch).toHaveBeenCalledWith(
        testCase.faviconUrl,
        expect.objectContaining({ credentials: testCase.credentials, redirect: 'error' }),
      )
    }
  })

  it('cancels aborted and oversized responses before rasterization', async () =>
  {
    const abortController = new AbortController()
    const pending = makeWebContents({
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
        {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          })
        }),
    })
    const abortedCapture = captureFavicon({
      webContents: pending.webContents,
      pageUrl: 'https://example.com/page',
      candidates: ['https://example.com/favicon.png'],
      signal: abortController.signal,
    })
    abortController.abort()
    expect(await abortedCapture).toEqual({ kind: 'none' })

    const cancel = vi.fn()
    const oversized = makeWebContents({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller)
            {
              controller.enqueue(new Uint8Array(MAX_FAVICON_RESPONSE_BYTES))
              controller.enqueue(new Uint8Array(1))
            },
            cancel,
          }),
          { headers: { 'content-type': 'image/png' } },
        ),
    })
    expect(
      await captureFavicon({
        webContents: oversized.webContents,
        pageUrl: 'https://example.com/page',
        candidates: ['https://example.com/favicon.png'],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'none' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(oversized.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('times out a stalled response body and cancels its reader', async () =>
  {
    const timeoutController = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
    try
    {
      const cancel = vi.fn()
      let reportReadPending!: () => void
      const readPending = new Promise<void>((resolve) =>
      {
        reportReadPending = resolve
      })
      const stalled = makeWebContents({
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                cancel,
                pull()
                {
                  reportReadPending()
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { 'content-type': 'image/png' } },
          ),
      })
      const capture = captureFavicon({
        webContents: stalled.webContents,
        pageUrl: 'https://example.com/page',
        candidates: ['https://example.com/favicon.png'],
        signal: new AbortController().signal,
      })
      let captureSettled = false
      void capture.then(
        () =>
        {
          captureSettled = true
        },
        () =>
        {
          captureSettled = true
        },
      )

      await readPending
      expect(captureSettled).toBe(false)
      timeoutController.abort(new DOMException('Timed out', 'TimeoutError'))
      expect(await capture).toEqual({ kind: 'timed-out' })
      expect(cancel).toHaveBeenCalledOnce()
      expect(stalled.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    }
    finally
    {
      timeout.mockRestore()
    }
  })

  it('normalizes bounded bitmap formats and rejects SVG or unsafe dimensions', async () =>
  {
    const supported = makeWebContents()
    for (const [mime, buffer] of [
      ['image/png', SOURCE_PNG],
      ['image/gif', sourceGif(32, 32)],
      ['image/jpeg', sourceJpeg(32, 32)],
      ['image/webp', sourceWebp(32, 32)],
      ['image/x-icon', sourceIco(SOURCE_PNG)],
    ] as const)
    {
      expect(
        await captureFavicon({
          webContents: supported.webContents,
          pageUrl: 'https://example.com/page',
          candidates: [`data:${mime};base64,${buffer.toString('base64')}`],
          signal: new AbortController().signal,
        }),
      ).toEqual({ kind: 'captured', dataUrl: RASTERIZED_PNG })
    }
    expect(supported.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(5)

    for (const [mime, buffer] of [
      ['image/png', sourcePng(4_096, 4_096)],
      ['image/svg+xml', Buffer.from('<svg width="1" height="1"/>')],
    ] as const)
    {
      const rejected = makeWebContents()
      expect(
        await captureFavicon({
          webContents: rejected.webContents,
          pageUrl: 'https://example.com/page',
          candidates: [`data:${mime};base64,${buffer.toString('base64')}`],
          signal: new AbortController().signal,
        }),
      ).toEqual({ kind: 'none' })
      expect(rejected.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    }
  })

  it('keeps raster work physically serialized and launches only the latest queued capture', async () =>
  {
    vi.useFakeTimers()
    try
    {
      let resolveOld!: (value: unknown) => void
      let executions = 0
      const { webContents } = makeWebContents({
        rasterize: () =>
        {
          executions += 1
          return executions === 1
            ? new Promise((resolve) =>
              {
                resolveOld = resolve
              })
            : Promise.resolve(RASTERIZED_PNG)
        },
      })
      const input = {
        webContents,
        pageUrl: 'https://example.com/page',
        candidates: [SOURCE_PNG_URL],
        signal: new AbortController().signal,
      }

      const timedOut = captureFavicon(input)
      await vi.advanceTimersByTimeAsync(1_001)
      expect(await timedOut).toEqual({ kind: 'timed-out' })

      const superseded = captureFavicon(input)
      const newest = captureFavicon(input)
      await Promise.resolve()
      expect(executions).toBe(1)
      resolveOld(RASTERIZED_PNG)
      expect(await superseded).toEqual({ kind: 'none' })
      expect(await newest).toEqual({ kind: 'captured', dataUrl: RASTERIZED_PNG })
      expect(executions).toBe(2)
    }
    finally
    {
      vi.useRealTimers()
    }
  })

  it('rejects an isolated-world raster output above the contract bound', async () =>
  {
    const oversized = makeWebContents({
      rasterize: async () => `data:image/png;base64,${'a'.repeat(FAVICON_DATA_URL_MAX_LENGTH)}`,
    })
    expect(
      await captureFavicon({
        webContents: oversized.webContents,
        pageUrl: 'https://example.com/page',
        candidates: [SOURCE_PNG_URL],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'none' })
  })
})
