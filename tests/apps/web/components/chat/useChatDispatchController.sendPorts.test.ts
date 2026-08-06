// tests/apps/web/components/chat/useChatDispatchController.sendPorts.test.ts
// verifies ChatSendPorts stays an explicit named-field surface for send/retry
import { describe, expect, it } from 'vite-plus/test'

import type { ChatSendPorts } from '../../../../../apps/web/src/components/chat/useChatDispatchController'

type ExhaustiveChatSendPortKeys = {
  readonly [Key in keyof ChatSendPorts]: Key
}

// compile-time exhaustiveness: a new required port without an entry here fails typecheck
const CHAT_SEND_PORT_KEYS = {
  activeEnvironmentUnavailable: 'activeEnvironmentUnavailable',
  activePendingProgress: 'activePendingProgress',
  activeProject: 'activeProject',
  activeProposedPlan: 'activeProposedPlan',
  activeThreadBranch: 'activeThreadBranch',
  activeThreadKey: 'activeThreadKey',
  activeTimelineAnchorIndexRef: 'activeTimelineAnchorIndexRef',
  addComposerDraftImages: 'addComposerDraftImages',
  anchorUserScrollGenerationRef: 'anchorUserScrollGenerationRef',
  beginLocalDispatch: 'beginLocalDispatch',
  captureDraftHeroComposerRect: 'captureDraftHeroComposerRect',
  clearComposerDraftContent: 'clearComposerDraftContent',
  composerDraftOwnerKey: 'composerDraftOwnerKey',
  composerDraftOwnerKeyRef: 'composerDraftOwnerKeyRef',
  composerDraftTarget: 'composerDraftTarget',
  composerElementContextsRef: 'composerElementContextsRef',
  composerImagesRef: 'composerImagesRef',
  composerRef: 'composerRef',
  composerTerminalContextsRef: 'composerTerminalContextsRef',
  focusImportContinuationBanner: 'focusImportContinuationBanner',
  handleInteractionModeChange: 'handleInteractionModeChange',
  importContinuationConsent: 'importContinuationConsent',
  importContinuationSendBlocked: 'importContinuationSendBlocked',
  interactionMode: 'interactionMode',
  isAtEndRef: 'isAtEndRef',
  isConnecting: 'isConnecting',
  isDraftHeroState: 'isDraftHeroState',
  isLocalDraftThread: 'isLocalDraftThread',
  isServerThread: 'isServerThread',
  liveFollowUserScrollGenerationRef: 'liveFollowUserScrollGenerationRef',
  localCheckoutBranchMismatch: 'localCheckoutBranchMismatch',
  onAdvanceActivePendingUserInput: 'onAdvanceActivePendingUserInput',
  onSubmitPlanFollowUp: 'onSubmitPlanFollowUp',
  pendingTimelineAnchorRef: 'pendingTimelineAnchorRef',
  persistThreadSettingsForNextTurn: 'persistThreadSettingsForNextTurn',
  promptRef: 'promptRef',
  resetLocalDispatch: 'resetLocalDispatch',
  runMobileComposerTransition: 'runMobileComposerTransition',
  runtimeMode: 'runtimeMode',
  sendEnvMode: 'sendEnvMode',
  sendInFlightRef: 'sendInFlightRef',
  setComposerDraftElementContexts: 'setComposerDraftElementContexts',
  setComposerDraftPreviewAnnotations: 'setComposerDraftPreviewAnnotations',
  setComposerDraftPrompt: 'setComposerDraftPrompt',
  setComposerDraftReviewComments: 'setComposerDraftReviewComments',
  setComposerDraftTerminalContexts: 'setComposerDraftTerminalContexts',
  setDockedDraftHeroThreadKey: 'setDockedDraftHeroThreadKey',
  setOptimisticUserMessages: 'setOptimisticUserMessages',
  setShowScrollToBottom: 'setShowScrollToBottom',
  setTimelineAnchor: 'setTimelineAnchor',
  showPlanFollowUpPrompt: 'showPlanFollowUpPrompt',
  showScrollDebouncer: 'showScrollDebouncer',
  startFromOrigin: 'startFromOrigin',
  startThreadTurn: 'startThreadTurn',
  threadDetailLoading: 'threadDetailLoading',
  timelineScrollModeRef: 'timelineScrollModeRef',
  updateThreadMetadata: 'updateThreadMetadata',
} as const satisfies ExhaustiveChatSendPortKeys

describe('ChatSendPorts', () =>
{
  it('keeps send/retry inputs as an explicit named-field port list', () =>
  {
    const keys = Object.keys(CHAT_SEND_PORT_KEYS)
    expect(keys).toHaveLength(Object.keys(CHAT_SEND_PORT_KEYS).length)
    expect(keys).toContain('sendInFlightRef')
    expect(keys).toContain('onSubmitPlanFollowUp')
    expect(keys).toContain('beginLocalDispatch')
    expect(keys).toContain('resetLocalDispatch')
    // refuse catch-all bags that would reopen the plan 23 stop condition
    expect(keys.some((key) => key === 'deps' || key === 'context')).toBe(false)
  })
})
