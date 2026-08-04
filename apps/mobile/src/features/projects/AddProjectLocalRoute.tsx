// apps/mobile/src/features/projects/AddProjectLocalRoute.tsx
// render the add project local route route

import type { StaticScreenProps } from '@react-navigation/native'
import { AddProjectLocalFolderScreen } from './AddProjectScreen'

type AddProjectLocalRouteParams = {
  readonly environmentId?: string | string[]
}

export function AddProjectLocalRoute({
  route,
}: StaticScreenProps<AddProjectLocalRouteParams | undefined>)
{
  return <AddProjectLocalFolderScreen {...(route.params ?? {})} />
}
