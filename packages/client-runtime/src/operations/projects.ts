// packages/client-runtime/src/operations/projects.ts
// defines shared project operation eligibility and command builders

import type { EnvironmentConnectionPhase } from '../connection/presentation.ts'
import type {
  CommandId,
  EnvironmentId,
  OrchestrationCommand,
  ProjectId,
  SourceControlDiscoveryResult,
  SourceControlProviderKind,
  SourceControlRepositoryInfo,
} from '@t3tools/contracts'
import * as Arr from 'effect/Array'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'

import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from '../state/projects.ts'
import type { EnvironmentProject } from '../state/models.ts'

export type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  'github' | 'gitlab' | 'bitbucket' | 'azure-devops'
>
export type AddProjectRemoteSource = AddProjectRemoteProviderKind | 'url'

export function canCreateProjectInEnvironment(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean
{
  return connectionPhase === 'connected'
}

export type AddProjectRemoteSourceReadiness = Record<
  AddProjectRemoteSource,
  { readonly ready: boolean; readonly hint: string | null }
>

export type AddProjectCloneFlow =
  | {
      readonly step: 'repository'
      readonly environmentId: EnvironmentId
      readonly source: AddProjectRemoteSource
    }
  | {
      readonly step: 'confirm'
      readonly environmentId: EnvironmentId
      readonly source: AddProjectRemoteSource
      readonly repositoryInput: string
      readonly repository: SourceControlRepositoryInfo | null
      readonly remoteUrl: string
    }

const ADD_PROJECT_REMOTE_SOURCES: ReadonlyArray<AddProjectRemoteSource> = [
  'url',
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
]

const ADD_PROJECT_REMOTE_PROVIDER_SOURCES: ReadonlyArray<AddProjectRemoteProviderKind> = [
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
]

export function addProjectRemoteSourceLabel(source: AddProjectRemoteSource): string
{
  switch (source)
  {
    case 'github':
      return 'GitHub'
    case 'gitlab':
      return 'GitLab'
    case 'bitbucket':
      return 'Bitbucket'
    case 'azure-devops':
      return 'Azure DevOps'
    case 'url':
      return 'Git URL'
  }
}

export function addProjectRemoteSourcePathHint(source: AddProjectRemoteSource): string
{
  switch (source)
  {
    case 'github':
      return 'owner/repo'
    case 'gitlab':
      return 'group/project'
    case 'bitbucket':
      return 'workspace/repository'
    case 'azure-devops':
      return 'project/repository'
    case 'url':
      return 'URL'
  }
}

export function addProjectRemoteSourceProvider(
  source: AddProjectRemoteSource,
): AddProjectRemoteProviderKind | null
{
  return source === 'url' ? null : source
}

export function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): ReadonlyArray<AddProjectRemoteProviderKind>
{
  return Arr.sort(
    ADD_PROJECT_REMOTE_PROVIDER_SOURCES,
    Order.mapInput(
      Order.Struct({
        ready: Order.flip(Order.Boolean),
        label: Order.String,
      }),
      (source: AddProjectRemoteProviderKind) => ({
        ready: readinessBySource[source].ready,
        label: addProjectRemoteSourceLabel(source),
      }),
    ),
  )
}

export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness
{
  const unavailable = {
    ready: false,
    hint: 'Provider status unavailable. Open Source Control settings and rescan.',
  } as const
  const readiness: AddProjectRemoteSourceReadiness = {
    url: { ready: true, hint: null },
    github: unavailable,
    gitlab: unavailable,
    bitbucket: unavailable,
    'azure-devops': unavailable,
  }

  if (!discovery)
  {
    return readiness
  }

  const providerByKind = new Map(
    discovery.sourceControlProviders.map((provider) => [provider.kind, provider]),
  )
  for (const source of ADD_PROJECT_REMOTE_SOURCES)
  {
    const kind = addProjectRemoteSourceProvider(source)
    if (!kind) continue
    const provider = providerByKind.get(kind)
    if (!provider)
    {
      readiness[source] = unavailable
      continue
    }
    if (provider.status !== 'available')
    {
      readiness[source] = { ready: false, hint: provider.installHint }
      continue
    }
    if (provider.auth.status === 'unauthenticated')
    {
      readiness[source] = {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Source Control settings for setup guidance.`,
      }
      continue
    }
    readiness[source] = { ready: true, hint: null }
  }
  return readiness
}

export function getAddProjectInitialQuery(baseDirectory: string | null | undefined): string
{
  const trimmed = baseDirectory?.trim() ?? ''
  return trimmed.length === 0 ? '~/' : ensureBrowseDirectoryPath(trimmed)
}

// derive the folder name git clone would choose from a provider path or remote url.
export function getCloneDirectoryName(repositoryOrRemoteUrl: string | null | undefined): string
{
  const source = repositoryOrRemoteUrl?.trim() ?? ''
  if (source.length === 0) return ''

  let repositoryPath = source
  const isWindowsLocalPath = /^[a-zA-Z]:[\\/]/.test(source)
  if (!isWindowsLocalPath && /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(source))
  {
    try
    {
      repositoryPath = new URL(source).pathname
    }
    catch
    {
      return ''
    }
  }
  else if (!isWindowsLocalPath)
  {
    const scpRemote = /^(?:[^/\\:]+@)?(?:\[[^\]]+\]|[^/\\:]+):(.*)$/.exec(source)
    if (scpRemote) repositoryPath = scpRemote[1] ?? ''
  }

  const lastSegment = repositoryPath
    .split(/[/\\]+/)
    .findLast((segment) => segment.trim().length > 0)
    ?.trim()
  if (!lastSegment) return ''
  return lastSegment.endsWith('.git') ? lastSegment.slice(0, -4) : lastSegment
}

// pin the clone folder below the directory selected by the user.
export function getCloneDestinationPath(
  directoryPath: string,
  directoryName: string | null | undefined,
): string
{
  const name = directoryName?.trim() ?? ''
  return name.length === 0 ? directoryPath : `${ensureBrowseDirectoryPath(directoryPath)}${name}`
}

export function getCloneDestinationBrowsePath(input: {
  readonly browseDirectoryPath: string
  readonly selectedDirectoryName: string
  readonly cloneDirectoryName: string
  readonly caseSensitive: boolean
}): string
{
  const selectedDirectoryPath = appendBrowsePathSegment(
    input.browseDirectoryPath,
    input.selectedDirectoryName,
  )
  const selectedDirectoryMatches = input.caseSensitive
    ? input.selectedDirectoryName === input.cloneDirectoryName
    : input.selectedDirectoryName.toLowerCase() === input.cloneDirectoryName.toLowerCase()
  return selectedDirectoryMatches
    ? selectedDirectoryPath
    : getCloneDestinationPath(selectedDirectoryPath, input.cloneDirectoryName)
}

export function resolveAddProjectPath(input: {
  readonly rawPath: string
  readonly currentProjectCwd?: string | null
  readonly platform: string
}): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string }
{
  const rawPath = input.rawPath.trim()
  if (rawPath.length === 0)
  {
    return { ok: false, error: 'Enter a project path.' }
  }
  if (isUnsupportedWindowsProjectPath(rawPath, input.platform))
  {
    return { ok: false, error: 'Windows-style paths are only supported on Windows environments.' }
  }
  if (isExplicitRelativeProjectPath(rawPath) && !input.currentProjectCwd)
  {
    return { ok: false, error: 'Relative paths require an active project in this environment.' }
  }
  const path = resolveProjectPathForDispatch(rawPath, input.currentProjectCwd)
  return path.length === 0 ? { ok: false, error: 'Enter a project path.' } : { ok: true, path }
}

export function findExistingAddProject(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>
  readonly environmentId: EnvironmentId
  readonly path: string
}): EnvironmentProject | null
{
  return (
    findProjectByPath(
      input.projects.filter((project) => project.environmentId === input.environmentId),
      input.path,
    ) ?? null
  )
}

export function buildProjectCreateCommand(input: {
  readonly commandId: CommandId
  readonly projectId: ProjectId
  readonly workspaceRoot: string
  readonly createdAt: string
}): Extract<OrchestrationCommand, { type: 'project.create' }>
{
  return {
    type: 'project.create',
    commandId: input.commandId,
    projectId: input.projectId,
    title: inferProjectTitleFromPath(input.workspaceRoot),
    workspaceRoot: input.workspaceRoot,
    createWorkspaceRootIfMissing: true,
    defaultModelSelection: null,
    createdAt: input.createdAt,
  }
}
