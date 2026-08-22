// tests/apps/server/ws/handlers/proposalHandlers.test.ts
// verifies proposal generation retries prefer exact durable admission authority

import { it } from '@effect/vitest'
import {
  EnvironmentId,
  ProjectId,
  ProposalGenerationError,
  ProposalGenerationId,
  ProposalId,
  ProposalRevisionId,
  ThreadId,
  WS_METHODS,
  type ProposalGeneration,
  type ProposalGetResult,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { expect } from 'vite-plus/test'

import * as ArchitectureAdmissionService from '../../../../../apps/server/src/architecture/ArchitectureAdmissionService.ts'
import * as ServerEnvironment from '../../../../../apps/server/src/environment/ServerEnvironment.ts'
import * as ProjectionSnapshotQuery from '../../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import * as ProposalGenerationService from '../../../../../apps/server/src/proposal/ProposalGenerationService.ts'
import * as ProposalImplementationAttemptService from '../../../../../apps/server/src/proposal/ProposalImplementationAttemptService.ts'
import * as ProposalService from '../../../../../apps/server/src/proposal/ProposalService.ts'
import { makeProposalRpcHandlers } from '../../../../../apps/server/src/ws/handlers/proposalHandlers.ts'

const environmentId = EnvironmentId.make('environment-proposal-handler')
const projectId = ProjectId.make('project-proposal-handler')
const threadId = ThreadId.make('thread-proposal-handler')
const proposalId = ProposalId.make('proposal-proposal-handler')
const revisionId = ProposalRevisionId.make('revision-proposal-handler')

const selected = {
  proposal: {
    environmentId,
    projectId,
    sourceThreadId: threadId,
  },
  revision: { proposalId, revisionId, revision: 3 },
  revisions: [],
} as unknown as ProposalGetResult

function generation(id: string): ProposalGeneration
{
  return {
    generationId: ProposalGenerationId.make(id),
    proposalId,
    revisionId,
    revision: 3,
    threadId,
    state: 'queued',
    authority: 'authoritative',
    freshness: 'fresh',
    workspaceSnapshotTreeOid: 'workspace-tree',
    analyzerVersion: 'cartographer:test',
    baseGraphArtifact: null,
    proposedGraphArtifact: null,
    impactArtifact: null,
    impactProjectionArtifact: null,
    errorCode: null,
    createdAt: '2026-08-20T15:30:00.000Z',
    updatedAt: '2026-08-20T15:30:00.000Z',
  }
}

it.effect('uses durable admission and fails closed when the exact admission is missing', () =>
  Effect.gen(function* ()
  {
    const admittedGeneration = generation('generation-admitted-handler')
    const admittedCalls: Array<{ readonly revisionId: ProposalRevisionId }> = []
    let hasDurableAdmission = true

    const handlers = makeProposalRpcHandlers({
      proposalService: ProposalService.ProposalService.of({
        upsert: () => Effect.die('unused'),
        list: () => Effect.die('unused'),
        get: () => Effect.succeed(selected),
        diff: () => Effect.die('unused'),
        narrative: () => Effect.die('unused'),
        findLatestByPlan: () => Effect.die('unused'),
        findByOrchestrateRevision: () => Effect.die('unused'),
      }),
      architectureAdmissionService: ArchitectureAdmissionService.ArchitectureAdmissionService.of({
        start: Effect.die('unused'),
        drain: Effect.die('unused'),
        retryProposal: (input) =>
          Effect.sync(() =>
          {
            admittedCalls.push({ revisionId: input.revisionId })
          }).pipe(
            Effect.andThen(
              hasDurableAdmission
                ? Effect.succeed(admittedGeneration)
                : Effect.fail(
                    new ProposalGenerationError({
                      failure: 'not-found',
                      message: 'No durable proposal analysis admission exists.',
                    }),
                  ),
            ),
          ),
        cancelThread: () => Effect.die('unused'),
      }),
      proposalGenerationService: ProposalGenerationService.ProposalGenerationService.of({
        startAdmitted: () => Effect.die('unused'),
        get: () => Effect.die('unused'),
        latest: () => Effect.die('unused'),
        latestAdmitted: () => Effect.die('unused'),
        resolveArchitectureTarget: () => Effect.die('unused'),
        resolveImpactTarget: () => Effect.die('unused'),
        cancelThread: () => Effect.die('unused'),
      }),
      proposalImplementationAttemptService:
        {} as ProposalImplementationAttemptService.ProposalImplementationAttemptService['Service'],
      projectionSnapshotQuery: {
        getThreadShellById: () => Effect.succeed(Option.some({ projectId })),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service'],
      serverEnvironment: {
        getEnvironmentId: Effect.succeed(environmentId),
      } as ServerEnvironment.ServerEnvironment['Service'],
      compileSafeDocumentSource: () => Effect.die('unused'),
      observeRpcEffect: (_method, effect) => effect,
    })

    const input = { threadId, proposalId, revision: 3 }
    expect(yield* handlers[WS_METHODS.proposalsStartGeneration](input)).toEqual(admittedGeneration)

    hasDurableAdmission = false
    const error = yield* handlers[WS_METHODS.proposalsStartGeneration](input).pipe(Effect.flip)
    expect(error).toMatchObject({
      _tag: 'ProposalGenerationError',
      failure: 'not-found',
    })
    expect(admittedCalls).toEqual([{ revisionId }, { revisionId }])
  }),
)
