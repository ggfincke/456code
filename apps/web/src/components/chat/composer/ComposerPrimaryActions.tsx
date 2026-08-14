// apps/web/src/components/chat/composer/ComposerPrimaryActions.tsx
// render composer send, interrupt, and plan implementation actions

import { memo, type PointerEventHandler } from 'react'
import { ChevronDownIcon, ChevronLeftIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '~/lib/utils'
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from '../../SidebarStageBackdrop'
import { Button } from '../../ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../../ui/menu'
import { Spinner } from '../../ui/spinner'

export interface PendingActionState
{
  questionIndex: number
  isLastQuestion: boolean
  canAdvance: boolean
  isResponding: boolean
  isComplete: boolean
}

export function resolveCollapsedMobilePendingActions(
  pendingAction: PendingActionState | null,
  isMultiSelect: boolean,
  isRunning: boolean,
): { readonly pendingAction: PendingActionState | null; readonly visible: boolean }
{
  return {
    pendingAction: isMultiSelect ? pendingAction : null,
    visible: isMultiSelect || isRunning,
  }
}

interface ComposerPrimaryActionsProps
{
  compact: boolean
  pendingAction: PendingActionState | null
  isRunning: boolean
  showPlanFollowUpPrompt: boolean
  promptHasText: boolean
  isSendBusy: boolean
  sendDisabledReason: string | null
  isConnecting: boolean
  isEnvironmentUnavailable: boolean
  isPreparingWorktree: boolean
  hasSendableContent: boolean
  orchestrateReadinessMessage: string | null
  preserveComposerFocusOnPointerDown?: boolean
  onPreviousPendingQuestion: () => void
  onInterrupt: () => void
  onImplementPlanWithOrchestrate: () => void
  onImplementPlanInNewThread: () => void
  onImplementPlanWithOrchestrateInNewThread: () => void
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean
  isLastQuestion: boolean
  isResponding: boolean
  questionIndex: number
}) =>
{
  if (input.isResponding)
  {
    return 'Submitting...'
  }
  if (input.compact)
  {
    return input.isLastQuestion ? 'Submit' : 'Next'
  }
  if (!input.isLastQuestion)
  {
    return 'Next question'
  }
  return input.questionIndex > 0 ? 'Submit answers' : 'Submit answer'
}

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) =>
{
  event.preventDefault()
}

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  sendDisabledReason,
  isConnecting,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  orchestrateReadinessMessage,
  preserveComposerFocusOnPointerDown = false,
  onPreviousPendingQuestion,
  onInterrupt,
  onImplementPlanWithOrchestrate,
  onImplementPlanInNewThread,
  onImplementPlanWithOrchestrateInNewThread,
}: ComposerPrimaryActionsProps)
{
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined
  const isSendDisabled = sendDisabledReason !== null
  const stageBackdropVariant = useSidebarStageBackdropVariant()
  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <button
      type="button"
      className={cn(
        'flex cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none',
        insidePendingAction ? 'size-8 sm:size-7' : 'size-8 sm:h-8 sm:w-8',
      )}
      {...pointerFocusProps}
      onClick={onInterrupt}
      aria-label="Stop generation"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  )

  if (pendingAction)
  {
    return (
      <div className={cn('flex items-center justify-end', compact ? 'gap-1.5' : 'gap-2')}>
        {isRunning ? renderStopGenerationButton(true) : null}
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn('rounded-full', compact ? 'px-3' : 'px-4')}
          {...pointerFocusProps}
          disabled={
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </Button>
      </div>
    )
  }

  if (isRunning)
  {
    return renderStopGenerationButton(false)
  }

  if (showPlanFollowUpPrompt)
  {
    if (promptHasText)
    {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn('rounded-full', compact ? 'h-9 px-3 sm:h-8' : 'h-9 px-4 sm:h-8')}
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? 'Sending...' : 'Refine'}
        </Button>
      )
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? 'Sending...' : 'Implement'}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                aria-label="Implementation actions"
                {...pointerFocusProps}
                disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" className="max-w-80">
            <MenuItem
              className="items-start"
              disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
              title={orchestrateReadinessMessage ?? undefined}
              onClick={() => void onImplementPlanWithOrchestrate()}
            >
              <span className="grid min-w-0 gap-0.5">
                <span>Implement with Orchestrate</span>
                {orchestrateReadinessMessage === null ? null : (
                  <span className="flex items-start gap-1 text-amber-700 text-xs whitespace-normal dark:text-amber-400">
                    <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                    <span>{orchestrateReadinessMessage}</span>
                  </span>
                )}
              </span>
            </MenuItem>
            <MenuItem
              disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new thread
            </MenuItem>
            <MenuItem
              className="items-start"
              disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
              title={orchestrateReadinessMessage ?? undefined}
              onClick={() => void onImplementPlanWithOrchestrateInNewThread()}
            >
              <span className="grid min-w-0 gap-0.5">
                <span>Implement with Orchestrate in a new thread</span>
                {orchestrateReadinessMessage === null ? null : (
                  <span className="flex items-start gap-1 text-amber-700 text-xs whitespace-normal dark:text-amber-400">
                    <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                    <span>{orchestrateReadinessMessage}</span>
                  </span>
                )}
              </span>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    )
  }

  return (
    <button
      type="submit"
      className={cn(
        'relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full text-primary-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8',
        stageBackdropVariant
          ? 'bg-transparent enabled:shadow-black/24 enabled:hover:brightness-110'
          : 'bg-primary/90 enabled:shadow-primary/24 hover:bg-primary',
      )}
      {...pointerFocusProps}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isConnecting ||
        isEnvironmentUnavailable ||
        !hasSendableContent
      }
      aria-label={
        isEnvironmentUnavailable
          ? 'Environment disconnected'
          : sendDisabledReason
            ? sendDisabledReason
            : isConnecting
              ? 'Connecting'
              : isPreparingWorktree
                ? 'Preparing worktree'
                : isSendBusy
                  ? 'Sending'
                  : 'Send message'
      }
    >
      {stageBackdropVariant ? (
        <span className="absolute inset-0 -z-10" aria-hidden="true">
          <StageBackdropButtonArt variant={stageBackdropVariant} />
        </span>
      ) : null}
      {isConnecting || isSendBusy ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  )
})
