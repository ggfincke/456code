// apps/web/src/components/architecture/ConnectedArchitectureImpactSurface.tsx
// connects an exact Impact Diff resource to environment queries and immutable files

import type {
  ArchitectureGraphProjection,
  ArchitectureStandingAnchor,
  ScopedThreadRef,
} from '@t3tools/contracts'
import { useState } from 'react'

import { projectEnvironment } from '~/state/projects'
import { useEnvironmentQuery } from '~/state/query'
import { useRightPanelStore } from '~/rightPanelStore'
import type { ArchitectureConcernGraphSelection } from '~/composerDraftStore'

import { ArchitectureImpactProjectionSurface } from './ArchitectureImpactProjectionSurface'
import { selectExactPlanImpactProjection } from './architectureImpactSelection'
import type {
  ArchitectureFileSource,
  ArchitectureImpactSurface as ArchitectureImpactSurfaceDescriptor,
} from './architectureResourceIdentity'
import { createArchitectureImpactSurface } from './architectureResourceIdentity'

export interface ConnectedArchitectureImpactSurfaceProps
{
  readonly threadRef: ScopedThreadRef
  readonly surface: ArchitectureImpactSurfaceDescriptor
  readonly onOpenPlannedPath: (relativePath: string, line?: number) => void
  readonly onViewInRepositoryMap: (anchor: ArchitectureStandingAnchor) => void
  readonly onAddConcern: (
    projection: ArchitectureGraphProjection,
    selection: ArchitectureConcernGraphSelection,
  ) => void
}

export function ConnectedArchitectureImpactSurface(props: ConnectedArchitectureImpactSurfaceProps)
{
  const descriptor = props.surface.target.descriptor
  const [authorityState, setAuthorityState] = useState<{
    readonly descriptorId: string
    readonly authority: 'planned' | 'verified'
  }>({
    descriptorId: descriptor.descriptorId,
    authority: descriptor.defaultAuthority,
  })
  const authority =
    authorityState.descriptorId === descriptor.descriptorId
      ? authorityState.authority
      : descriptor.defaultAuthority
  const impact = useEnvironmentQuery(
    projectEnvironment.getArchitectureImpactProjection({
      environmentId: props.threadRef.environmentId,
      input: {
        version: 1,
        kind: 'read-exact',
        descriptor,
        authority,
      },
    }),
  )
  const openVerifiedFile = (
    source: ArchitectureFileSource,
    relativePath: string,
    line?: number,
  ): void =>
  {
    useRightPanelStore
      .getState()
      .openArchitectureFile(props.threadRef, source, relativePath, line, props.surface.id)
  }
  const openPlannedPath = (relativePath: string, line?: number): void =>
  {
    props.onOpenPlannedPath(relativePath, line)
  }
  const exactResult =
    impact.data !== null &&
    impact.data.descriptor.descriptorId === descriptor.descriptorId &&
    impact.data.selectedAuthority === authority
      ? impact.data
      : null
  const identityError =
    impact.data !== null && exactResult === null
      ? 'The server returned a different exact Impact authority or descriptor.'
      : null
  const shouldResolveNewer =
    (exactResult?.projection.newerProjectionId !== undefined ||
      exactResult?.newerDescriptorId !== undefined) &&
    descriptor.target.kind === 'plan'
  const newerImpact = useEnvironmentQuery(
    shouldResolveNewer && descriptor.target.kind === 'plan'
      ? projectEnvironment.getArchitectureImpactProjection({
          environmentId: props.threadRef.environmentId,
          input: {
            version: 1,
            kind: 'resolve-plan',
            threadId: props.threadRef.threadId,
            plan: descriptor.target.plan,
          },
        })
      : null,
  )
  const resolvedNewerResult =
    descriptor.target.kind === 'plan'
      ? selectExactPlanImpactProjection(newerImpact.data, {
          threadId: props.threadRef.threadId,
          projectId: descriptor.projectId,
          plan: descriptor.target.plan,
        })
      : null
  const newerResult =
    resolvedNewerResult !== null &&
    exactResult !== null &&
    resolvedNewerResult.descriptor.descriptorId !== descriptor.descriptorId
      ? resolvedNewerResult
      : null
  const newerIdentityError =
    shouldResolveNewer && newerImpact.data !== null && newerResult === null
      ? 'The newer Impact lookup did not advance beyond this pinned resource.'
      : null
  const openNewerProjection = (): void =>
  {
    if (newerResult === null) return
    useRightPanelStore.getState().openArchitectureSurface(
      props.threadRef,
      createArchitectureImpactSurface({
        kind: 'exact-impact',
        descriptor: newerResult.descriptor,
      }),
      props.surface.id,
    )
  }
  return (
    <ArchitectureImpactProjectionSurface
      error={identityError ?? impact.error}
      hasSettled={impact.hasSettled}
      isPending={impact.isPending}
      newerProjectionError={newerIdentityError ?? newerImpact.error}
      newerProjectionPending={
        shouldResolveNewer && newerResult === null && newerImpact.error === null
      }
      requestedAuthority={authority}
      result={exactResult}
      onAddConcern={props.onAddConcern}
      onOpenPlannedPath={openPlannedPath}
      onOpenNewerProjection={openNewerProjection}
      onOpenVerifiedFile={openVerifiedFile}
      onRetry={impact.refresh}
      onRetryNewerProjection={newerImpact.refresh}
      onSelectAuthority={(selected) =>
        setAuthorityState({ descriptorId: descriptor.descriptorId, authority: selected })
      }
      onViewInRepositoryMap={props.onViewInRepositoryMap}
    />
  )
}
