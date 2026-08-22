// apps/web/src/components/architecture/RepositoryAtlasSurface.tsx
// connects one exact standing generation to the current Repository Map projection

import type { ArchitectureGraphProjection, EnvironmentId, ThreadId } from '@t3tools/contracts'

import type { ArchitectureConcernGraphSelection } from '~/composerDraftStore'

import {
  repositoryAtlasSurfaceId,
  type ArchitectureFileOpenTarget,
  type RepositoryAtlasTarget,
} from './architectureResourceIdentity'
import {
  RepositoryMapProjectionSurface,
  type RepositoryMapFocusRequest,
} from './RepositoryMapProjectionSurface'

export interface RepositoryAtlasSurfaceProps
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly target: RepositoryAtlasTarget
  readonly focusRequest?: RepositoryMapFocusRequest | undefined
  readonly narrow?: boolean | undefined
  readonly onOpenFile?: ((target: ArchitectureFileOpenTarget) => void) | undefined
  readonly onViewUpdated?: ((target: RepositoryAtlasTarget) => void) | undefined
  readonly onAddConcern?:
    | ((
        projection: ArchitectureGraphProjection,
        selection: ArchitectureConcernGraphSelection,
      ) => void)
    | undefined
}

export function RepositoryAtlasSurface(props: RepositoryAtlasSurfaceProps)
{
  const resourceIdentity = repositoryAtlasSurfaceId(props.target)
  return (
    <RepositoryMapProjectionSurface
      key={JSON.stringify([
        props.environmentId,
        resourceIdentity,
        props.focusRequest?.requestId ?? 0,
      ])}
      environmentId={props.environmentId}
      focusRequest={props.focusRequest}
      narrow={props.narrow}
      target={props.target}
      threadId={props.threadId}
      onAddConcern={props.onAddConcern}
      onOpenFile={props.onOpenFile}
      onViewUpdated={props.onViewUpdated}
    />
  )
}
