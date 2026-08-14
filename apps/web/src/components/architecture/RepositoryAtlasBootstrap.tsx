// apps/web/src/components/architecture/RepositoryAtlasBootstrap.tsx
// prepares one sealed repository generation before opening the exact native atlas

import type { ArchitectureStandingSource, ProjectId, ScopedThreadRef } from '@t3tools/contracts'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import { useEffect, useRef, useState } from 'react'

import { useRightPanelStore } from '~/rightPanelStore'
import { projectEnvironment } from '~/state/projects'
import { useAtomCommand } from '~/state/use-atom-command'

import { createRepositoryAtlasSurface } from './architectureResourceIdentity'
import { Button } from '../ui/button'

interface RepositoryAtlasBootstrapProps
{
  readonly threadRef: ScopedThreadRef
  readonly projectId: ProjectId
}

// ensures one sealed generation before replacing the generic picker resource
export function RepositoryAtlasBootstrap(props: RepositoryAtlasBootstrapProps)
{
  const ensureProjectArchitecture = useAtomCommand(projectEnvironment.ensureProjectArchitecture, {
    reportFailure: false,
  })
  const [source, setSource] = useState<ArchitectureStandingSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const requestRef = useRef<{
    readonly key: string
    readonly promise: ReturnType<typeof ensureProjectArchitecture>
  } | null>(null)
  const requestKey = `${props.threadRef.environmentId}:${props.projectId}:${attempt}`

  useEffect(() =>
  {
    setSource(null)
    setError(null)
    if (requestRef.current?.key !== requestKey)
    {
      requestRef.current = {
        key: requestKey,
        promise: ensureProjectArchitecture({
          environmentId: props.threadRef.environmentId,
          input: { projectId: props.projectId },
        }),
      }
    }
    let cancelled = false
    void requestRef.current.promise.then((result) =>
    {
      if (cancelled) return
      if (result._tag === 'Success')
      {
        if (result.value.projectId === props.projectId)
        {
          setSource(result.value)
          return
        }
        setError('The server returned architecture for a different project.')
        return
      }
      if (!isAtomCommandInterrupted(result))
      {
        const failure = squashAtomCommandFailure(result)
        setError(
          failure instanceof Error && failure.message.trim().length > 0
            ? failure.message
            : 'Project architecture could not be prepared.',
        )
      }
    })
    return () =>
    {
      cancelled = true
    }
  }, [ensureProjectArchitecture, props.projectId, props.threadRef.environmentId, requestKey])

  useEffect(() =>
  {
    if (source === null) return
    const store = useRightPanelStore.getState()
    store.openArchitectureSurface(
      props.threadRef,
      createRepositoryAtlasSurface(source),
      'repository-atlas-home',
    )
    store.closeSurface(props.threadRef, 'repository-atlas-home')
  }, [props.threadRef, source])

  if (error !== null)
  {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center"
        role="alert"
      >
        <div>
          <p className="text-sm font-medium text-foreground">Repository Atlas unavailable</p>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">{error}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center text-xs text-muted-foreground"
      role="status"
    >
      Preparing the latest sealed Repository Atlas…
    </div>
  )
}
