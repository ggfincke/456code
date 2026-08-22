// apps/web/src/components/architecture/architectureAvailability.ts
// keeps repository architecture launch policy consistent across host entry points

export function repositoryAtlasDisabledReason(input: {
  readonly hasServerThread: boolean
  readonly exactProject: boolean
  readonly capability: boolean | null
  readonly environmentLabel?: string | undefined
}): string | null
{
  if (!input.hasServerThread)
  {
    return 'Open a server thread in this project to view Repository Map.'
  }
  if (!input.exactProject)
  {
    return 'Open a thread in this exact project to view Repository Map.'
  }
  if (input.capability === null)
  {
    return `Repository Map availability is still loading for ${input.environmentLabel ?? 'this environment'}.`
  }
  return input.capability
    ? null
    : `${input.environmentLabel ?? 'This environment'} does not support Repository Map.`
}
