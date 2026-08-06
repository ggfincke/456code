// apps/web/src/components/command-palette/addProjectRemote.tsx
// derive add-project remote source readiness and labels

import {
  type EnvironmentId,
  type FilesystemBrowseResult,
  type SourceControlDiscoveryResult,
  type SourceControlProviderKind,
  type SourceControlRepositoryInfo,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { LinkIcon } from 'lucide-react'
import { type ReactNode } from 'react'

import { isMacPlatform, isWindowsPlatform } from '../../lib/utils'
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from '../Icons'

export const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult['entries'] = []

export function getLocalFileManagerName(platform: string): string
{
  if (isMacPlatform(platform))
  {
    return 'Finder'
  }
  if (isWindowsPlatform(platform))
  {
    return 'Explorer'
  }
  return 'Files'
}

export function getEnvironmentBrowsePlatform(os: string | null | undefined): string
{
  if (os === 'windows')
  {
    return 'Win32'
  }
  if (os === 'darwin')
  {
    return 'MacIntel'
  }
  if (os === 'linux')
  {
    return 'Linux'
  }
  return typeof navigator === 'undefined' ? '' : navigator.platform
}

export interface AddProjectEnvironmentOption
{
  readonly environmentId: EnvironmentId
  readonly label: string
  readonly isPrimary: boolean
  readonly isConnected: boolean
  readonly status: string
}

export type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  'github' | 'gitlab' | 'bitbucket' | 'azure-devops'
>
export type AddProjectRemoteSource = AddProjectRemoteProviderKind | 'url'

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

export const REMOTE_PROJECT_SOURCES: ReadonlyArray<AddProjectRemoteSource> = [
  'url',
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
]
export const REMOTE_PROJECT_PROVIDER_SOURCES: ReadonlyArray<AddProjectRemoteProviderKind> = [
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
]

export function remoteProjectSourceLabel(source: AddProjectRemoteSource): string
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

export function remoteProjectSourcePathHint(source: AddProjectRemoteSource): string
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

export function remoteProjectSourceProvider(
  source: AddProjectRemoteSource,
): AddProjectRemoteProviderKind | null
{
  return source === 'url' ? null : source
}

export function remoteProjectSourceIcon(
  source: AddProjectRemoteSource,
  className: string,
): ReactNode
{
  switch (source)
  {
    case 'github':
      return <GitHubIcon className={className} />
    case 'gitlab':
      return <GitLabIcon className={className} />
    case 'bitbucket':
      return <BitbucketIcon className={className} />
    case 'azure-devops':
      return <AzureDevOpsIcon className={className} />
    case 'url':
      return <LinkIcon className={className} />
  }
}

export function remoteProjectInputPlaceholder(flow: AddProjectCloneFlow | null): string | null
{
  if (!flow) return null
  if (flow.step === 'confirm') return null
  if (flow.source === 'url')
  {
    return 'Enter Git clone URL'
  }
  return `Enter ${remoteProjectSourceLabel(flow.source)} repository (${remoteProjectSourcePathHint(flow.source)})`
}

export function sourceProviderKind(
  source: AddProjectRemoteSource,
): AddProjectRemoteProviderKind | null
{
  return source === 'url' ? null : source
}

export function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): ReadonlyArray<AddProjectRemoteProviderKind>
{
  return REMOTE_PROJECT_PROVIDER_SOURCES.toSorted((left, right) =>
  {
    const leftReady = readinessBySource[left].ready
    const rightReady = readinessBySource[right].ready
    if (leftReady !== rightReady)
    {
      return leftReady ? -1 : 1
    }
    return remoteProjectSourceLabel(left).localeCompare(remoteProjectSourceLabel(right))
  })
}

export type AddProjectRemoteSourceReadiness = Record<
  AddProjectRemoteSource,
  { readonly ready: boolean; readonly hint: string | null }
>

export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness
{
  const unavailable = {
    ready: false,
    hint: 'Provider status unavailable. Open Settings -> Source Control and rescan.',
  } as const
  const defaultReadiness: AddProjectRemoteSourceReadiness = {
    url: { ready: true, hint: null },
    github: unavailable,
    gitlab: unavailable,
    bitbucket: unavailable,
    'azure-devops': unavailable,
  }

  if (!discovery)
  {
    return defaultReadiness
  }

  const providerByKind = new Map(
    discovery.sourceControlProviders.map((provider) => [provider.kind, provider]),
  )
  const readiness = { ...defaultReadiness }

  for (const source of REMOTE_PROJECT_SOURCES)
  {
    const kind = sourceProviderKind(source)
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
          `${provider.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
      }
      continue
    }
    readiness[source] = { ready: true, hint: null }
  }

  return readiness
}

export function errorMessage(error: unknown): string
{
  if (error instanceof Error && error.message.trim().length > 0)
  {
    return error.message
  }
  return 'An error occurred.'
}
