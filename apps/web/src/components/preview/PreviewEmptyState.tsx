// apps/web/src/components/preview/PreviewEmptyState.tsx
// render preview empty state

import type { EnvironmentId, ScopedThreadRef } from '@t3tools/contracts'
import { Globe, History, RadioTower } from 'lucide-react'

import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '~/components/ui/empty'

import { PreviewLocalServerCard } from './PreviewLocalServerCard'
import { recentlySeenServers, useDiscoveredLocalServers } from './useDiscoveredLocalServers'

interface Props
{
  threadRef: ScopedThreadRef
  environmentId: EnvironmentId
  configuredUrls?: ReadonlyArray<string> | undefined
  recentlySeenUrls?: ReadonlyArray<string> | undefined
  onOpenUrl: (url: string) => void
}

export function PreviewEmptyState({
  threadRef,
  environmentId,
  configuredUrls,
  recentlySeenUrls,
  onOpenUrl,
}: Props)
{
  const liveServers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
  })
  const recentServers = recentlySeenServers({
    urls: recentlySeenUrls ?? [],
    liveServers,
  })

  if (liveServers.length === 0 && recentServers.length === 0)
  {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <Globe className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>No preview yet</EmptyTitle>
        <EmptyDescription>
          Type a URL above, or run a dev script. Browser-ready localhost servers will show up here
          automatically.
        </EmptyDescription>
      </Empty>
    )
  }

  return (
    <div className="flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        {recentServers.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <History className="size-4 shrink-0" />
              <h2 className="font-medium">Recently used</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {recentServers.map((server) => (
                <PreviewLocalServerCard
                  key={server.requestedUrl}
                  threadRef={threadRef}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              History entries may no longer be running.
            </p>
          </div>
        ) : null}
        {liveServers.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RadioTower className="size-4 shrink-0" />
              <h2 className="font-medium">Local servers</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {liveServers.map((server) => (
                <PreviewLocalServerCard
                  key={`${server.host}:${server.port}`}
                  threadRef={threadRef}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              Select a live local server to open it in this browser tab.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
