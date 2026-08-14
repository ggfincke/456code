// apps/web/src/components/architecture/DiffAnalysisPanel.tsx
// connects a resolved diff target to lazy native architecture impact analysis

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from '@t3tools/client-runtime/state/runtime'
import { shouldPollDiffAnalysisGeneration } from '@t3tools/client-runtime/state/projects'
import type {
  DiffAnalysisGeneration,
  DiffAnalysisSource,
  EnvironmentId,
  ThreadId,
} from '@t3tools/contracts'
import { CircleAlertIcon, NetworkIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { projectEnvironment } from '~/state/projects'
import { useEnvironmentQuery } from '~/state/query'
import { useAtomCommand } from '~/state/use-atom-command'

import { ArchitectureImpactSurface } from './ArchitectureImpactSurface'
import type { ArchitectureFileSource } from './architectureResourceIdentity'

const POLL_INTERVAL_MS = 1_500

export const DIFF_ANALYSIS_SERVER_RESTARTED_MESSAGE =
  'The server restarted before architecture analysis finished. Retry to start a new analysis.'

export interface DiffAnalysisPanelProps
{
  readonly environmentId: EnvironmentId | null
  readonly threadId: ThreadId | null
  readonly source: DiffAnalysisSource | null
  readonly targetKey: string | null
  readonly available: boolean
  readonly active: boolean
  readonly previewTruncated: boolean
  readonly onOpenFile: (source: ArchitectureFileSource, relativePath: string, line?: number) => void
}

function commandFailureMessage(
  result: Exclude<AtomCommandResult<unknown, unknown>, { readonly _tag: 'Success' }>,
): string
{
  const failure = squashAtomCommandFailure(result)
  return failure instanceof Error && failure.message.trim().length > 0
    ? failure.message
    : 'The environment request failed.'
}

export function isDiffAnalysisUnavailableFailure(failure: unknown): boolean
{
  return (
    typeof failure === 'object' &&
    failure !== null &&
    '_tag' in failure &&
    failure._tag === 'CartographerError' &&
    'failure' in failure &&
    failure.failure === 'diff_analysis_not_found'
  )
}

export function diffAnalysisQueryStreamError(
  error: string | null,
  failure: unknown,
  hasRequestedGeneration: boolean,
): string | null
{
  if (!hasRequestedGeneration && isDiffAnalysisUnavailableFailure(failure)) return null
  return error
}

export function analysisError(generation: DiffAnalysisGeneration): string | null
{
  if (
    generation.state !== 'failed' &&
    generation.state !== 'cancelled' &&
    generation.state !== 'abandoned'
  )
  {
    return null
  }
  if (generation.errorCode === 'server-restarted')
  {
    return DIFF_ANALYSIS_SERVER_RESTARTED_MESSAGE
  }
  return generation.errorCode
    ? `Analysis stopped (${generation.errorCode}).`
    : 'The architecture impact analysis did not complete.'
}

function EmptyAnalysisState(props: {
  readonly kind: 'idle' | 'loading' | 'error'
  readonly title: string
  readonly message: string
  readonly actionLabel?: string | undefined
  readonly onAction?: (() => void) | undefined
})
{
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10 text-center">
      <div className="max-w-sm">
        {props.kind === 'loading' ? (
          <Spinner className="mx-auto mb-3 size-5 text-muted-foreground" />
        ) : props.kind === 'error' ? (
          <CircleAlertIcon className="mx-auto mb-3 size-5 text-destructive" />
        ) : (
          <NetworkIcon className="mx-auto mb-3 size-5 text-muted-foreground" />
        )}
        <h2 className="text-sm font-medium text-foreground">{props.title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.message}</p>
        {props.actionLabel && props.onAction ? (
          <Button className="mt-4" size="sm" variant="outline" onClick={props.onAction}>
            {props.actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function DiffAnalysisPanel(props: DiffAnalysisPanelProps)
{
  const requestDiffAnalysis = useAtomCommand(projectEnvironment.requestDiffAnalysis, {
    reportFailure: false,
  })
  const [requestedGeneration, setRequestedGeneration] = useState<{
    readonly targetKey: string
    readonly generation: DiffAnalysisGeneration
  } | null>(null)
  const [commandError, setCommandError] = useState<{
    readonly targetKey: string
    readonly message: string
  } | null>(null)
  const previousActiveRef = useRef(props.active)
  const previousSourceRef = useRef(props.source)
  const target =
    props.available &&
    props.environmentId !== null &&
    props.threadId !== null &&
    props.source !== null
      ? {
          environmentId: props.environmentId,
          input: { owner: { threadId: props.threadId }, source: props.source },
        }
      : null
  const requestedGenerationSeed =
    requestedGeneration?.targetKey === props.targetKey ? requestedGeneration.generation : null
  const readTarget =
    target === null || requestedGenerationSeed === null
      ? target
      : { ...target, generation: requestedGenerationSeed }
  const generationQuery = useEnvironmentQuery(
    readTarget === null ? null : projectEnvironment.getDiffAnalysis(readTarget),
  )
  const generation =
    requestedGenerationSeed !== null &&
    generationQuery.data?.diffAnalysisId !== requestedGenerationSeed.diffAnalysisId
      ? requestedGenerationSeed
      : generationQuery.data
  const impactQuery = useEnvironmentQuery(
    props.available &&
      props.environmentId !== null &&
      props.threadId !== null &&
      generation?.state === 'ready'
      ? projectEnvironment.getArchitectureImpact({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            comparison: {
              kind: 'diff-analysis',
              diffAnalysisId: generation.diffAnalysisId,
            },
          },
        })
      : null,
  )

  useEffect(() =>
  {
    if (props.targetKey === null || generationQuery.data === null) return
    if (requestedGenerationSeed?.diffAnalysisId === generationQuery.data.diffAnalysisId) return
    setRequestedGeneration({ targetKey: props.targetKey, generation: generationQuery.data })
  }, [generationQuery.data, props.targetKey, requestedGenerationSeed?.diffAnalysisId])

  useEffect(() =>
  {
    if (!props.active || target === null || !shouldPollDiffAnalysisGeneration(generation)) return
    const intervalId = window.setInterval(generationQuery.refresh, POLL_INTERVAL_MS)
    return () => window.clearInterval(intervalId)
  }, [generation, generationQuery.refresh, props.active, target])

  useEffect(() =>
  {
    const becameActive = props.active && !previousActiveRef.current
    const sourceResolvedAgain = previousSourceRef.current !== props.source
    previousActiveRef.current = props.active
    previousSourceRef.current = props.source
    if (props.available && props.targetKey !== null && (becameActive || sourceResolvedAgain))
    {
      generationQuery.refresh()
    }
  }, [generationQuery.refresh, props.active, props.available, props.source, props.targetKey])

  const requestAnalysis = useCallback(async (): Promise<void> =>
  {
    if (target === null || props.targetKey === null) return
    setCommandError(null)
    const result = await requestDiffAnalysis(target)
    if (result._tag === 'Success')
    {
      setRequestedGeneration({ targetKey: props.targetKey, generation: result.value })
      generationQuery.refresh()
      return
    }
    if (!isAtomCommandInterrupted(result))
    {
      setCommandError({ targetKey: props.targetKey, message: commandFailureMessage(result) })
    }
  }, [generationQuery.refresh, props.targetKey, requestDiffAnalysis, target])

  if (!props.available)
  {
    return (
      <EmptyAnalysisState
        kind="error"
        message="This environment does not support native architecture impact analysis."
        title="Architecture impact unavailable"
      />
    )
  }
  if (target === null || props.targetKey === null)
  {
    return (
      <EmptyAnalysisState
        kind="idle"
        message="Architecture impact becomes available after the selected diff target resolves."
        title="Resolve the diff first"
      />
    )
  }

  const currentCommandError =
    commandError?.targetKey === props.targetKey ? commandError.message : null
  const generationFailure = generation === null ? null : analysisError(generation)
  const queryFailure = diffAnalysisQueryStreamError(
    generationQuery.error,
    generationQuery.failure,
    requestedGenerationSeed !== null,
  )
  const failure = currentCommandError ?? generationFailure ?? queryFailure
  const analyzing = generation !== null && shouldPollDiffAnalysisGeneration(generation)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.previewTruncated ? (
        <p
          className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
          role="note"
        >
          The Changes preview is truncated. Architecture analysis uses the complete exact trees.
        </p>
      ) : null}
      {generation?.state === 'ready' ? (
        <>
          {!generation.sourceCurrent ? (
            <div
              className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-warning/30 bg-warning/8 px-3 py-2 text-xs"
              role="status"
            >
              <span>
                The selected diff changed after this analysis. The exact prior result remains
                visible.
              </span>
              <Button size="xs" variant="outline" onClick={() => void requestAnalysis()}>
                Re-analyze
              </Button>
            </div>
          ) : null}
          <ArchitectureImpactSurface
            error={impactQuery.error}
            hasSettled={impactQuery.hasSettled}
            isPending={impactQuery.isPending}
            result={impactQuery.data}
            onOpenFile={props.onOpenFile}
            onRetry={impactQuery.refresh}
          />
        </>
      ) : analyzing ? (
        <EmptyAnalysisState
          kind="loading"
          message="Analyzing the complete exact trees. You can keep using the Changes tab."
          title="Analyzing architecture impact"
        />
      ) : failure !== null ? (
        <EmptyAnalysisState
          actionLabel="Retry analysis"
          kind="error"
          message={failure}
          title="Architecture analysis failed"
          onAction={() => void requestAnalysis()}
        />
      ) : generationQuery.isPending && !generationQuery.hasSettled ? (
        <EmptyAnalysisState
          kind="loading"
          message="Checking for an exact analysis of this diff."
          title="Loading architecture impact"
        />
      ) : (
        <EmptyAnalysisState
          actionLabel="Analyze"
          kind="idle"
          message="Build the exact before-and-after architecture diff only when you need it."
          title="Analyze architecture impact"
          onAction={() => void requestAnalysis()}
        />
      )}
    </div>
  )
}
