// apps/web/src/components/preview/PreviewLocalServerCard.tsx
// render preview local server card

import type { ScopedThreadRef } from '@t3tools/contracts'

import { PreviewFaviconIcon } from './PreviewFaviconIcon'
import type { PreviewableServer, RecentlySeenPreviewServer } from './useDiscoveredLocalServers'

interface Props
{
  threadRef: ScopedThreadRef
  server: PreviewableServer | RecentlySeenPreviewServer
  onOpen: () => void
}

export function PreviewLocalServerCard({ threadRef, server, onOpen }: Props)
{
  const subtitle = describeServer(server)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <PreviewFaviconIcon threadRef={threadRef} url={server.url} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{subtitle}</span>
        <span className="truncate text-xs text-muted-foreground">
          {server.host}:{server.port}
        </span>
      </div>
      {server.source === 'recent' ? <DimDot /> : <PulsingDot />}
    </button>
  )
}

function describeServer(server: PreviewableServer | RecentlySeenPreviewServer): string
{
  if (server.processName) return server.processName
  return server.source === 'recent' ? 'Recently seen' : 'Listening'
}

function PulsingDot()
{
  return (
    <span aria-label="Listening" className="relative inline-flex size-2 shrink-0">
      <span className="absolute inset-0 animate-status-ping rounded-full bg-success opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-success" />
    </span>
  )
}

function DimDot()
{
  return (
    <span
      aria-label="Not currently listening"
      className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
    />
  )
}
