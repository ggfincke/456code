// apps/web/src/components/chat/ProposedPlanCard.tsx
// renders proposed plans, exact preview generation state, and export actions
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import type {
  EnvironmentId,
  OrchestrationProposedPlanId,
  ScopedThreadRef,
} from '@t3tools/contracts'
import { EllipsisIcon } from 'lucide-react'
import { memo, useCallback, useEffect, useId, useState } from 'react'

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from '../../proposedPlan'
import { useCopyToClipboard } from '~/hooks/useCopyToClipboard'
import { cn } from '~/lib/utils'
import { useServerConfigs } from '~/state/entities'
import { projectEnvironment } from '~/state/projects'
import { useEnvironmentQuery } from '~/state/query'
import { useAtomCommand } from '~/state/use-atom-command'
import { useRightPanelStore } from '~/rightPanelStore'

import { createArchitectureImpactSurface } from '../architecture/architectureResourceIdentity'
import { selectExactPlanImpactProjection } from '../architecture/architectureImpactSelection'
import { hasArchitectureToolErrorCode } from '../architecture/architectureToolFailure'
import ChatMarkdown from '../ChatMarkdown'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../ui/menu'
import { stackedThreadToast, toastManager } from '../ui/toast'
import { formatProposalGenerationFailure } from '../cartographer/proposalGenerationFailure'
import {
  completeProposalGenerationStart,
  createProposalGenerationStartTarget,
  failProposalGenerationStart,
  recordObservedProposalGenerationFailure,
  useProposalGenerationStart,
} from './proposedPlanGenerationStart'

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planId,
  planMarkdown,
  environmentId,
  threadRef,
  cwd,
  workspaceRoot,
}: {
  planId: OrchestrationProposedPlanId
  planMarkdown: string
  environmentId: EnvironmentId
  threadRef?: ScopedThreadRef | undefined
  cwd: string | undefined
  workspaceRoot: string | undefined
})
{
  const [expanded, setExpanded] = useState(false)
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false)
  const [savePath, setSavePath] = useState('')
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false)
  const serverConfig = useServerConfigs().get(environmentId) ?? null
  const proposalPreviewAvailable = serverConfig?.environment.capabilities.proposalPreview === true
  const architectureImpactAvailable =
    serverConfig?.environment.capabilities.architectureImpact === true
  const impactProjectionQuery = useEnvironmentQuery(
    architectureImpactAvailable && threadRef
      ? projectEnvironment.getArchitectureImpactProjection({
          environmentId,
          input: {
            version: 1,
            kind: 'resolve-plan',
            threadId: threadRef.threadId,
            plan: { _tag: 'plan', planId },
          },
        })
      : null,
  )
  useEffect(() =>
  {
    if (!architectureImpactAvailable || !threadRef) return
    const intervalId = window.setInterval(impactProjectionQuery.refresh, 3_000)
    return () => window.clearInterval(intervalId)
  }, [architectureImpactAvailable, impactProjectionQuery.refresh, threadRef])
  const exactImpactProjection =
    threadRef !== undefined
      ? selectExactPlanImpactProjection(impactProjectionQuery.data, {
          threadId: threadRef.threadId,
          plan: { _tag: 'plan', planId },
        })
      : null
  const impactTargetMissing = hasArchitectureToolErrorCode(
    impactProjectionQuery.failure,
    'target-not-found',
  )
  const impactIdentityMismatch =
    impactProjectionQuery.data !== null && exactImpactProjection === null
  const impactProjectionError = impactIdentityMismatch
    ? 'The server returned Impact data for a different exact plan.'
    : impactTargetMissing
      ? null
      : impactProjectionQuery.error
  const impactProjectionLoading =
    architectureImpactAvailable && threadRef !== undefined && !impactProjectionQuery.hasSettled
  const planProposalQuery = useEnvironmentQuery(
    proposalPreviewAvailable && threadRef
      ? projectEnvironment.findProposalByPlan({
          environmentId,
          input: {
            sourceThreadId: threadRef.threadId,
            planId,
          },
        })
      : null,
  )
  const exactPlanProposal =
    threadRef &&
    planProposalQuery.data?.proposal.sourceThreadId === threadRef.threadId &&
    planProposalQuery.data.revision.planId === planId
      ? planProposalQuery.data
      : null
  const canOpenExplorer = threadRef !== undefined && proposalPreviewAvailable
  const generationStartTarget =
    exactPlanProposal === null || !threadRef
      ? null
      : createProposalGenerationStartTarget({
          environmentId,
          threadId: threadRef.threadId,
          proposalId: exactPlanProposal.proposal.proposalId,
          revision: exactPlanProposal.revision.revision,
        })
  const generationStartKey = generationStartTarget?.key ?? null
  const latestGenerationQuery = useEnvironmentQuery(
    exactPlanProposal !== null && threadRef && architectureImpactAvailable
      ? projectEnvironment.latestProposalGeneration({
          environmentId,
          input: {
            threadId: threadRef.threadId,
            proposalId: exactPlanProposal.proposal.proposalId,
            revision: exactPlanProposal.revision.revision,
          },
        })
      : null,
  )
  const startProposalGeneration = useAtomCommand(projectEnvironment.startProposalGeneration, {
    reportFailure: false,
  })
  const { state: generationStartState, claimManual } =
    useProposalGenerationStart(generationStartTarget)

  const requestProposalGeneration = useCallback((): void =>
  {
    if (exactPlanProposal === null || !threadRef || generationStartKey === null) return
    const attempt = claimManual(latestGenerationQuery.data)
    if (attempt === null) return

    void startProposalGeneration({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        proposalId: exactPlanProposal.proposal.proposalId,
        revision: exactPlanProposal.revision.revision,
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

      let errorMessage = 'Exact architecture analysis could not start.'
      if (isAtomCommandInterrupted(result))
      {
        errorMessage =
          'The request to start exact architecture analysis was superseded by a newer request.'
      }
      else
      {
        const error = squashAtomCommandFailure(result)
        if (error instanceof Error && error.message.trim().length > 0)
        {
          errorMessage = error.message
        }
      }
      if (failProposalGenerationStart(attempt, errorMessage))
      {
        latestGenerationQuery.refresh()
      }
    })
  }, [
    claimManual,
    environmentId,
    exactPlanProposal,
    generationStartKey,
    latestGenerationQuery.data,
    latestGenerationQuery.refresh,
    startProposalGeneration,
    threadRef,
  ])

  const generationSeed =
    generationStartState.status === 'started'
      ? generationStartState.generation
      : latestGenerationQuery.data
  const generationQuery = useEnvironmentQuery(
    generationSeed !== null && threadRef
      ? projectEnvironment.getProposalGeneration({
          environmentId,
          input: {
            threadId: threadRef.threadId,
            generationId: generationSeed.generationId,
          },
        })
      : null,
  )
  const generation =
    generationQuery.data !== null &&
    generationQuery.data.generationId === generationSeed?.generationId
      ? generationQuery.data
      : generationSeed
  useEffect(() =>
  {
    if (
      generation === null ||
      (generation.state !== 'queued' &&
        generation.state !== 'preparing' &&
        generation.state !== 'analyzing')
    )
    {
      return
    }
    const intervalId = window.setInterval(generationQuery.refresh, 1_500)
    return () => window.clearInterval(intervalId)
  }, [generation, generationQuery.refresh])

  const generationIsActive =
    generationStartState.status === 'starting' ||
    generation?.state === 'queued' ||
    generation?.state === 'preparing' ||
    generation?.state === 'analyzing'
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
  const generationFailure =
    generationStartState.status === 'starting' ||
    generation?.state === 'ready' ||
    generationIsActive
      ? null
      : generationStartState.status === 'failed' || generationStartState.status === 'superseded'
        ? generationStartState.error
        : generation !== null && generationIsTerminalFailure
          ? formatProposalGenerationFailure(generation)
          : null
  const previewIdentity =
    exactPlanProposal !== null
      ? generationIsActive
        ? `Analyzing revision ${exactPlanProposal.revision.revision} against workspace snapshot ${exactPlanProposal.revision.baseSnapshot.workingTreeOid}.`
        : `Preview of proposal revision ${exactPlanProposal.revision.revision} against workspace snapshot ${exactPlanProposal.revision.baseSnapshot.workingTreeOid}.`
      : planProposalQuery.error !== null
        ? 'Exact proposal preview is unavailable.'
        : planProposalQuery.isPending
          ? 'Loading the exact proposal preview.'
          : proposalPreviewAvailable && threadRef
            ? 'No immutable proposal revision is linked to this exact plan.'
            : null
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  })
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: 'plan',
    onError: (error) =>
    {
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Could not copy plan',
          description: error instanceof Error ? error.message : 'An error occurred while copying.',
        }),
      )
    },
  })
  const savePathInputId = useId()
  const title = proposedPlanTitle(planMarkdown) ?? 'Proposed plan'
  const lineCount = planMarkdown.split('\n').length
  const canCollapse = planMarkdown.length > 900 || lineCount > 20
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown)
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown)
  const saveContents = normalizePlanMarkdownForExport(planMarkdown)

  const handleDownload = () =>
  {
    downloadPlanAsTextFile(downloadFilename, saveContents)
  }

  const handleCopyPlan = () =>
  {
    copyToClipboard(saveContents)
  }

  const handleOpenExplorer = () =>
  {
    if (!threadRef || !canOpenExplorer) return
    useRightPanelStore.getState().openExplorer(threadRef, { kind: 'plan', planId })
  }

  const handleOpenImpact = () =>
  {
    if (
      !threadRef ||
      exactImpactProjection === null ||
      exactImpactProjection.projection.resultState !== 'graph'
    )
      return
    useRightPanelStore.getState().openArchitectureSurface(
      threadRef,
      createArchitectureImpactSurface({
        kind: 'exact-impact',
        descriptor: exactImpactProjection.descriptor,
      }),
    )
  }

  const openSaveDialog = () =>
  {
    if (!workspaceRoot)
    {
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: 'Workspace path is unavailable',
          description: 'This thread does not have a workspace path to save into.',
        }),
      )
      return
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename))
    setIsSaveDialogOpen(true)
  }

  const handleSaveToWorkspace = () =>
  {
    const relativePath = savePath.trim()
    if (!workspaceRoot)
    {
      return
    }
    if (!relativePath)
    {
      toastManager.add({
        type: 'warning',
        title: 'Enter a workspace path',
      })
      return
    }

    setIsSavingToWorkspace(true)
    void (async () =>
    {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath,
          contents: saveContents,
        },
      })
      setIsSavingToWorkspace(false)
      if (result._tag === 'Success')
      {
        setIsSaveDialogOpen(false)
        toastManager.add({
          type: 'success',
          title: 'Plan saved to workspace',
          description: result.value.relativePath,
        })
        return
      }
      if (!isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not save plan',
            description: error instanceof Error ? error.message : 'An error occurred while saving.',
          }),
        )
      }
    })()
  }

  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? 'Copied!' : 'Copy to clipboard'}
            </MenuItem>
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        {previewIdentity !== null ||
        canOpenExplorer ||
        generationFailure !== null ||
        exactImpactProjection !== null ||
        impactProjectionError !== null ||
        impactProjectionLoading ? (
          <div className="mb-4 grid gap-2 rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {previewIdentity !== null ? (
                <p
                  className="min-w-0 flex-1 break-words text-xs leading-relaxed text-muted-foreground"
                  data-proposal-preview-identity
                >
                  {previewIdentity}
                </p>
              ) : (
                <span />
              )}
              {canOpenExplorer ? (
                <Button
                  size="sm"
                  variant="outline"
                  data-scroll-anchor-ignore
                  onClick={handleOpenExplorer}
                >
                  Open review
                </Button>
              ) : null}
            </div>
            {generationFailure !== null ? (
              <div
                className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-2"
                role="alert"
              >
                <p className="min-w-0 flex-1 break-words text-xs leading-relaxed text-destructive">
                  {generationFailure}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  data-scroll-anchor-ignore
                  onClick={requestProposalGeneration}
                >
                  Retry analysis
                </Button>
              </div>
            ) : null}
            {architectureImpactAvailable && exactImpactProjection !== null ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-xs font-medium text-foreground">
                      {exactImpactProjection.selectedAuthority === 'verified'
                        ? 'Verified Impact'
                        : 'Planned Impact'}
                    </p>
                    <Badge size="sm" variant="outline">
                      {exactImpactProjection.projection.freshness}
                    </Badge>
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {exactImpactProjection.projection.resultState === 'no-impact'
                      ? `No architectural relationship changes · ${exactImpactProjection.projection.totals.changedFiles.total.toLocaleString()} changed files`
                      : `${exactImpactProjection.projection.totals.nodes.total.toLocaleString()} objects · ${exactImpactProjection.projection.totals.edges.total.toLocaleString()} relationships`}
                  </p>
                </div>
                {exactImpactProjection.projection.resultState === 'graph' ? (
                  <Button
                    data-scroll-anchor-ignore
                    size="sm"
                    variant="outline"
                    onClick={handleOpenImpact}
                  >
                    Open Impact Diff
                  </Button>
                ) : null}
              </div>
            ) : null}
            {architectureImpactAvailable &&
            exactImpactProjection === null &&
            (impactProjectionError !== null || impactProjectionLoading) ? (
              <div
                className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-2"
                role={impactProjectionError === null ? 'status' : 'alert'}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground">Impact Diff</p>
                  <p
                    className={cn(
                      'truncate text-[11px] text-muted-foreground',
                      impactProjectionError !== null && 'text-destructive',
                    )}
                  >
                    {impactProjectionError ?? 'Resolving Planned and Verified Impact.'}
                  </p>
                </div>
                {impactProjectionError !== null ? (
                  <Button
                    data-scroll-anchor-ignore
                    size="sm"
                    variant="ghost"
                    onClick={impactProjectionQuery.refresh}
                  >
                    Retry Impact
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className={cn('relative', canCollapse && !expanded && 'max-h-104 overflow-hidden')}>
          {canCollapse && !expanded ? (
            <ChatMarkdown
              text={collapsedPreview ?? ''}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
            />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Collapse plan' : 'Expand plan'}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) =>
        {
          if (!isSavingToWorkspace)
          {
            setIsSaveDialogOpen(open)
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to <code>{workspaceRoot ?? 'the workspace'}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workspace path</span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSavingToWorkspace}
            >
              {isSavingToWorkspace ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  )
})
