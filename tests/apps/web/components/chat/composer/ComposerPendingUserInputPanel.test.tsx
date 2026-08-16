// tests/apps/web/components/chat/composer/ComposerPendingUserInputPanel.test.tsx
// verify pending question disclosure behavior across question changes

// @vitest-environment happy-dom

import { ApprovalRequestId } from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vite-plus/test'

import { ComposerPendingUserInputPanel } from '../../../../../../apps/web/src/components/chat/composer/ComposerPendingUserInputPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const prompt = {
  requestId: ApprovalRequestId.make('request-1'),
  createdAt: '2026-08-15T00:00:00.000Z',
  questions: [
    {
      id: 'question-1',
      header: 'Approach',
      question: 'Which approach should the migration take?',
      options: [
        { label: 'Incremental', description: 'Move one module at a time' },
        { label: 'Big bang', description: 'Move everything in one release' },
      ],
      multiSelect: false,
    },
    {
      id: 'question-2',
      header: 'Verification',
      question: 'How should the migration be verified?',
      options: [
        { label: 'Focused tests', description: 'Run only affected suites' },
        { label: 'Full suite', description: 'Run every package suite' },
      ],
      multiSelect: false,
    },
  ],
}

describe('ComposerPendingUserInputPanel', () =>
{
  it('suppresses collapsed shortcuts and reopens when the active question advances', async () =>
  {
    const onToggleOption = vi.fn()
    const onAdvance = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const renderQuestion = async (questionIndex: number) =>
    {
      await act(async () =>
      {
        root.render(
          <ComposerPendingUserInputPanel
            pendingUserInputs={[prompt]}
            respondingRequestIds={[]}
            answers={{}}
            questionIndex={questionIndex}
            onToggleOption={onToggleOption}
            onAdvance={onAdvance}
          />,
        )
      })
    }

    try
    {
      await renderQuestion(0)
      const expandedToggle = container.querySelector<HTMLButtonElement>(
        '[data-pending-user-input-toggle="expanded"]',
      )
      expect(expandedToggle?.getAttribute('aria-expanded')).toBe('true')

      await act(async () =>
      {
        expandedToggle?.click()
      })

      const collapsedToggle = container.querySelector<HTMLButtonElement>(
        '[data-pending-user-input-toggle="collapsed"]',
      )
      expect(collapsedToggle?.getAttribute('aria-expanded')).toBe('false')
      expect(collapsedToggle?.textContent).toContain('Which approach should the migration take?')

      await act(async () =>
      {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', cancelable: true }))
      })
      expect(onToggleOption).not.toHaveBeenCalled()
      expect(onAdvance).not.toHaveBeenCalled()

      await renderQuestion(1)
      const reopenedToggle = container.querySelector<HTMLButtonElement>(
        '[data-pending-user-input-toggle="expanded"]',
      )
      expect(reopenedToggle?.getAttribute('aria-expanded')).toBe('true')
      expect(container.textContent).toContain('How should the migration be verified?')
      expect(container.textContent).toContain('Focused tests')
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
