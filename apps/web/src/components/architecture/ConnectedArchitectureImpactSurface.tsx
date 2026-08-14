// apps/web/src/components/architecture/ConnectedArchitectureImpactSurface.tsx
// connects an exact Impact Diff resource to environment queries and immutable files

import type { ScopedThreadRef } from '@t3tools/contracts'

import { projectEnvironment } from '~/state/projects'
import { useEnvironmentQuery } from '~/state/query'
import { useRightPanelStore } from '~/rightPanelStore'

import { ArchitectureImpactSurface } from './ArchitectureImpactSurface'
import type {
  ArchitectureFileSource,
  ArchitectureImpactSurface as ArchitectureImpactSurfaceDescriptor,
} from './architectureResourceIdentity'

export interface ConnectedArchitectureImpactSurfaceProps
{
  readonly threadRef: ScopedThreadRef
  readonly surface: ArchitectureImpactSurfaceDescriptor
}

export function ConnectedArchitectureImpactSurface(props: ConnectedArchitectureImpactSurfaceProps)
{
  const impact = useEnvironmentQuery(
    projectEnvironment.getArchitectureImpact({
      environmentId: props.threadRef.environmentId,
      input: props.surface.target,
    }),
  )
  const openFile = (source: ArchitectureFileSource, relativePath: string, line?: number): void =>
  {
    useRightPanelStore
      .getState()
      .openArchitectureFile(props.threadRef, source, relativePath, line, props.surface.id)
  }
  return (
    <ArchitectureImpactSurface
      result={impact.data}
      error={impact.error}
      isPending={impact.isPending}
      hasSettled={impact.hasSettled}
      onRetry={impact.refresh}
      onOpenFile={openFile}
    />
  )
}
