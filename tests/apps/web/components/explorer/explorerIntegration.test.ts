// tests/apps/web/components/explorer/explorerIntegration.test.ts
// verifies explorer scope selection and authenticated browser URL boundaries
import type { EnvironmentId, ProjectId, Proposal, ThreadId } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  resolveCartographerEmbedLocation,
  resolveCartographerParentOrigin,
  selectLatestScopedProposal,
} from '../../../../../apps/web/src/components/explorer/explorerIntegration'

const environmentId = 'environment-explorer' as EnvironmentId
const projectId = 'project-explorer' as ProjectId
const threadId = 'thread-explorer' as ThreadId

function proposal(
  proposalId: string,
  updatedAt: string,
  scope: {
    readonly environmentId?: EnvironmentId
    readonly projectId?: ProjectId
    readonly threadId?: ThreadId
  } = {},
): Proposal
{
  return {
    proposalId,
    environmentId: scope.environmentId ?? environmentId,
    projectId: scope.projectId ?? projectId,
    sourceThreadId: scope.threadId ?? threadId,
    updatedAt,
  } as Proposal
}

describe('explorerIntegration', () =>
{
  it('derives only exact browser parent origins supported by the server', () =>
  {
    expect(
      resolveCartographerParentOrigin({
        protocol: 'https:',
        host: 'app.456code.test',
        origin: 'https://app.456code.test',
      }),
    ).toBe('https://app.456code.test')
    expect(
      resolveCartographerParentOrigin({
        protocol: 'code456:',
        host: 'app',
        origin: 'null',
      }),
    ).toBe('code456://app')
    expect(
      resolveCartographerParentOrigin({
        protocol: 'code456-dev:',
        host: 'app',
        origin: 'null',
      }),
    ).toBe('code456-dev://app')
    expect(
      resolveCartographerParentOrigin({
        protocol: 'code456:',
        host: 'unexpected',
        origin: 'null',
      }),
    ).toBeNull()
    expect(
      resolveCartographerParentOrigin({
        protocol: 'file:',
        host: '',
        origin: 'null',
      }),
    ).toBeNull()
  })

  it('binds issued embed tickets to the authenticated environment origin and route', () =>
  {
    expect(
      resolveCartographerEmbedLocation(
        'https://remote.456code.test/base/',
        '/api/cartographer/embed/session-1/exchange?ticket=ticket-1',
      ),
    ).toEqual({
      url: 'https://remote.456code.test/api/cartographer/embed/session-1/exchange?ticket=ticket-1',
      expectedOrigin: 'https://remote.456code.test',
    })
    expect(
      resolveCartographerEmbedLocation(
        'https://remote.456code.test/',
        'https://attacker.invalid/api/cartographer/embed/session-1/exchange?ticket=ticket-1',
      ),
    ).toBeNull()
    expect(
      resolveCartographerEmbedLocation(
        'https://remote.456code.test/',
        '/unrelated/session-1?ticket=ticket-1',
      ),
    ).toBeNull()
    expect(
      resolveCartographerEmbedLocation(
        'https://remote.456code.test/',
        '/api/cartographer/embed/session-1/exchange',
      ),
    ).toBeNull()
    expect(
      resolveCartographerEmbedLocation(
        'https://remote.456code.test/',
        '/api/cartographer/embed/session-1/exchange?ticket=ticket-1#fragment',
      ),
    ).toBeNull()
  })

  it('chooses the newest deterministic proposal without crossing scope', () =>
  {
    const selected = selectLatestScopedProposal(
      [
        proposal('proposal-z', '2026-07-27T12:00:00.000Z'),
        proposal('proposal-b', '2026-07-27T13:00:00.000Z'),
        proposal('proposal-a', '2026-07-27T13:00:00.000Z'),
        proposal('proposal-newer-other-thread', '2026-07-27T14:00:00.000Z', {
          threadId: 'thread-other' as ThreadId,
        }),
      ],
      { environmentId, projectId, threadId },
    )

    expect(selected?.proposalId).toBe('proposal-a')
  })
})
