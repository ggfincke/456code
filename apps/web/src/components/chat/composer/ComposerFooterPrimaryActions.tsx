// apps/web/src/components/chat/composer/ComposerFooterPrimaryActions.tsx
// wrap usage meter and primary composer actions in the footer

import type { ServerProvider } from '@t3tools/contracts'
import { memo } from 'react'
import { ComposerPrimaryActions } from './ComposerPrimaryActions'
import { ComposerUsageMeter } from './ComposerUsageMeter'
import type { ThreadContextWindowSelection } from './composerContextWindow'

export const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean
  activeContextWindow: ThreadContextWindowSelection
  accountUsage: ServerProvider['accountUsage']
  usageProviderDisplayName: string | null
  canCompactNow: boolean
  isPreparingWorktree: boolean
  pendingAction: {
    questionIndex: number
    isLastQuestion: boolean
    canAdvance: boolean
    isResponding: boolean
    isComplete: boolean
  } | null
  isRunning: boolean
  showPlanFollowUpPrompt: boolean
  promptHasText: boolean
  isSendBusy: boolean
  sendDisabledReason: string | null
  isConnecting: boolean
  isEnvironmentUnavailable: boolean
  hasSendableContent: boolean
  orchestrateReadinessMessage: string | null
  preserveComposerFocusOnPointerDown?: boolean
  onPreviousPendingQuestion: () => void
  onInterrupt: () => void
  onImplementPlanWithOrchestrate: () => void
  onImplementPlanInNewThread: () => void
  onImplementPlanWithOrchestrateInNewThread: () => void
  onCompactNow: () => void
})
{
  return (
    <>
      <ComposerUsageMeter
        contextUsage={props.activeContextWindow}
        accountUsage={props.accountUsage}
        providerDisplayName={props.usageProviderDisplayName}
        canCompactNow={props.canCompactNow}
        onCompactNow={props.onCompactNow}
      />
      {props.isPreparingWorktree ? (
        <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        sendDisabledReason={props.sendDisabledReason}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        orchestrateReadinessMessage={props.orchestrateReadinessMessage}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onImplementPlanWithOrchestrate={props.onImplementPlanWithOrchestrate}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
        onImplementPlanWithOrchestrateInNewThread={props.onImplementPlanWithOrchestrateInNewThread}
      />
    </>
  )
})
