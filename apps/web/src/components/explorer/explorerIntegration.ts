// apps/web/src/components/explorer/explorerIntegration.ts
// resolves scoped proposal selection and authenticated cartographer browser boundaries
import type { EnvironmentId, ProjectId, Proposal, ThreadId } from '@t3tools/contracts'

const CARTOGRAPHER_EMBED_PATH_PREFIX = '/api/cartographer/embed/'

interface BrowserLocationIdentity
{
  readonly protocol: string
  readonly host: string
  readonly origin: string
}

export interface CartographerEmbedLocation
{
  readonly url: string
  readonly expectedOrigin: string
}

export function resolveCartographerParentOrigin(location: BrowserLocationIdentity): string | null
{
  if (location.protocol === 'code456:' || location.protocol === 'code456-dev:')
  {
    return location.host === 'app' ? `${location.protocol}//${location.host}` : null
  }
  if (location.protocol !== 'http:' && location.protocol !== 'https:')
  {
    return null
  }
  try
  {
    const parsed = new URL(location.origin)
    return parsed.protocol === location.protocol && parsed.origin === location.origin
      ? parsed.origin
      : null
  }
  catch
  {
    return null
  }
}

export function resolveCartographerEmbedLocation(
  environmentHttpBaseUrl: string,
  issuedUrl: string,
): CartographerEmbedLocation | null
{
  try
  {
    const environmentUrl = new URL(environmentHttpBaseUrl)
    if (environmentUrl.protocol !== 'http:' && environmentUrl.protocol !== 'https:')
    {
      return null
    }
    const resolved = new URL(issuedUrl, environmentUrl)
    if (
      resolved.origin !== environmentUrl.origin ||
      !resolved.pathname.startsWith(CARTOGRAPHER_EMBED_PATH_PREFIX) ||
      resolved.searchParams.get('ticket')?.length === 0 ||
      !resolved.searchParams.has('ticket') ||
      resolved.hash.length > 0 ||
      resolved.username.length > 0 ||
      resolved.password.length > 0
    )
    {
      return null
    }
    return {
      url: resolved.toString(),
      expectedOrigin: environmentUrl.origin,
    }
  }
  catch
  {
    return null
  }
}

export function selectLatestScopedProposal(
  proposals: ReadonlyArray<Proposal>,
  scope: {
    readonly environmentId: EnvironmentId
    readonly projectId: ProjectId
    readonly threadId: ThreadId
  },
): Proposal | null
{
  let selected: Proposal | null = null
  for (const proposal of proposals)
  {
    if (
      proposal.environmentId !== scope.environmentId ||
      proposal.projectId !== scope.projectId ||
      proposal.sourceThreadId !== scope.threadId
    )
    {
      continue
    }
    if (
      selected === null ||
      proposal.updatedAt > selected.updatedAt ||
      (proposal.updatedAt === selected.updatedAt && proposal.proposalId < selected.proposalId)
    )
    {
      selected = proposal
    }
  }
  return selected
}
