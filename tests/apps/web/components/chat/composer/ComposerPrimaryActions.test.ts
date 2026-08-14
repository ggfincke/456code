// tests/apps/web/components/chat/composer/ComposerPrimaryActions.test.ts
// verify composer primary action behavior

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('../../../../../../apps/web/src/components/SidebarStageBackdrop', () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}))

import {
  ComposerPrimaryActions,
  formatPendingPrimaryActionLabel,
  resolveCollapsedMobilePendingActions,
} from '../../../../../../apps/web/src/components/chat/composer/ComposerPrimaryActions'

function renderPendingActions(isRunning: boolean): string
{
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      showOrchestrate: true,
      orchestrateReadinessMessage: null,
      onPreviousPendingQuestion: () => undefined,
      onInterrupt: () => undefined,
      onImplementPlanWithOrchestrate: () => undefined,
      onImplementPlanInNewThread: () => undefined,
      onImplementPlanWithOrchestrateInNewThread: () => undefined,
    }),
  )
}

describe('formatPendingPrimaryActionLabel', () =>
{
  it("returns 'Submitting...' while responding", () =>
  {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe('Submitting...')
  })
})

describe('ComposerPrimaryActions pending input', () =>
{
  it('keeps Stop available while a running turn waits for input', () =>
  {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"')
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"')
  })

  it('shows a standalone Stop for collapsed mobile single-select input', () =>
  {
    const pendingAction = {
      questionIndex: 0,
      isLastQuestion: true,
      canAdvance: true,
      isResponding: false,
      isComplete: true,
    }

    expect(resolveCollapsedMobilePendingActions(pendingAction, false, true)).toEqual({
      pendingAction: null,
      visible: true,
    })
    expect(resolveCollapsedMobilePendingActions(pendingAction, false, false).visible).toBe(false)
    expect(resolveCollapsedMobilePendingActions(pendingAction, true, true)).toEqual({
      pendingAction,
      visible: true,
    })
  })
})
