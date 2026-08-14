// apps/web/src/components/explorer/ConnectedExplorerPanel.tsx
// connects Proposal Review to immutable proposal and architecture summary state
import type {
  ArchitectureImpactResult,
  ArchitectureImpactResultV2,
  ArchitectureProposalSource,
  ProjectId,
  ProposalGeneration,
  ScopedThreadRef,
} from '@t3tools/contracts'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from '@t3tools/client-runtime/state/runtime'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { projectEnvironment } from '~/state/projects'
import { useEnvironmentQuery } from '~/state/query'
import { useAtomCommand } from '~/state/use-atom-command'
import { useRightPanelStore } from '~/rightPanelStore'

import { createArchitectureImpactSurface } from '../architecture/architectureResourceIdentity'
import { selectExactOrchestrateProposalLookup } from '../cartographer/orchestrateArchitecture'
import { formatProposalGenerationFailure } from '../cartographer/proposalGenerationFailure'
import {
  completeProposalGenerationStart,
  createProposalGenerationStartTarget,
  failProposalGenerationStart,
  recordObservedProposalGenerationFailure,
  useProposalGenerationStart,
} from '../chat/proposedPlanGenerationStart'
import {
  ExplorerPanel,
  type ExplorerArchitecturePresentation,
  type ExplorerNarrativePresentation,
} from './ExplorerPanel'
import { selectLatestScopedProposal } from './proposalSelection'
import type {
  ProposalDiffAvailability,
  ProposalDiffFileActions,
  ProposalDiffPresentation,
} from '../proposals/ProposalDiffPanel'
import type { ExplorerTarget } from '../../stores/rightPanelStore'

const PROPOSAL_LIST_REFRESH_MS = 5_000
const LATEST_GENERATION_REFRESH_MS = 3_000
const ACTIVE_GENERATION_REFRESH_MS = 1_500
const READY_GENERATION_REFRESH_MS = 10_000
const IMPLEMENTATION_ATTEMPT_REFRESH_MS = 5_000

interface ConnectedExplorerPanelProps
{
  readonly threadRef: ScopedThreadRef
  readonly projectId: ProjectId
  readonly target: ExplorerTarget | null
  readonly proposalPreviewAvailable: boolean
  readonly architectureImpactAvailable: boolean
  readonly onOpenFile: (path: string, line?: number) => void
}

export function isProposalDiscoverySettled(input: {
  readonly settledKey: string | null
  readonly key: string
  readonly settledNow: boolean
}): boolean
{
  return input.settledNow || input.settledKey === input.key
}

export function isExplorerTargetScopedToThread(
  target: ExplorerTarget | null,
  threadId: ScopedThreadRef['threadId'],
): boolean
{
  return target?.kind !== 'orchestrate' || target.threadId === threadId
}

export function selectExactProposalDiffSources(
  result: ArchitectureImpactResult | null,
  expected: Pick<ProposalGeneration, 'generationId' | 'threadId'>,
): Pick<ProposalDiffFileActions, 'beforeSource' | 'proposedSource'> | null
{
  if (
    result?.version !== 2 ||
    result.comparison.kind !== 'proposal-generation' ||
    result.comparison.generationId !== expected.generationId
  )
  {
    return null
  }
  const sourceMatches = (
    source: ArchitectureImpactResultV2['baseSource'],
    side: ArchitectureProposalSource['side'],
  ): source is ArchitectureProposalSource =>
    source.kind === 'proposal-generation' &&
    source.threadId === expected.threadId &&
    source.generationId === expected.generationId &&
    source.side === side
  const beforeSource = sourceMatches(result.baseSource, 'base') ? result.baseSource : null
  const proposedSource = sourceMatches(result.headSource, 'proposed') ? result.headSource : null
  return beforeSource === null && proposedSource === null ? null : { beforeSource, proposedSource }
}

function commandFailureMessage(
  result: Exclude<AtomCommandResult<unknown, unknown>, { readonly _tag: 'Success' }>,
  fallback: string,
): string
{
  if (isAtomCommandInterrupted(result))
  {
    return `${fallback} was superseded by a newer request.`
  }
  const error = squashAtomCommandFailure(result)
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

function generationLoadingMessage(generation: ProposalGeneration): string
{
  switch (generation.state)
  {
    case 'queued':
      return 'Exact proposal analysis is queued.'
    case 'preparing':
      return 'Materializing the exact proposed tree.'
    case 'analyzing':
      return 'Analyzing the exact proposed tree.'
    default:
      return 'Preparing exact proposal analysis.'
  }
}

function useProposalListRefresh(input: {
  readonly enabled: boolean
  readonly refresh: () => void
}): void
{
  useEffect(() =>
  {
    if (!input.enabled) return
    const intervalId = window.setInterval(input.refresh, PROPOSAL_LIST_REFRESH_MS)
    return () => window.clearInterval(intervalId)
  }, [input.enabled, input.refresh])
}

function useLatestGenerationRefresh(input: {
  readonly enabled: boolean
  readonly refresh: () => void
}): void
{
  useEffect(() =>
  {
    if (!input.enabled) return
    const intervalId = window.setInterval(input.refresh, LATEST_GENERATION_REFRESH_MS)
    return () => window.clearInterval(intervalId)
  }, [input.enabled, input.refresh])
}

function useGenerationRefresh(input: {
  readonly generation: ProposalGeneration | null
  readonly queryFailed: boolean
  readonly refresh: () => void
}): void
{
  useEffect(() =>
  {
    if (input.generation === null || input.queryFailed) return
    const intervalMs =
      input.generation.state === 'ready'
        ? READY_GENERATION_REFRESH_MS
        : input.generation.state === 'queued' ||
            input.generation.state === 'preparing' ||
            input.generation.state === 'analyzing'
          ? ACTIVE_GENERATION_REFRESH_MS
          : null
    if (intervalMs === null) return
    const intervalId = window.setInterval(input.refresh, intervalMs)
    return () => window.clearInterval(intervalId)
  }, [input.generation, input.queryFailed, input.refresh])
}

function useImplementationAttemptRefresh(input: {
  readonly enabled: boolean
  readonly refresh: () => void
}): void
{
  useEffect(() =>
  {
    if (!input.enabled) return
    const intervalId = window.setInterval(input.refresh, IMPLEMENTATION_ATTEMPT_REFRESH_MS)
    return () => window.clearInterval(intervalId)
  }, [input.enabled, input.refresh])
}

export function ConnectedExplorerPanel(props: ConnectedExplorerPanelProps)
{
  const startProposalGeneration = useAtomCommand(projectEnvironment.startProposalGeneration, {
    reportFailure: false,
  })
  const planTarget = props.target?.kind === 'plan' ? props.target : null
  const rawOrchestrateTarget = props.target?.kind === 'orchestrate' ? props.target : null
  const orchestrateTargetScoped = isExplorerTargetScopedToThread(
    props.target,
    props.threadRef.threadId,
  )
  const orchestrateTarget = orchestrateTargetScoped ? rawOrchestrateTarget : null
  const planProposalQuery = useEnvironmentQuery(
    props.proposalPreviewAvailable && planTarget !== null
      ? projectEnvironment.findProposalByPlan({
          environmentId: props.threadRef.environmentId,
          input: {
            sourceThreadId: props.threadRef.threadId,
            planId: planTarget.planId,
          },
        })
      : null,
  )
  useProposalListRefresh({
    enabled: props.proposalPreviewAvailable && planTarget !== null,
    refresh: planProposalQuery.refresh,
  })
  const orchestrateProposalQuery = useEnvironmentQuery(
    props.proposalPreviewAvailable && orchestrateTarget !== null
      ? projectEnvironment.findProposalByOrchestrateRevision({
          environmentId: props.threadRef.environmentId,
          input: {
            sourceThreadId: orchestrateTarget.threadId,
            runId: orchestrateTarget.runId,
            revision: orchestrateTarget.revision,
          },
        })
      : null,
  )
  useProposalListRefresh({
    enabled: props.proposalPreviewAvailable && orchestrateTarget !== null,
    refresh: orchestrateProposalQuery.refresh,
  })
  const proposalListQuery = useEnvironmentQuery(
    props.proposalPreviewAvailable && props.target === null
      ? projectEnvironment.listProposals({
          environmentId: props.threadRef.environmentId,
          input: {
            environmentId: props.threadRef.environmentId,
            projectId: props.projectId,
            sourceThreadId: props.threadRef.threadId,
          },
        })
      : null,
  )
  useProposalListRefresh({
    enabled: props.proposalPreviewAvailable && props.target === null,
    refresh: proposalListQuery.refresh,
  })
  const exactOrchestrateLookup = useMemo(
    () =>
      orchestrateTarget === null
        ? null
        : selectExactOrchestrateProposalLookup(orchestrateProposalQuery.data, orchestrateTarget),
    [orchestrateProposalQuery.data, orchestrateTarget],
  )

  const selectedProposal = useMemo(() =>
  {
    if (planTarget !== null)
    {
      const proposal = planProposalQuery.data?.proposal ?? null
      return proposal !== null &&
        proposal.environmentId === props.threadRef.environmentId &&
        proposal.projectId === props.projectId &&
        proposal.sourceThreadId === props.threadRef.threadId &&
        planProposalQuery.data?.revision.planId === planTarget.planId
        ? proposal
        : null
    }
    if (rawOrchestrateTarget !== null)
    {
      const proposal = exactOrchestrateLookup?.proposal ?? null
      return proposal !== null &&
        proposal.environmentId === props.threadRef.environmentId &&
        proposal.projectId === props.projectId
        ? proposal
        : null
    }
    return proposalListQuery.data === null
      ? null
      : selectLatestScopedProposal(proposalListQuery.data.proposals, {
          environmentId: props.threadRef.environmentId,
          projectId: props.projectId,
          threadId: props.threadRef.threadId,
        })
  }, [
    exactOrchestrateLookup,
    rawOrchestrateTarget,
    planProposalQuery.data,
    planTarget,
    proposalListQuery.data,
    props.projectId,
    props.threadRef.environmentId,
    props.threadRef.threadId,
  ])
  const selectedRevision =
    selectedProposal !== null && planTarget !== null
      ? (planProposalQuery.data?.revision.revision ?? null)
      : selectedProposal !== null && orchestrateTarget !== null
        ? (exactOrchestrateLookup?.revision.revision ?? null)
        : (selectedProposal?.latestRevision ?? null)
  const proposalSelector =
    selectedProposal === null || selectedRevision === null
      ? null
      : {
          proposalId: selectedProposal.proposalId,
          revision: selectedRevision,
        }
  const proposalSourceThreadId =
    orchestrateTarget?.threadId ?? selectedProposal?.sourceThreadId ?? props.threadRef.threadId
  const proposalDiscoveryError =
    planTarget !== null
      ? planProposalQuery.data === null
        ? planProposalQuery.error
        : null
      : rawOrchestrateTarget !== null
        ? orchestrateTargetScoped && orchestrateProposalQuery.data === null
          ? orchestrateProposalQuery.error
          : null
        : proposalListQuery.data === null
          ? proposalListQuery.error
          : null
  const proposalDiscoveryPending =
    planTarget !== null
      ? planProposalQuery.data === null && planProposalQuery.isPending
      : rawOrchestrateTarget !== null
        ? orchestrateTargetScoped &&
          orchestrateProposalQuery.data === null &&
          orchestrateProposalQuery.isPending
        : proposalListQuery.data === null && proposalListQuery.error === null
  const proposalDiscoverySettledNow =
    planTarget !== null
      ? planProposalQuery.data !== null ||
        (!planProposalQuery.isPending && planProposalQuery.error === null)
      : rawOrchestrateTarget !== null
        ? !orchestrateTargetScoped ||
          orchestrateProposalQuery.data !== null ||
          (!orchestrateProposalQuery.isPending && orchestrateProposalQuery.error === null)
        : proposalListQuery.data !== null
  const proposalDiscoveryTargetKey =
    planTarget !== null
      ? `plan:${planTarget.planId}`
      : rawOrchestrateTarget !== null
        ? `orchestrate:${rawOrchestrateTarget.threadId}:${rawOrchestrateTarget.runId}:${rawOrchestrateTarget.revision}`
        : 'latest'
  const proposalDiscoveryKey = [
    props.threadRef.environmentId,
    props.threadRef.threadId,
    proposalDiscoveryTargetKey,
  ].join(':')
  const [settledProposalDiscoveryKey, setSettledProposalDiscoveryKey] = useState<string | null>(
    null,
  )
  const proposalDiscoverySettled = isProposalDiscoverySettled({
    settledKey: settledProposalDiscoveryKey,
    key: proposalDiscoveryKey,
    settledNow: proposalDiscoverySettledNow,
  })
  useEffect(() =>
  {
    if (!proposalDiscoverySettledNow) return
    setSettledProposalDiscoveryKey((settledKey) =>
      settledKey === proposalDiscoveryKey ? settledKey : proposalDiscoveryKey,
    )
  }, [proposalDiscoveryKey, proposalDiscoverySettledNow])
  const proposalQuery = useEnvironmentQuery(
    proposalSelector === null
      ? null
      : projectEnvironment.getProposal({
          environmentId: props.threadRef.environmentId,
          input: proposalSelector,
        }),
  )
  const proposalDiffQuery = useEnvironmentQuery(
    proposalSelector === null
      ? null
      : projectEnvironment.getProposalDiff({
          environmentId: props.threadRef.environmentId,
          input: proposalSelector,
        }),
  )
  const proposalNarrativeQuery = useEnvironmentQuery(
    proposalSelector === null
      ? null
      : projectEnvironment.getProposalNarrative({
          environmentId: props.threadRef.environmentId,
          input: proposalSelector,
        }),
  )
  const implementationAttemptQuery = useEnvironmentQuery(
    proposalSelector === null
      ? null
      : projectEnvironment.latestProposalImplementationAttempt({
          environmentId: props.threadRef.environmentId,
          input: {
            sourceThreadId: proposalSourceThreadId,
            proposalId: proposalSelector.proposalId,
            revision: proposalSelector.revision,
          },
        }),
  )
  useImplementationAttemptRefresh({
    enabled: proposalSelector !== null,
    refresh: implementationAttemptQuery.refresh,
  })
  const latestGenerationQuery = useEnvironmentQuery(
    proposalSelector === null || !props.architectureImpactAvailable
      ? null
      : projectEnvironment.latestProposalGeneration({
          environmentId: props.threadRef.environmentId,
          input: {
            threadId: proposalSourceThreadId,
            proposalId: proposalSelector.proposalId,
            revision: proposalSelector.revision,
          },
        }),
  )
  useLatestGenerationRefresh({
    enabled: proposalSelector !== null && props.architectureImpactAvailable,
    refresh: latestGenerationQuery.refresh,
  })

  const generationStartTarget =
    proposalSelector === null
      ? null
      : createProposalGenerationStartTarget({
          environmentId: props.threadRef.environmentId,
          threadId: proposalSourceThreadId,
          proposalId: proposalSelector.proposalId,
          revision: proposalSelector.revision,
        })
  const generationStartKey = generationStartTarget?.key ?? null
  const {
    state: generationStartState,
    claimAutomatic,
    claimManual,
  } = useProposalGenerationStart(generationStartTarget)

  const requestProposalGeneration = useCallback(
    (mode: 'automatic' | 'manual'): void =>
    {
      if (proposalSelector === null || generationStartKey === null) return
      const attempt =
        mode === 'automatic'
          ? claimAutomatic(latestGenerationQuery.data)
          : claimManual(latestGenerationQuery.data)
      if (attempt === null) return

      void startProposalGeneration({
        environmentId: props.threadRef.environmentId,
        input: {
          threadId: proposalSourceThreadId,
          proposalId: proposalSelector.proposalId,
          revision: proposalSelector.revision,
        },
      }).then((result) =>
      {
        if (result._tag === 'Success')
        {
          if (completeProposalGenerationStart(attempt, result.value))
          {
            latestGenerationQuery.refresh()
          }
          return
        }
        if (
          failProposalGenerationStart(
            attempt,
            commandFailureMessage(result, 'Exact architecture analysis could not start'),
          )
        )
        {
          latestGenerationQuery.refresh()
        }
      })
    },
    [
      claimAutomatic,
      claimManual,
      generationStartKey,
      latestGenerationQuery.data,
      latestGenerationQuery.refresh,
      proposalSourceThreadId,
      proposalSelector,
      props.threadRef.environmentId,
      startProposalGeneration,
    ],
  )

  useEffect(() =>
  {
    if (
      !props.architectureImpactAvailable ||
      proposalSelector === null ||
      generationStartKey === null ||
      proposalQuery.data === null ||
      (latestGenerationQuery.isPending && latestGenerationQuery.data === null) ||
      (latestGenerationQuery.error !== null && latestGenerationQuery.data === null) ||
      latestGenerationQuery.data !== null
    )
    {
      return
    }
    requestProposalGeneration('automatic')
  }, [
    generationStartKey,
    latestGenerationQuery.data,
    latestGenerationQuery.error,
    latestGenerationQuery.isPending,
    proposalQuery.data,
    proposalSelector,
    props.architectureImpactAvailable,
    requestProposalGeneration,
  ])

  const generationSeed =
    generationStartState.status === 'started'
      ? generationStartState.generation
      : latestGenerationQuery.data
  const generationQuery = useEnvironmentQuery(
    generationSeed === null
      ? null
      : projectEnvironment.getProposalGeneration({
          environmentId: props.threadRef.environmentId,
          input: {
            threadId: proposalSourceThreadId,
            generationId: generationSeed.generationId,
          },
        }),
  )
  const generation =
    generationQuery.data !== null &&
    generationQuery.data.generationId === generationSeed?.generationId
      ? generationQuery.data
      : generationSeed
  useGenerationRefresh({
    generation,
    queryFailed: generationQuery.error !== null,
    refresh: generationQuery.refresh,
  })
  const architectureImpactQuery = useEnvironmentQuery(
    props.architectureImpactAvailable && generation?.state === 'ready'
      ? projectEnvironment.getArchitectureImpact({
          environmentId: props.threadRef.environmentId,
          input: {
            threadId: proposalSourceThreadId,
            comparison: {
              kind: 'proposal-generation',
              generationId: generation.generationId,
            },
          },
        })
      : null,
  )
  const exactProposalDiffSources =
    generation?.state === 'ready'
      ? selectExactProposalDiffSources(architectureImpactQuery.data, {
          generationId: generation.generationId,
          threadId: proposalSourceThreadId,
        })
      : null
  const openExactProposalFile = useCallback(
    (source: ArchitectureProposalSource, filePath: string): void =>
    {
      useRightPanelStore
        .getState()
        .openArchitectureFile(props.threadRef, source, filePath, undefined, 'explorer')
    },
    [props.threadRef],
  )
  const proposalFileActions: ProposalDiffFileActions | undefined = exactProposalDiffSources
    ? { ...exactProposalDiffSources, onOpenFile: openExactProposalFile }
    : undefined
  const generationIsTerminalFailure =
    generation?.state === 'failed' ||
    generation?.state === 'cancelled' ||
    generation?.state === 'abandoned'
  useEffect(() =>
  {
    if (generationStartTarget === null || generation === null || !generationIsTerminalFailure)
    {
      return
    }
    recordObservedProposalGenerationFailure(
      generationStartTarget,
      generationStartState.attemptId,
      generation,
      formatProposalGenerationFailure(generation),
    )
  }, [
    generation,
    generationIsTerminalFailure,
    generationStartState.attemptId,
    generationStartTarget,
  ])

  const proposal: ProposalDiffPresentation | null =
    proposalQuery.data === null
      ? null
      : {
          proposalId: proposalQuery.data.proposal.proposalId,
          revisionNumber: proposalQuery.data.revision.revision,
          snapshotTreeOid: proposalQuery.data.revision.baseSnapshot.workingTreeOid,
          exactDiff: proposalDiffQuery.data?.diff ?? '',
          operationCount: proposalQuery.data.revision.manifest.operationCount,
          byteCount: proposalQuery.data.revision.diffByteLength,
        }
  const proposalAvailability: ProposalDiffAvailability = !props.proposalPreviewAvailable
    ? {
        kind: 'unsupported',
        reason: 'This server does not support immutable proposal previews.',
      }
    : proposalDiscoveryError !== null
      ? { kind: 'error', message: proposalDiscoveryError }
      : proposalDiscoveryPending
        ? { kind: 'loading' }
        : proposalDiscoverySettled && selectedProposal === null
          ? {
              kind: 'unsupported',
              reason:
                props.target === null
                  ? 'No immutable proposal revision exists for this thread.'
                  : rawOrchestrateTarget !== null
                    ? 'No immutable proposal revision is linked to this exact orchestrate plan revision.'
                    : 'No immutable proposal revision is linked to this exact plan.',
            }
          : proposalQuery.error !== null && proposalQuery.data === null
            ? { kind: 'error', message: proposalQuery.error }
            : proposalQuery.data === null ||
                (proposalDiffQuery.isPending && proposalDiffQuery.data === null)
              ? { kind: 'loading' }
              : proposalDiffQuery.error !== null && proposalDiffQuery.data === null
                ? { kind: 'error', message: proposalDiffQuery.error }
                : proposalDiffQuery.data === null || !proposalDiscoverySettled
                  ? { kind: 'loading' }
                  : { kind: 'ready' }

  const narrative: ExplorerNarrativePresentation = !props.proposalPreviewAvailable
    ? {
        kind: 'empty',
        message: 'No safe proposal narrative is available for this thread.',
      }
    : proposalDiscoveryError !== null
      ? { kind: 'error', message: proposalDiscoveryError }
      : proposalDiscoveryPending
        ? { kind: 'loading' }
        : selectedProposal === null
          ? {
              kind: 'empty',
              message:
                props.target === null
                  ? 'No safe proposal narrative is available for this thread.'
                  : rawOrchestrateTarget !== null
                    ? 'No safe proposal narrative is linked to this exact orchestrate plan revision.'
                    : 'No safe proposal narrative is linked to this exact plan.',
            }
          : proposalNarrativeQuery.error !== null && proposalNarrativeQuery.data === null
            ? { kind: 'error', message: proposalNarrativeQuery.error }
            : proposalNarrativeQuery.isPending && proposalNarrativeQuery.data === null
              ? { kind: 'loading' }
              : proposalNarrativeQuery.data === null
                ? {
                    kind: 'empty',
                    message: 'No safe proposal narrative is available for this revision.',
                  }
                : {
                    kind: 'ready',
                    document: proposalNarrativeQuery.data.document.document,
                    source: proposalNarrativeQuery.data.document.source,
                    documentPath: proposalNarrativeQuery.data.document.relativePath,
                  }
  const attempt =
    implementationAttemptQuery.data === null
      ? null
      : {
          outcome: implementationAttemptQuery.data.outcome,
          matchedOperationCount: implementationAttemptQuery.data.matchedOperationCount,
          intendedOperationCount: implementationAttemptQuery.data.intendedOperationCount,
        }

  const retryGenerationDetail = useCallback(
    () => generationQuery.refresh(),
    [generationQuery.refresh],
  )
  const architectureImpactTarget =
    generation?.state === 'ready'
      ? {
          threadId: proposalSourceThreadId,
          comparison: {
            kind: 'proposal-generation' as const,
            generationId: generation.generationId,
          },
        }
      : null
  const openArchitectureImpact = useCallback((): void =>
  {
    if (architectureImpactTarget === null) return
    useRightPanelStore
      .getState()
      .openArchitectureSurface(
        props.threadRef,
        createArchitectureImpactSurface(architectureImpactTarget),
        'explorer',
      )
  }, [architectureImpactTarget, props.threadRef])
  const architecture: ExplorerArchitecturePresentation = (() =>
  {
    if (!props.architectureImpactAvailable)
    {
      return {
        kind: 'unavailable',
        reason: 'Native architecture impact is not available for this server environment.',
      }
    }
    if (props.proposalPreviewAvailable && proposalDiscoveryError !== null)
    {
      return { kind: 'error', message: proposalDiscoveryError }
    }
    if (props.proposalPreviewAvailable && !proposalDiscoverySettled)
    {
      return {
        kind: 'loading',
        message:
          props.target === null
            ? 'Looking for immutable proposal revisions.'
            : rawOrchestrateTarget !== null
              ? 'Looking up the immutable revision linked to this exact orchestrate plan revision.'
              : 'Looking up the immutable revision linked to this exact plan.',
      }
    }
    if (!orchestrateTargetScoped)
    {
      return {
        kind: 'unavailable',
        reason: 'This Proposal Review target belongs to a different thread.',
      }
    }
    if (rawOrchestrateTarget !== null && selectedProposal === null)
    {
      return {
        kind: 'unavailable',
        reason: 'No architecture proposal is linked to this exact orchestrate plan revision.',
      }
    }
    if (selectedProposal === null)
    {
      return {
        kind: 'unavailable',
        reason: 'No immutable proposal revision is available for Impact.',
      }
    }
    if (selectedProposal !== null)
    {
      if (proposalQuery.error !== null && proposalQuery.data === null)
      {
        return { kind: 'error', message: proposalQuery.error }
      }
      if (proposalQuery.data === null)
      {
        return { kind: 'loading', message: 'Loading the selected proposal revision.' }
      }
      if (latestGenerationQuery.error !== null && latestGenerationQuery.data === null)
      {
        return { kind: 'error', message: latestGenerationQuery.error }
      }
      if (generationQuery.error !== null && generationQuery.data === null)
      {
        return {
          kind: 'error',
          message: generationQuery.error,
          retry: retryGenerationDetail,
        }
      }
      if (generationStartState.status === 'starting')
      {
        return { kind: 'loading', message: 'Starting exact proposal analysis.' }
      }
      if (
        generation === null &&
        (generationStartState.status === 'failed' || generationStartState.status === 'superseded')
      )
      {
        return {
          kind: 'error',
          message: generationStartState.error,
          retry: () => requestProposalGeneration('manual'),
        }
      }
      if (generation === null)
      {
        return {
          kind: 'loading',
          message: 'Checking for exact proposal analysis.',
        }
      }
      if (
        generation.state === 'failed' ||
        generation.state === 'cancelled' ||
        generation.state === 'abandoned'
      )
      {
        return {
          kind: 'error',
          message: formatProposalGenerationFailure(generation),
          retry: () => requestProposalGeneration('manual'),
        }
      }
      if (
        generation.state === 'queued' ||
        generation.state === 'preparing' ||
        generation.state === 'analyzing'
      )
      {
        return { kind: 'loading', message: generationLoadingMessage(generation) }
      }
    }
    if (generation === null || generation.state !== 'ready')
    {
      return { kind: 'loading', message: 'Preparing exact architecture impact.' }
    }
    const notices = [
      ...(generation.authority === 'estimated'
        ? ['This impact is an estimate, not an authoritative exact analysis.']
        : []),
      ...(generation.freshness === 'fresh'
        ? []
        : [`Analysis freshness: ${generation.freshness.replaceAll('-', ' ')}.`]),
    ]
    return {
      kind: 'impact',
      result: architectureImpactQuery.data,
      error: architectureImpactQuery.error,
      isPending: architectureImpactQuery.isPending,
      hasSettled: architectureImpactQuery.hasSettled,
      ...(notices.length === 0 ? {} : { notices }),
      onRetry: architectureImpactQuery.refresh,
      onOpen: openArchitectureImpact,
    }
  })()

  return (
    <ExplorerPanel
      threadRef={props.threadRef}
      narrative={narrative}
      proposal={proposal}
      proposalAvailability={proposalAvailability}
      {...(proposalFileActions ? { proposalFileActions } : {})}
      architecture={architecture}
      attempt={attempt}
      onOpenFile={props.onOpenFile}
    />
  )
}
