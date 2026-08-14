// apps/server/src/ws/handlers/proposalHandlers.ts
// builds proposal websocket rpc handlers from narrow concrete dependencies

import { ProposalError, WS_METHODS, type WsRpcGroup } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'

import type * as WorkspaceMdxDocument from '../../mdx/WorkspaceMdxDocument.ts'
import type * as ProjectionSnapshotQuery from '../../orchestration/Services/ProjectionSnapshotQuery.ts'
import type * as ProposalGenerationService from '../../proposal/ProposalGenerationService.ts'
import type * as ProposalImplementationAttemptService from '../../proposal/ProposalImplementationAttemptService.ts'
import type * as ProposalService from '../../proposal/ProposalService.ts'
import type * as ServerEnvironment from '../../environment/ServerEnvironment.ts'
import type { makeRpcAuthorization } from '../rpcAuthorization.ts'

type WsRpcHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>
type ProposalRpcMethod =
  | typeof WS_METHODS.proposalsList
  | typeof WS_METHODS.proposalsGet
  | typeof WS_METHODS.proposalsDiff
  | typeof WS_METHODS.proposalsNarrative
  | typeof WS_METHODS.proposalsFindByPlan
  | typeof WS_METHODS.proposalsFindByOrchestrateRevision
  | typeof WS_METHODS.proposalsStartGeneration
  | typeof WS_METHODS.proposalsGetGeneration
  | typeof WS_METHODS.proposalsLatestGeneration
  | typeof WS_METHODS.proposalsLatestImplementationAttempt
type ProposalRpcHandlers = Pick<WsRpcHandlers, ProposalRpcMethod>

interface ProposalRpcHandlerDependencies
{
  readonly proposalService: ProposalService.ProposalService['Service']
  readonly proposalGenerationService: ProposalGenerationService.ProposalGenerationService['Service']
  readonly proposalImplementationAttemptService: ProposalImplementationAttemptService.ProposalImplementationAttemptService['Service']
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']
  readonly serverEnvironment: ServerEnvironment.ServerEnvironment['Service']
  readonly compileSafeDocumentSource: typeof WorkspaceMdxDocument.compileSafeDocumentSource
  readonly observeRpcEffect: ReturnType<typeof makeRpcAuthorization>['observeRpcEffect']
}

export function makeProposalRpcHandlers({
  proposalService,
  proposalGenerationService,
  proposalImplementationAttemptService,
  projectionSnapshotQuery,
  serverEnvironment,
  compileSafeDocumentSource,
  observeRpcEffect,
}: ProposalRpcHandlerDependencies)
{
  return {
    [WS_METHODS.proposalsList]: (input) =>
      observeRpcEffect(
        WS_METHODS.proposalsList,
        Effect.gen(function* ()
        {
          const environmentId = yield* serverEnvironment.getEnvironmentId
          if (input.environmentId !== environmentId)
          {
            return yield* new ProposalError({
              operation: 'WsProposals.list',
              code: 'identity-mismatch',
              detail: 'The requested proposal environment does not match this server.',
            })
          }
          const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId).pipe(
            Effect.mapError(
              () =>
                new ProposalError({
                  operation: 'WsProposals.list',
                  code: 'identity-mismatch',
                  detail: 'The requested proposal project could not be verified.',
                }),
            ),
          )
          if (Option.isNone(project))
          {
            return yield* new ProposalError({
              operation: 'WsProposals.list',
              code: 'identity-mismatch',
              detail: 'The requested proposal project was not found.',
            })
          }
          if (input.sourceThreadId !== undefined)
          {
            const thread = yield* projectionSnapshotQuery
              .getThreadShellById(input.sourceThreadId)
              .pipe(
                Effect.mapError(
                  () =>
                    new ProposalError({
                      operation: 'WsProposals.list',
                      code: 'identity-mismatch',
                      detail: 'The requested proposal thread could not be verified.',
                    }),
                ),
              )
            if (Option.isNone(thread) || thread.value.projectId !== input.projectId)
            {
              return yield* new ProposalError({
                operation: 'WsProposals.list',
                code: 'identity-mismatch',
                detail: 'The requested proposal thread does not belong to this project.',
              })
            }
          }
          return yield* proposalService.list(input)
        }),
        { 'rpc.aggregate': 'proposal' },
      ),
    [WS_METHODS.proposalsGet]: (input) =>
      observeRpcEffect(
        WS_METHODS.proposalsGet,
        Effect.gen(function* ()
        {
          const selected = yield* proposalService.get(input)
          const environmentId = yield* serverEnvironment.getEnvironmentId
          if (selected.proposal.environmentId !== environmentId)
          {
            return yield* new ProposalError({
              operation: 'WsProposals.get',
              code: 'identity-mismatch',
              detail: 'The proposal does not belong to this server environment.',
              proposalId: input.proposalId,
            })
          }
          return selected
        }),
        { 'rpc.aggregate': 'proposal' },
      ),
    [WS_METHODS.proposalsDiff]: (input) =>
      observeRpcEffect(
        WS_METHODS.proposalsDiff,
        Effect.gen(function* ()
        {
          const selected = yield* proposalService.get(input)
          const environmentId = yield* serverEnvironment.getEnvironmentId
          if (selected.proposal.environmentId !== environmentId)
          {
            return yield* new ProposalError({
              operation: 'WsProposals.diff',
              code: 'identity-mismatch',
              detail: 'The proposal does not belong to this server environment.',
              proposalId: input.proposalId,
            })
          }
          return yield* proposalService.diff(input)
        }),
        { 'rpc.aggregate': 'proposal' },
      ),
    [WS_METHODS.proposalsNarrative]: (input) =>
      observeRpcEffect(
        WS_METHODS.proposalsNarrative,
        Effect.gen(function* ()
        {
          const selected = yield* proposalService.get(input)
          const environmentId = yield* serverEnvironment.getEnvironmentId
          if (selected.proposal.environmentId !== environmentId)
          {
            return yield* new ProposalError({
              operation: 'WsProposals.narrative',
              code: 'identity-mismatch',
              detail: 'The proposal does not belong to this server environment.',
              proposalId: input.proposalId,
            })
          }
          const narrative = yield* proposalService.narrative(input)
          if (narrative === null) return null
          const document = yield* compileSafeDocumentSource({
            threadId: selected.proposal.sourceThreadId,
            relativePath: 'proposal-narrative.mdx',
            source: narrative.source,
          })
          return {
            proposalId: narrative.proposalId,
            revisionId: narrative.revisionId,
            revision: narrative.revision,
            sourceSha256: narrative.sourceSha256,
            document,
          }
        }),
        { 'rpc.aggregate': 'proposal' },
      ),
    [WS_METHODS.proposalsFindByPlan]: (input) =>
      observeRpcEffect(
        WS_METHODS.proposalsFindByPlan,
        Effect.gen(function* ()
        {
          const thread = yield* projectionSnapshotQuery
            .getThreadShellById(input.sourceThreadId)
            .pipe(
              Effect.mapError(
                () =>
                  new ProposalError({
                    operation: 'WsProposals.findByPlan',
                    code: 'identity-mismatch',
                    detail: 'The proposal source thread could not be verified.',
                  }),
              ),
            )
          if (Option.isNone(thread))
          {
            return yield* new ProposalError({
              operation: 'WsProposals.findByPlan',
              code: 'identity-mismatch',
              detail: 'The proposal source thread was not found.',
            })
          }
          const linked = yield* proposalService.findLatestByPlan(input)
          if (linked === null) return null
          const environmentId = yield* serverEnvironment.getEnvironmentId
          if (
            linked.proposal.environmentId !== environmentId ||
            linked.proposal.projectId !== thread.value.projectId
          )
          {
            return yield* new ProposalError({
              operation: 'WsProposals.findByPlan',
              code: 'identity-mismatch',
              detail: 'The linked proposal is outside the authenticated thread scope.',
              proposalId: linked.proposal.proposalId,
            })
          }
          return linked
        }),
        { 'rpc.aggregate': 'proposal' },
      ),
    [WS_METHODS.proposalsFindByOrchestrateRevision]: (input) =>
      observeRpcEffect(
        WS_METHODS.proposalsFindByOrchestrateRevision,
        Effect.gen(function* ()
        {
          const thread = yield* projectionSnapshotQuery
            .getThreadDetailById(input.sourceThreadId)
            .pipe(
              Effect.mapError(
                () =>
                  new ProposalError({
                    operation: 'WsProposals.findByOrchestrateRevision',
                    code: 'identity-mismatch',
                    detail: 'The proposal source thread could not be verified.',
                  }),
              ),
            )
          if (Option.isNone(thread))
          {
            return yield* new ProposalError({
              operation: 'WsProposals.findByOrchestrateRevision',
              code: 'identity-mismatch',
              detail: 'The proposal source thread was not found.',
            })
          }
          const exactPlan = thread.value.orchestratePlans.find(
            (candidate) => candidate.runId === input.runId && candidate.revision === input.revision,
          )
          if (exactPlan === undefined) return null
          const linked = yield* proposalService.findByOrchestrateRevision(input)
          if (linked === null) return null
          const environmentId = yield* serverEnvironment.getEnvironmentId
          if (
            linked.proposal.environmentId !== environmentId ||
            linked.proposal.projectId !== thread.value.projectId ||
            linked.proposal.sourceThreadId !== input.sourceThreadId ||
            linked.link.proposalId !== linked.proposal.proposalId ||
            linked.link.proposalRevision !== linked.revision.revision ||
            linked.link.sourceThreadId !== input.sourceThreadId ||
            linked.link.runId !== input.runId ||
            linked.link.revision !== input.revision ||
            linked.orchestratePlan.runId !== input.runId ||
            linked.orchestratePlan.revision !== input.revision ||
            linked.orchestratePlan.runId !== exactPlan.runId ||
            linked.orchestratePlan.revision !== exactPlan.revision
          )
          {
            return yield* new ProposalError({
              operation: 'WsProposals.findByOrchestrateRevision',
              code: 'identity-mismatch',
              detail: 'The linked proposal is outside the authenticated orchestrate revision.',
              proposalId: linked.proposal.proposalId,
            })
          }
          return linked
        }),
        { 'rpc.aggregate': 'proposal' },
      ),
    [WS_METHODS.proposalsStartGeneration]: (input) =>
      observeRpcEffect(
        WS_METHODS.proposalsStartGeneration,
        Effect.gen(function* ()
        {
          const thread = yield* projectionSnapshotQuery.getThreadShellById(input.threadId).pipe(
            Effect.mapError(
              () =>
                new ProposalError({
                  operation: 'WsProposals.startGeneration',
                  code: 'identity-mismatch',
                  detail: 'The proposal thread could not be verified.',
                  proposalId: input.proposalId,
                }),
            ),
          )
          const selected = yield* proposalService.get({
            proposalId: input.proposalId,
            ...(input.revision === undefined ? {} : { revision: input.revision }),
          })
          const environmentId = yield* serverEnvironment.getEnvironmentId
          if (
            Option.isNone(thread) ||
            selected.proposal.environmentId !== environmentId ||
            selected.proposal.projectId !== thread.value.projectId ||
            selected.proposal.sourceThreadId !== input.threadId
          )
          {
            return yield* new ProposalError({
              operation: 'WsProposals.startGeneration',
              code: 'identity-mismatch',
              detail: 'The proposal revision is outside the authenticated thread scope.',
              proposalId: input.proposalId,
            })
          }
          return yield* proposalGenerationService.start(input)
        }),
        { 'rpc.aggregate': 'proposal' },
      ),
    [WS_METHODS.proposalsGetGeneration]: (input) =>
      observeRpcEffect(WS_METHODS.proposalsGetGeneration, proposalGenerationService.get(input), {
        'rpc.aggregate': 'proposal',
      }),
    [WS_METHODS.proposalsLatestGeneration]: (input) =>
      observeRpcEffect(
        WS_METHODS.proposalsLatestGeneration,
        proposalGenerationService.latest(input),
        { 'rpc.aggregate': 'proposal' },
      ),
    [WS_METHODS.proposalsLatestImplementationAttempt]: (input) =>
      observeRpcEffect(
        WS_METHODS.proposalsLatestImplementationAttempt,
        Effect.gen(function* ()
        {
          const selected = yield* proposalService.get({
            proposalId: input.proposalId,
            ...(input.revision === undefined ? {} : { revision: input.revision }),
          })
          const environmentId = yield* serverEnvironment.getEnvironmentId
          if (
            selected.proposal.environmentId !== environmentId ||
            selected.proposal.sourceThreadId !== input.sourceThreadId
          )
          {
            return yield* new ProposalError({
              operation: 'WsProposals.latestImplementationAttempt',
              code: 'identity-mismatch',
              detail: 'The proposal revision is outside the authenticated thread scope.',
              proposalId: input.proposalId,
            })
          }
          return yield* proposalImplementationAttemptService.latestForProposal(input).pipe(
            Effect.mapError(
              () =>
                new ProposalError({
                  operation: 'WsProposals.latestImplementationAttempt',
                  code: 'persistence-failed',
                  detail: 'The proposal implementation status could not be read.',
                  proposalId: input.proposalId,
                }),
            ),
          )
        }),
        { 'rpc.aggregate': 'proposal' },
      ),
  } satisfies ProposalRpcHandlers
}
