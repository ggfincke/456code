// tests/packages/client-runtime/state/providerSwitchMerge.test.ts
// verifies the shell-authoritative provider switch merge for thread detail

import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProviderSwitch,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from '../../../../packages/client-runtime/src/state/models.ts'
import { mergeEnvironmentThread } from '../../../../packages/client-runtime/src/state/threadDetail.ts'

const environmentId = EnvironmentId.make('environment-local')
const projectId = ProjectId.make('project-1')
const threadId = ThreadId.make('thread-1')
const now = '2026-08-02T00:00:00.000Z'

const activeSwitch: OrchestrationProviderSwitch = {
  phase: 'compacting',
  targetInstanceId: ProviderInstanceId.make('claude'),
  targetModel: 'opus-5',
  requestedAt: now,
}

function makeDetail(overrides: Partial<EnvironmentThread> = {}): EnvironmentThread
{
  return {
    environmentId,
    id: threadId,
    projectId,
    title: 'Thread',
    modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    latestTurn: null,
    providerSwitch: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    origin: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  }
}

function makeShell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell
{
  return {
    environmentId,
    id: threadId,
    projectId,
    title: 'Thread',
    modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    latestTurn: null,
    providerSwitch: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    origin: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }
}

describe('mergeEnvironmentThread provider switch', () =>
{
  it('takes an active switch from the shell when the cached detail has none', () =>
  {
    const merged = mergeEnvironmentThread(makeDetail(), makeShell({ providerSwitch: activeSwitch }))

    expect(merged?.providerSwitch).toEqual(activeSwitch)
  })

  it('clears a stale detail switch once the shell reports the switch finished', () =>
  {
    const merged = mergeEnvironmentThread(
      makeDetail({ providerSwitch: activeSwitch }),
      makeShell({
        providerSwitch: null,
        modelSelection: { instanceId: ProviderInstanceId.make('claude'), model: 'opus-5' },
      }),
    )

    expect(merged?.providerSwitch).toBeNull()
    // the switch travels with the selection it belongs to
    expect(merged?.modelSelection.instanceId).toBe('claude')
  })

  it('keeps the switch phase in step with the newer shell', () =>
  {
    const merged = mergeEnvironmentThread(
      makeDetail({ providerSwitch: activeSwitch }),
      makeShell({ providerSwitch: { ...activeSwitch, phase: 'finalizing' } }),
    )

    expect(merged?.providerSwitch?.phase).toBe('finalizing')
  })

  it('leaves the detail untouched without a matching shell', () =>
  {
    const detail = makeDetail({ providerSwitch: activeSwitch })

    expect(mergeEnvironmentThread(detail, null)?.providerSwitch).toEqual(activeSwitch)
    expect(
      mergeEnvironmentThread(detail, makeShell({ id: ThreadId.make('thread-2') }))?.providerSwitch,
    ).toEqual(activeSwitch)
  })
})
