// apps/web/src/components/chat/orchestrate-plan/OrchestratePlanCard.tsx
// renders an editable orchestration plan approval card

import type {
  OrchestratePlanDecision,
  WorkersJobSummary,
  WorkersListInput,
} from '@t3tools/contracts'
import * as Option from 'effect/Option'
import { ExternalLinkIcon } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'

import { cn } from '../../../lib/utils'
import { useEnvironmentQuery } from '../../../state/query'
import { workersEnvironment } from '../../../state/workers'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import {
  createOrchestratePlanCardStateKey,
  hashOrchestratePlanText,
  isOrchestratePlanCardSuperseded,
  isOrchestratePlanRevisionStarted,
  markOrchestratePlanRevisionStarted,
  type OrchestratePlanEmissionOrder,
  readOrchestratePlanCardState,
  registerOrchestratePlanCard,
  setOrchestratePlanCardStatus,
  setOrchestratePlanMaxWorkers,
  setOrchestratePlanNote,
  setOrchestrateStageEffort,
  setOrchestrateStageSelection,
  setOrchestrateStageWorkers,
  subscribeOrchestratePlanStore,
} from './orchestratePlanStore'
import {
  type OrchestratePlan,
  type OrchestratePlanActions,
  buildOrchestrateApprovalReply,
  buildPersistedStageOverrides,
  buildPlanRows,
  groupRowsByPhase,
  initialSelection,
  latestPersistedRevision,
  persistedRevisionToPlan,
  planContentText,
} from './parse'
import {
  partitionJobsByRow,
  resolveEffortOptions,
  resolveStageModelOption,
  StageEffortPicker,
  StageModelPicker,
  StageScopeLines,
  StageStatusCell,
  TERMINAL_STATUSES,
} from './stagePickers'

export type {
  OrchestratePlan,
  OrchestratePlanActions,
  OrchestratePlanParseResult,
  OrchestratePlanResponse,
} from './parse'
export {
  buildOrchestrateApprovalReply,
  parseOrchestratePlan,
  parseOrchestratePlanResult,
} from './parse'

interface OrchestratePlanTimelineIdentity
{
  readonly revisionKey: string
  readonly order: OrchestratePlanEmissionOrder
}

function resolvePlanTimelineIdentity(
  element: HTMLElement,
  contentKey: string,
): OrchestratePlanTimelineIdentity | null
{
  const messageElement = element.closest<HTMLElement>('[data-message-id]')
  const listItem = element.closest<HTMLElement>('[data-index]')
  const messageIndexText = listItem?.dataset.index
  if (
    messageElement === null ||
    messageIndexText === undefined ||
    !/^\d+$/.test(messageIndexText)
  )
  {
    return null
  }

  const messageId = messageElement.dataset.messageId
  const messageIndex = Number(messageIndexText)
  const planIndex = [
    ...messageElement.querySelectorAll<HTMLElement>('[data-orchestrate-plan]'),
  ].indexOf(element)
  if (
    messageId === undefined ||
    messageId === '' ||
    !Number.isSafeInteger(messageIndex) ||
    planIndex < 0
  )
  {
    return null
  }

  return {
    revisionKey: `${messageId}:${planIndex}:${contentKey}`,
    order: { messageIndex, planIndex },
  }
}

export function OrchestratePlanCard({
  plan,
  actions,
}: {
  plan: OrchestratePlan
  actions: OrchestratePlanActions
})
{
  const runId = plan.runId ?? null
  // the persisted revision (when the server has one) is the source of truth;
  // the fence-parsed plan is only the fallback for hosts without persistence
  const persistedRevision = useMemo(
    () => latestPersistedRevision(actions.orchestratePlans, runId),
    [actions.orchestratePlans, runId],
  )
  const displayPlan = useMemo(
    () => (persistedRevision === null ? plan : persistedRevisionToPlan(persistedRevision)),
    [persistedRevision, plan],
  )
  const rows = useMemo(() => buildPlanRows(displayPlan.stages), [displayPlan.stages])
  const contentKey = useMemo(() => hashOrchestratePlanText(planContentText(plan)), [plan])
  const [timelineIdentity, setTimelineIdentity] = useState<OrchestratePlanTimelineIdentity | null>(
    null,
  )
  const emissionRevisionKey = timelineIdentity?.revisionKey ?? `content:${contentKey}`
  const cardRevisionKey =
    persistedRevision === null
      ? emissionRevisionKey
      : `persisted-revision:${persistedRevision.revision}`
  const draftKey = createOrchestratePlanCardStateKey(runId, cardRevisionKey)

  const registerCardElement = useCallback(
    (element: HTMLElement | null) =>
    {
      if (element === null) return
      const identity = resolvePlanTimelineIdentity(element, contentKey)
      if (identity === null) return
      setTimelineIdentity((current) =>
        current?.revisionKey === identity.revisionKey &&
        current.order.messageIndex === identity.order.messageIndex &&
        current.order.planIndex === identity.order.planIndex
          ? current
          : identity,
      )
      if (runId !== null)
      {
        registerOrchestratePlanCard(runId, identity.revisionKey, identity.order)
      }
    },
    [contentKey, runId],
  )

  const cardState = useSyncExternalStore(subscribeOrchestratePlanStore, () =>
    readOrchestratePlanCardState(draftKey),
  )
  const emissionSuperseded = useSyncExternalStore(subscribeOrchestratePlanStore, () =>
    runId === null
      ? false
      : isOrchestratePlanCardSuperseded(runId, emissionRevisionKey, timelineIdentity?.order),
  )
  const startedRevision = useSyncExternalStore(subscribeOrchestratePlanStore, () =>
    runId === null ? false : isOrchestratePlanRevisionStarted(runId, cardRevisionKey),
  )

  const [openRowKey, setOpenRowKey] = useState<string | null>(null)
  const maxWorkers = cardState.maxWorkers ?? displayPlan.maxWorkers
  const status = cardState.status
  const serverStatus = persistedRevision?.status ?? null
  const compactSuperseded = persistedRevision !== null && emissionSuperseded
  const superseded =
    compactSuperseded ||
    (persistedRevision === null ? emissionSuperseded : serverStatus === 'superseded')
  const effectiveRows = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        stage: {
          ...row.stage,
          workers: cardState.workers?.[row.rowKey] ?? row.stage.workers,
        },
      })),
    [cardState.workers, rows],
  )

  // live run status: jobs carrying this plan's runId identify the launched
  // run, which also marks the plan approved across reloads; the query is
  // stream-backed, so the card never polls
  const workersInput = useMemo<WorkersListInput>(
    () => (runId === null ? {} : { run: runId }),
    [runId],
  )
  const workersQuery = useEnvironmentQuery(
    runId === null
      ? null
      : workersEnvironment.list({ environmentId: actions.environmentId, input: workersInput }),
  )
  const workersData = workersQuery.data
  const runJobs = useMemo(() =>
  {
    if (runId === null) return [] as WorkersJobSummary[]
    return (workersData?.jobs ?? []).filter((job) => Option.getOrNull(job.run) === runId)
  }, [runId, workersData])
  const jobsByRow = useMemo(
    () => partitionJobsByRow(effectiveRows, runJobs),
    [effectiveRows, runJobs],
  )

  const selectedWorkerTotal = effectiveRows.reduce((sum, row) => sum + row.stage.workers, 0)
  const plannedTotal =
    persistedRevision === null
      ? Math.max(displayPlan.totalWorkers, selectedWorkerTotal)
      : selectedWorkerTotal
  const runStarted = runJobs.length > 0
  const revisionStarted = runStarted && (startedRevision || serverStatus === 'approved')
  const runActive = runJobs.some((job) => !TERMINAL_STATUSES.has(job.status))
  const finishedCount = runJobs.filter((job) => TERMINAL_STATUSES.has(job.status)).length
  const failedCount = runJobs.filter(
    (job) => job.status === 'failed' || job.status === 'rejected',
  ).length
  // failures with an intact patch are recoverable work, not lost work
  const salvageableCount = runJobs.filter(
    (job) =>
      (job.status === 'failed' || job.status === 'rejected') &&
      Option.getOrNull(job.hasPatch) === true,
  ).length
  const notLaunchedCount = Math.max(0, plannedTotal - runJobs.length)
  // a run with workers still to launch is not finished, however quiet the
  // broker's job list looks right now
  const runFinished = revisionStarted && notLaunchedCount === 0 && !runActive

  const disabled =
    superseded ||
    displayPlan.validationError !== null ||
    status === 'sending' ||
    status === 'sent' ||
    revisionStarted ||
    (serverStatus !== null && serverStatus !== 'pending')
  const minimumMaxWorkers = persistedRevision === null ? 1 : 0
  const maxWorkersValid = Number.isSafeInteger(maxWorkers) && maxWorkers >= minimumMaxWorkers
  const stageWorkersValid = effectiveRows.every(
    (row) => Number.isSafeInteger(row.stage.workers) && row.stage.workers >= 0,
  )
  const reply = buildOrchestrateApprovalReply(displayPlan, {
    selections: cardState.selections,
    efforts: cardState.efforts,
    maxWorkers,
  })

  const handleApprove = async () =>
  {
    setOrchestratePlanCardStatus(draftKey, 'sending')
    let didSend = false
    let failure: string | null = null
    try
    {
      didSend = await actions.onApprove(reply)
      if (!didSend) failure = 'The approval was not sent. Try again.'
    }
    catch (error)
    {
      failure = error instanceof Error ? error.message : 'The approval could not be sent.'
    }
    finally
    {
      if (didSend && runId !== null)
      {
        markOrchestratePlanRevisionStarted(runId, cardRevisionKey)
      }
      // sending always clears, so a failed send leaves the card usable
      setOrchestratePlanCardStatus(draftKey, didSend ? 'sent' : 'idle', failure)
    }
  }

  const handleRespond = async (decision: OrchestratePlanDecision) =>
  {
    if (persistedRevision === null) return
    const note = cardState.note?.trim() ?? ''
    if (decision === 'discuss' && note === '') return

    const stageOverrides = buildPersistedStageOverrides(displayPlan, {
      selections: cardState.selections,
      efforts: cardState.efforts,
      workers: cardState.workers ?? {},
      instanceEntries: actions.instanceEntries,
    })
    setOrchestratePlanCardStatus(draftKey, 'sending')
    let didSend = false
    let failure: string | null = null
    try
    {
      didSend = await actions.onRespond({
        runId: persistedRevision.runId,
        revision: persistedRevision.revision,
        decision,
        ...(stageOverrides.length === 0 ? {} : { stageOverrides }),
        ...(maxWorkers === persistedRevision.maxWorkers ? {} : { maxWorkers }),
        ...((decision === 'reject' || decision === 'discuss') && note !== '' ? { note } : {}),
      })
      if (!didSend) failure = 'The plan response was not sent. Try again.'
    }
    catch (error)
    {
      failure = error instanceof Error ? error.message : 'The plan response could not be sent.'
    }
    finally
    {
      if (didSend && decision === 'approve' && runId !== null)
      {
        markOrchestratePlanRevisionStarted(runId, cardRevisionKey)
      }
      // discuss leaves the revision pending server-side, so the card must stay
      // actionable for a later approve/reject instead of locking on "sent"
      const settledStatus = decision === 'discuss' ? 'idle' : 'sent'
      setOrchestratePlanCardStatus(draftKey, didSend ? settledStatus : 'idle', failure)
    }
  }

  // the reply only moves to the composer -> nothing was approved and the card
  // stays interactive
  const handleEditInChat = () =>
  {
    actions.onEditInChat(reply)
    setOrchestratePlanCardStatus(draftKey, 'editing')
  }

  const rowGroups = groupRowsByPhase(effectiveRows)
  const hasPhases = rowGroups.some((group) => group.phase !== null)
  const openRunAction = runId !== null && actions.onOpenRun !== undefined ? actions.onOpenRun : null

  if (compactSuperseded)
  {
    return (
      <section
        ref={registerCardElement}
        data-orchestrate-plan="true"
        data-orchestrate-plan-superseded="true"
        className="relative left-1/2 my-2 flex w-[max(100%,calc(50%+50cqw-1.5rem))] -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-foreground opacity-60 shadow-sm"
      >
        <h3 className="truncate font-semibold text-sm">{displayPlan.workflow}</h3>
        <Badge variant="secondary" size="sm">
          Superseded
        </Badge>
        <span className="truncate text-muted-foreground text-xs">
          A newer card owns this run response
        </span>
      </section>
    )
  }

  return (
    <section
      ref={registerCardElement}
      data-orchestrate-plan="true"
      data-orchestrate-plan-superseded={superseded ? 'true' : 'false'}
      // break out halfway between the prose measure (100%) and the timeline
      // container's full width (100cqw minus gutter); tracks side panels and
      // never drops below the prose measure
      className={cn(
        'relative left-1/2 my-3 w-[max(100%,calc(50%+50cqw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-sm',
        superseded && 'opacity-60',
      )}
    >
      <header className="border-b border-border bg-muted/30 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-sm">{displayPlan.workflow}</h3>
          {superseded ? (
            <Badge variant="secondary" size="sm">
              Superseded
            </Badge>
          ) : serverStatus === 'approved' ? (
            <Badge variant="success" size="sm">
              Approved
            </Badge>
          ) : serverStatus === 'rejected' ? (
            <Badge variant="error" size="sm">
              Rejected
            </Badge>
          ) : null}
        </div>
        {displayPlan.task === '' ? null : (
          <p className="mt-0.5 text-muted-foreground text-xs">{displayPlan.task}</p>
        )}
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/20 text-left text-muted-foreground">
            <tr>
              {[
                'Stage',
                'Model',
                'Effort',
                'Access',
                'Workers',
                ...(revisionStarted ? ['Status'] : []),
              ].map((label) => (
                // w-px floors each control column at its natural nowrap width so
                // the unsized trailing column absorbs all slack without inflating
                // the table past its container
                <th
                  key={label}
                  className="w-px whitespace-nowrap border-b border-border px-2 py-1.5 font-medium"
                >
                  {label}
                </th>
              ))}
              <th aria-hidden className="border-b border-border" />
            </tr>
          </thead>
          <tbody>
            {rowGroups.map((group, groupIndex) => [
              hasPhases ? (
                <tr
                  key={`phase-${group.phase ?? groupIndex}`}
                  className="border-b border-border/70"
                >
                  <td colSpan={revisionStarted ? 7 : 6} className="bg-muted/25 px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span className="h-3.5 w-1 shrink-0 rounded-full bg-blue-400/70" />
                      <span className="font-semibold text-[11px] text-foreground uppercase tracking-wider">
                        {group.phase ?? 'other'}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-medium tabular-nums text-[11px] text-muted-foreground">
                        {group.rows.reduce((sum, row) => sum + row.stage.workers, 0)} worker
                        {group.rows.reduce((sum, row) => sum + row.stage.workers, 0) === 1
                          ? ''
                          : 's'}
                      </span>
                    </span>
                  </td>
                </tr>
              ) : null,
              ...group.rows.map(({ rowKey, stage, occurrence }) =>
              {
                const selection =
                  cardState.selections[rowKey] ?? initialSelection(stage, actions.instanceEntries)
                // invalid duplicate rows remain distinguishable while the
                // parser's validation error blocks approval
                const rowLabel = occurrence === null ? stage.id : `${stage.id} #${occurrence}`
                // resolve the model this row actually displays so the effort menu
                // reads that model's reasoning tiers, defaults included
                const entryForStage =
                  actions.instanceEntries.find(
                    (entry) => entry.instanceId === selection.instanceId,
                  ) ?? null
                const stageModelOptions =
                  entryForStage === null
                    ? []
                    : (actions.modelOptionsByInstance.get(entryForStage.instanceId) ?? [])
                const resolvedModel = resolveStageModelOption(
                  entryForStage,
                  stageModelOptions,
                  selection.model,
                )
                return [
                  <tr
                    key={rowKey}
                    className={cn(
                      'align-top',
                      stage.scope === '' && 'border-b border-border/70 last:border-b-0',
                    )}
                  >
                    <td className="whitespace-nowrap px-2 py-2 font-mono">{rowLabel}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <StageModelPicker
                        rowLabel={rowLabel}
                        selection={selection}
                        actions={actions}
                        disabled={disabled}
                        open={openRowKey === rowKey}
                        onOpenChange={(next) => setOpenRowKey(next ? rowKey : null)}
                        onSelect={(instanceId, model) =>
                        {
                          const entry = actions.instanceEntries.find(
                            (candidate) => candidate.instanceId === instanceId,
                          )
                          const provider =
                            entry === undefined ? selection.provider : entry.driverKind
                          setOrchestrateStageSelection(draftKey, rowKey, {
                            provider,
                            model,
                            instanceId,
                          })
                        }}
                        onClear={() =>
                          setOrchestrateStageSelection(
                            draftKey,
                            rowKey,
                            initialSelection({ ...stage, model: '' }, actions.instanceEntries),
                          )
                        }
                        allowClear={persistedRevision === null || stage.model === ''}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <StageEffortPicker
                        rowLabel={rowLabel}
                        value={cardState.efforts[rowKey] ?? stage.effort ?? ''}
                        options={resolveEffortOptions(
                          entryForStage,
                          resolvedModel?.slug ?? selection.model,
                        )}
                        disabled={disabled}
                        onChange={(value) => setOrchestrateStageEffort(draftKey, rowKey, value)}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <span
                        className={cn(
                          'inline-flex rounded px-1.5 py-0.5 font-medium',
                          stage.mode === 'edit'
                            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                            : 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
                        )}
                      >
                        {stage.mode}
                      </span>
                    </td>
                    <td className="px-2 py-2 tabular-nums">
                      {persistedRevision === null ? (
                        stage.workers
                      ) : (
                        <input
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`Workers for stage ${rowLabel}`}
                          value={stage.workers}
                          disabled={disabled}
                          onChange={(event) =>
                            setOrchestrateStageWorkers(
                              draftKey,
                              rowKey,
                              event.currentTarget.valueAsNumber,
                            )
                          }
                          className="h-7 w-16 rounded-md border border-input bg-background px-2 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        />
                      )}
                    </td>
                    {revisionStarted ? (
                      <td className="whitespace-nowrap px-2 py-2">
                        <StageStatusCell
                          jobs={jobsByRow.get(rowKey) ?? []}
                          planned={stage.workers}
                        />
                      </td>
                    ) : null}
                    <td aria-hidden />
                  </tr>,
                  stage.scope === '' ? null : (
                    <tr
                      key={`${rowKey}-scope`}
                      className="border-b border-border/70 last:border-b-0"
                    >
                      <td colSpan={revisionStarted ? 7 : 6} className="px-2 pt-0 pb-2.5">
                        <StageScopeLines scope={stage.scope} />
                      </td>
                    </tr>
                  ),
                ]
              }),
            ])}
          </tbody>
        </table>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-2.5">
        <div className="flex items-center gap-4 text-xs">
          <span>
            Total workers: <strong>{plannedTotal}</strong>
          </span>
          <label className="flex items-center gap-2">
            Max workers
            <input
              type="number"
              min={minimumMaxWorkers}
              step={1}
              value={maxWorkers}
              disabled={disabled}
              onChange={(event) =>
                setOrchestratePlanMaxWorkers(draftKey, event.currentTarget.valueAsNumber)
              }
              className="h-7 w-16 rounded-md border border-input bg-background px-2 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {serverStatus === 'approved' ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-emerald-700 dark:text-emerald-300">
                This plan revision was approved
              </span>
              {revisionStarted ? (
                <span className="text-muted-foreground">
                  {finishedCount} of {plannedTotal} planned worker
                  {plannedTotal === 1 ? '' : 's'} finished
                </span>
              ) : null}
            </div>
          ) : serverStatus === 'rejected' ? (
            <span className="font-medium text-red-600 text-xs dark:text-red-400">
              This plan revision was rejected
            </span>
          ) : revisionStarted ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {runFinished ? null : (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 animate-pulse rounded-full bg-sky-500"
                />
              )}
              <span>
                {finishedCount} of {plannedTotal} planned worker
                {plannedTotal === 1 ? '' : 's'} finished
              </span>
              {notLaunchedCount > 0 ? (
                <span className="text-muted-foreground">{notLaunchedCount} not launched yet</span>
              ) : null}
              {failedCount > 0 ? (
                <span className="font-medium text-red-600 dark:text-red-400">
                  {failedCount} failed
                  {salvageableCount > 0 ? (
                    <span className="font-normal text-amber-600 dark:text-amber-400">
                      {' '}
                      · {salvageableCount} salvageable
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
          ) : superseded ? (
            <span className="text-muted-foreground text-xs">
              Superseded by a newer plan for this run
            </span>
          ) : persistedRevision !== null ? (
            <>
              {displayPlan.validationError === null && cardState.error === null ? null : (
                <span role="alert" className="text-red-600 text-xs dark:text-red-400">
                  {displayPlan.validationError ?? cardState.error}
                </span>
              )}
              {status === 'editing' ? (
                <span className="text-muted-foreground text-xs">
                  Fallback reply appended to the composer
                </span>
              ) : status === 'sending' ? (
                <span className="text-muted-foreground text-xs">Sending response…</span>
              ) : status === 'sent' ? (
                <span className="text-muted-foreground text-xs">Response sent</span>
              ) : null}
              <input
                type="text"
                value={cardState.note ?? ''}
                disabled={disabled}
                aria-label="Plan response note"
                placeholder="Note (required to discuss)"
                onChange={(event) => setOrchestratePlanNote(draftKey, event.currentTarget.value)}
                className="h-7 min-w-44 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
              <Button
                type="button"
                variant="link"
                size="xs"
                disabled={disabled || !maxWorkersValid || !stageWorkersValid}
                onClick={handleEditInChat}
              >
                Edit in chat
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={
                  disabled ||
                  !maxWorkersValid ||
                  !stageWorkersValid ||
                  (cardState.note?.trim() ?? '') === ''
                }
                onClick={() => void handleRespond('discuss')}
              >
                Discuss
              </Button>
              <Button
                type="button"
                variant="destructive-outline"
                size="sm"
                disabled={disabled || !maxWorkersValid || !stageWorkersValid}
                onClick={() => void handleRespond('reject')}
              >
                Reject
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={disabled || !maxWorkersValid || !stageWorkersValid}
                onClick={() => void handleRespond('approve')}
              >
                Approve
              </Button>
            </>
          ) : (
            <>
              {displayPlan.validationError === null && cardState.error === null ? null : (
                <span role="alert" className="text-red-600 text-xs dark:text-red-400">
                  {displayPlan.validationError ?? cardState.error}
                </span>
              )}
              {status === 'editing' ? (
                <span className="text-muted-foreground text-xs">
                  Reply moved to the composer — edit and send it there
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || !maxWorkersValid}
                onClick={handleEditInChat}
              >
                Edit in chat
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={disabled || !maxWorkersValid}
                onClick={() => void handleApprove()}
              >
                {status === 'sending'
                  ? 'Approving…'
                  : status === 'sent'
                    ? 'Sent'
                    : cardState.error === null
                      ? 'Approve'
                      : 'Retry approval'}
              </Button>
            </>
          )}
          {openRunAction === null || runId === null ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => openRunAction(runId)}
            >
              <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
              Open run
            </Button>
          )}
        </div>
      </footer>
    </section>
  )
}
