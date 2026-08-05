// apps/mobile/src/features/projects/AddProjectDestinationRoute.tsx
// render the add project destination route route

import type { StaticScreenProps } from '@react-navigation/native'
import { AddProjectDestinationScreen } from './AddProjectScreen'

type AddProjectDestinationRouteParams = {
  readonly environmentId?: string | string[]
  readonly source?: string | string[]
  readonly remoteUrl?: string | string[]
  readonly repositoryTitle?: string | string[]
}

export function AddProjectDestinationRoute({
  route,
}: StaticScreenProps<AddProjectDestinationRouteParams | undefined>)
{
  return <AddProjectDestinationScreen {...(route.params ?? {})} />
}
