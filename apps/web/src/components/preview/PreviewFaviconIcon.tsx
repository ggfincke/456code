// apps/web/src/components/preview/PreviewFaviconIcon.tsx
// render ordered preview favicon sources with a stable visual fallback

import type { ScopedThreadRef } from '@t3tools/contracts'
import { type ReactNode, useState } from 'react'

import { useFaviconForThreadUrl } from '~/browser/browserFaviconStore'
import { faviconUrlForOrigin } from '~/lib/favicon'
import { cn } from '~/lib/utils'

import { BrowserMockup } from './BrowserMockup'

interface FaviconImageProps
{
  sources: ReadonlyArray<string | null | undefined>
  fallback: ReactNode
  className?: string | undefined
}

export function FaviconImage(props: FaviconImageProps)
{
  const sources = [...new Set(props.sources.filter((source): source is string => Boolean(source)))]
  return (
    <FaviconImageAttempt
      key={sources.join('\0')}
      sources={sources}
      fallback={props.fallback}
      className={props.className}
    />
  )
}

function FaviconImageAttempt(props: {
  sources: ReadonlyArray<string>
  fallback: ReactNode
  className?: string | undefined
})
{
  const [sourceIndex, setSourceIndex] = useState(0)
  const source = props.sources[sourceIndex]
  if (!source) return props.fallback
  return (
    <img
      key={source}
      src={source}
      alt=""
      aria-hidden
      draggable={false}
      className={props.className}
      onError={() => setSourceIndex((current) => (current === sourceIndex ? current + 1 : current))}
    />
  )
}

export function PreviewFaviconIcon(props: {
  threadRef: ScopedThreadRef
  url: string
  className?: string | undefined
})
{
  const capturedSource = useFaviconForThreadUrl(props.threadRef, props.url)
  const originSource = faviconUrlForOrigin(props.url)
  return (
    <FaviconImage
      sources={[capturedSource, originSource]}
      fallback={<BrowserMockup className={cn('size-7 shrink-0', props.className)} />}
      className={cn('size-7 shrink-0 rounded object-contain', props.className)}
    />
  )
}
