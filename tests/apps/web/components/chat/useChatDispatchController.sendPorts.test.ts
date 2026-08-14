// tests/apps/web/components/chat/useChatDispatchController.sendPorts.test.ts
// verifies explicit send ports and slash-command submission validation
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { ChatSendPorts } from '../../../../../apps/web/src/components/chat/useChatDispatchController'
import { resolveComposerDispatchMode } from '../../../../../apps/web/src/composer-logic'
import {
  blockUnknownComposerSlashCommand,
  shouldConfirmCompactComposerSlashCommand,
} from '../../../../../apps/web/src/components/chat/composer/composerSlashCommandValidation'
import { toastManager } from '../../../../../apps/web/src/components/ui/toast'

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
  collaborationMode: 'collaborationMode',
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

describe('resolveComposerDispatchMode', () =>
{
  it('emits Build with Orchestrate through the legacy wire enum', () =>
  {
    expect(resolveComposerDispatchMode({ baseMode: 'default', orchestrate: true }, false)).toEqual({
      collaborationMode: { baseMode: 'default', orchestrate: true },
      interactionMode: 'orchestrate',
      orchestrate: true,
    })
  })

  it('emits Plan with Orchestrate as Plan plus the modifier', () =>
  {
    expect(resolveComposerDispatchMode({ baseMode: 'plan', orchestrate: true }, false)).toEqual({
      collaborationMode: { baseMode: 'plan', orchestrate: true },
      interactionMode: 'plan',
      orchestrate: true,
    })
  })

  it('enables legacy $orchestrate without changing the base mode', () =>
  {
    expect(resolveComposerDispatchMode({ baseMode: 'plan', orchestrate: false }, true)).toEqual({
      collaborationMode: { baseMode: 'plan', orchestrate: true },
      interactionMode: 'plan',
      orchestrate: true,
    })
  })
})

describe('blockUnknownComposerSlashCommand', () =>
{
  afterEach(() =>
  {
    vi.restoreAllMocks()
  })

  it('blocks an unknown command with a toast naming it', () =>
  {
    const addToast = vi.spyOn(toastManager, 'add').mockReturnValue('unknown-command-toast')

    expect(blockUnknownComposerSlashCommand('/mystery args', [{ name: 'compact' }])).toBe(true)
    expect(addToast).toHaveBeenCalledWith({
      type: 'warning',
      title: 'Unknown slash command: /mystery',
      description: 'Choose a command from the slash menu.',
    })
  })

  it.each(['/plan explain this', '/compact now', '//x', '/ x'])(
    'does not block the known command or prose %s',
    (text) =>
    {
      const addToast = vi.spyOn(toastManager, 'add').mockReturnValue('unused-toast')

      expect(blockUnknownComposerSlashCommand(text, [{ name: 'compact' }])).toBe(false)
      expect(addToast).not.toHaveBeenCalled()
    },
  )
})

describe('shouldConfirmCompactComposerSlashCommand', () =>
{
  const providerSlashCommands = [{ name: 'compact' }]

  it('requires confirmation for a bare known compact command', () =>
  {
    expect(
      shouldConfirmCompactComposerSlashCommand({
        text: '/compact',
        providerSlashCommands,
        hasAttachmentsOrContext: false,
      }),
    ).toBe(true)
  })

  it.each([
    { text: '/review', providerSlashCommands, hasAttachmentsOrContext: false },
    { text: '/compact', providerSlashCommands: [], hasAttachmentsOrContext: false },
    { text: '/compact', providerSlashCommands, hasAttachmentsOrContext: true },
    {
      text: '/compact\ncontinue with the task',
      providerSlashCommands,
      hasAttachmentsOrContext: false,
    },
  ])('does not confirm non-executing compact text %#', (input) =>
  {
    expect(shouldConfirmCompactComposerSlashCommand(input)).toBe(false)
  })
})
