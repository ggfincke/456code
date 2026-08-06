// apps/web/src/components/markdown/streamingMarkdown.ts
// split streaming markdown around open fences and batch tail updates

import { useEffect, useState } from 'react'

export interface StreamingMarkdownSegments
{
  readonly completedPrefix: string
  readonly activeTail: string
}

interface RootMarkdownFence
{
  readonly marker: '`' | '~'
  readonly length: number
}

function readRootMarkdownFence(line: string): RootMarkdownFence | null
{
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  const run = match?.[1]
  if (!run) return null
  if (run[0] === '`' && (match?.[2] ?? '').includes('`')) return null
  return { marker: run[0] as '`' | '~', length: run.length }
}

function closesRootMarkdownFence(line: string, fence: RootMarkdownFence): boolean
{
  const match = /^ {0,3}(`+|~+)[\t ]*$/.exec(line)
  const run = match?.[1]
  return Boolean(run && run[0] === fence.marker && run.length >= fence.length)
}

export function splitStreamingMarkdown(text: string): StreamingMarkdownSegments
{
  let completedPrefixEnd = 0
  let openFence: RootMarkdownFence | null = null
  let lineStart = 0

  while (lineStart < text.length)
  {
    const lineFeed = text.indexOf('\n', lineStart)
    const lineEnd = lineFeed === -1 ? text.length : lineFeed
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (openFence)
    {
      if (closesRootMarkdownFence(line, openFence))
      {
        openFence = null
        completedPrefixEnd = lineFeed === -1 ? lineEnd : lineFeed + 1
      }
    }
    else
    {
      openFence = readRootMarkdownFence(line)
    }

    if (lineFeed === -1) break
    lineStart = lineFeed + 1
  }

  return {
    completedPrefix: text.slice(0, completedPrefixEnd),
    activeTail: text.slice(completedPrefixEnd),
  }
}

export function useBatchedStreamingText(text: string, isStreaming: boolean): string
{
  const [batchedText, setBatchedText] = useState(text)
  useEffect(() =>
  {
    if (!isStreaming || typeof window === 'undefined') return
    const frame = window.requestAnimationFrame(() => setBatchedText(text))
    return () => window.cancelAnimationFrame(frame)
  }, [isStreaming, text])

  if (!isStreaming || !text.startsWith(batchedText)) return text
  return batchedText
}
