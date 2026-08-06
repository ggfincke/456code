// tests/packages/shared/agentAwareness.test.ts
// verifies projection of thread state into user-facing agent activity

import { describe, expect, it } from '@effect/vitest'

import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import { ApprovalRequestId, ProviderInstanceId } from '@t3tools/contracts'

import { projectThreadAwareness } from '../../../packages/shared/src/agentAwareness.ts'

const NOW = '2026-05-22T12:00:00.000Z'

const project = {
  title: 't3code',
} satisfies Pick<OrchestrationProjectShell, 'title'>

function thread(
  overrides: Partial<OrchestrationThreadShell> = {},
): Pick<
  OrchestrationThreadShell,
  | 'id'
  | 'title'
  | 'modelSelection'
  | 'session'
  | 'latestTurn'
  | 'updatedAt'
  | 'approvalOutcomes'
  | 'hasPendingApprovals'
  | 'hasPendingUserInput'
>
{
  return {
    id: 'thread-1' as ThreadId,
    title: 'Fix failing CI',
    modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
    session: null,
    latestTurn: null,
    updatedAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  }
}

describe('projectThreadAwareness', () =>
{
  it('returns null for idle threads without an active awareness state', () =>
  {
    expect(
      projectThreadAwareness({
        environmentId: 'env-1' as EnvironmentId,
        project,
        thread: thread(),
      }),
    ).toBeNull()
  })

  it('prioritizes approval requests over running state', () =>
  {
    const state = projectThreadAwareness({
      environmentId: 'env-1' as EnvironmentId,
      project,
      thread: thread({
        hasPendingApprovals: true,
        session: {
          threadId: 'thread-1' as ThreadId,
          status: 'running',
          providerName: 'Codex',
          runtimeMode: 'full-access',
          activeTurnId: 'turn-1' as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    })

    expect(state?.phase).toBe('waiting_for_approval')
    expect(state?.headline).toBe('Approval needed')
  })

  it('projects running provider sessions', () =>
  {
    const state = projectThreadAwareness({
      environmentId: 'env-1' as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: 'thread-1' as ThreadId,
          status: 'running',
          providerName: 'Codex',
          runtimeMode: 'full-access',
          activeTurnId: 'turn-1' as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    })

    expect(state).toMatchObject({
      phase: 'running',
      headline: 'Agent is working',
      detail: 'Codex is active.',
      modelTitle: 'gpt-5.4',
      deepLink: '/threads/env-1/thread-1',
    })
  })

  it('keeps responding outcomes in an in-flight approval state when the legacy flag is clear', () =>
  {
    const state = projectThreadAwareness({
      environmentId: 'env-1' as EnvironmentId,
      project,
      thread: thread({
        approvalOutcomes: [
          {
            requestId: ApprovalRequestId.make('approval-responding'),
            status: 'responding',
            requestedDecision: 'accept',
            decision: null,
            updatedAt: NOW,
          },
        ],
        latestTurn: {
          turnId: 'turn-1' as TurnId,
          state: 'completed',
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      }),
    })

    expect(state).toMatchObject({
      phase: 'waiting_for_approval',
      headline: 'Approval response pending',
      detail: 'Waiting for the provider to confirm the approval response.',
    })
  })

  it('projects unknown outcomes as explicit manual-recovery approval state', () =>
  {
    const state = projectThreadAwareness({
      environmentId: 'env-1' as EnvironmentId,
      project,
      thread: thread({
        approvalOutcomes: [
          {
            requestId: ApprovalRequestId.make('approval-unknown'),
            status: 'unknown',
            decision: null,
            detail: 'Provider delivery could not be confirmed.',
            updatedAt: NOW,
          },
        ],
        session: {
          threadId: 'thread-1' as ThreadId,
          status: 'ready',
          providerName: 'Codex',
          runtimeMode: 'full-access',
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    })

    expect(state).toMatchObject({
      phase: 'waiting_for_approval',
      headline: 'Approval status unknown',
    })
    expect(state?.detail).toContain('Provider delivery could not be confirmed.')
    expect(state?.detail).toContain('Refresh status or restart the turn')
    expect(state?.phase).not.toBe('completed')
  })

  it('projects completed turns as completed even when teardown settled them as interrupted', () =>
  {
    const finishedTurn = {
      turnId: 'turn-1' as TurnId,
      state: 'interrupted' as const,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    }
    const state = projectThreadAwareness({
      environmentId: 'env-1' as EnvironmentId,
      project,
      thread: thread({ latestTurn: finishedTurn }),
    })

    // session teardown settles still-running turns by session status, and
    // that write can race turn.completed; the completion timestamp is the
    // durable signal. Without this the thread resolves to null persistently
    // and gets tombstoned off the lock-screen card instead of showing Done.
    expect(state?.phase).toBe('completed')

    const trulyInterrupted = projectThreadAwareness({
      environmentId: 'env-1' as EnvironmentId,
      project,
      thread: thread({ latestTurn: { ...finishedTurn, completedAt: null } }),
    })
    expect(trulyInterrupted).toBeNull()
  })

  it('projects ready sessions with no materialized turn as completed', () =>
  {
    // partial or legacy shell snapshots can lack the latest turn row
    // the ready session remains a sufficient completion signal
    const state = projectThreadAwareness({
      environmentId: 'env-1' as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: 'thread-1' as ThreadId,
          status: 'ready',
          providerName: 'Codex',
          runtimeMode: 'full-access',
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    })

    expect(state?.phase).toBe('completed')
  })

  it('projects failures with the session error detail', () =>
  {
    const state = projectThreadAwareness({
      environmentId: 'env-1' as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: 'thread-1' as ThreadId,
          status: 'error',
          providerName: 'Codex',
          runtimeMode: 'full-access',
          activeTurnId: null,
          lastError: 'Provider process exited.',
          updatedAt: NOW,
        },
      }),
    })

    expect(state).toMatchObject({
      phase: 'failed',
      headline: 'Agent failed',
      detail: 'Provider process exited.',
    })
  })
})
