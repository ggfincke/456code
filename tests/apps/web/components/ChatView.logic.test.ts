// tests/apps/web/components/ChatView.logic.test.ts
// verifies chat view state, imported continuation gates, and dispatch helpers
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import type { Thread, ThreadShell } from '../../../../apps/web/src/types'
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  deriveLockedProvider,
  dismissBranchMismatchForSession,
  getStartedThreadModelChangeBlockReason,
  getStartedThreadProviderSwitchBlockReason,
  handleImportContinuationSendBlock,
  hasServerAcknowledgedLocalDispatch,
  importContinuationConsentToken,
  isImportContinuationSendBlocked,
  isBranchMismatchDismissedForSession,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  resolveImportContinuationBannerCopy,
  resolveImportContinuationGate,
  resolveImportContinuationProviderSnapshot,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  startNewThreadForProject,
  shouldShowBranchMismatchBanner,
  shouldReconcileComposerDraftModelSelection,
  shouldWriteThreadErrorToCurrentServerThread,
} from '../../../../apps/web/src/components/ChatView.logic'

const environmentId = EnvironmentId.make('environment-local')
const projectId = ProjectId.make('project-1')
const threadId = ThreadId.make('thread-1')
const now = '2026-03-29T00:00:00.000Z'

describe('shouldReconcileComposerDraftModelSelection', () =>
{
  const threadKey = 'environment-local:thread-1'
  const projectedSelection = {
    instanceId: ProviderInstanceId.make('codex_work'),
    model: 'gpt-5.4',
  }

  it('lets a started thread projection replace a stale draft on first observation', () =>
  {
    expect(
      shouldReconcileComposerDraftModelSelection({
        composerSelection: {
          instanceId: ProviderInstanceId.make('codex_personal'),
          model: 'gpt-5.4',
        },
        hasStarted: true,
        previousProjection: null,
        projectedSelection,
        threadKey,
      }),
    ).toBe(true)
    expect(
      shouldReconcileComposerDraftModelSelection({
        composerSelection: {
          instanceId: ProviderInstanceId.make('codex_personal'),
          model: 'gpt-5.4',
        },
        hasStarted: false,
        previousProjection: null,
        projectedSelection,
        threadKey,
      }),
    ).toBe(false)
  })

  it('reconciles a stale model or option set on the same instance', () =>
  {
    expect(
      shouldReconcileComposerDraftModelSelection({
        composerSelection: { instanceId: projectedSelection.instanceId, model: 'gpt-5.3' },
        hasStarted: true,
        previousProjection: null,
        projectedSelection,
        threadKey,
      }),
    ).toBe(true)
    expect(
      shouldReconcileComposerDraftModelSelection({
        composerSelection: {
          ...projectedSelection,
          options: [{ id: 'effort', value: 'high' }],
        },
        hasStarted: true,
        previousProjection: null,
        projectedSelection: { ...projectedSelection, options: [{ id: 'effort', value: 'max' }] },
        threadKey,
      }),
    ).toBe(true)
  })

  // the projection is the complete selection, so options it drops are a real
  // change the composer has to adopt — not a no-op the draft can keep
  it('detects a projection that removes the options the draft still holds', () =>
  {
    expect(
      shouldReconcileComposerDraftModelSelection({
        composerSelection: { ...projectedSelection, options: [{ id: 'effort', value: 'high' }] },
        hasStarted: true,
        previousProjection: null,
        projectedSelection,
        threadKey,
      }),
    ).toBe(true)
    expect(
      shouldReconcileComposerDraftModelSelection({
        composerSelection: projectedSelection,
        hasStarted: true,
        previousProjection: {
          threadKey,
          selection: { ...projectedSelection, options: [{ id: 'effort', value: 'high' }] },
        },
        projectedSelection,
        threadKey,
      }),
    ).toBe(true)
  })

  it('observes a live transition that only changes the model on the same instance', () =>
  {
    expect(
      shouldReconcileComposerDraftModelSelection({
        composerSelection: projectedSelection,
        hasStarted: true,
        previousProjection: {
          threadKey,
          selection: { ...projectedSelection, model: 'gpt-5.3' },
        },
        projectedSelection,
        threadKey,
      }),
    ).toBe(true)
  })

  it('leaves an already-matching draft alone, including option order', () =>
  {
    // option selections are order-independent on the wire
    const projectedWithOptions = {
      ...projectedSelection,
      options: [
        { id: 'fastMode', value: true },
        { id: 'effort', value: 'max' },
      ],
    }

    expect(
      shouldReconcileComposerDraftModelSelection({
        composerSelection: {
          ...projectedSelection,
          options: [
            { id: 'effort', value: 'max' },
            { id: 'fastMode', value: true },
          ],
        },
        hasStarted: true,
        previousProjection: { threadKey, selection: projectedWithOptions },
        projectedSelection: projectedWithOptions,
        threadKey,
      }),
    ).toBe(false)
  })
})

function makeThread(overrides: Partial<Thread> = {}): Thread
{
  return {
    id: threadId,
    environmentId,
    projectId,
    title: 'Thread',
    modelSelection: {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5.4',
    },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    origin: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    providerSwitch: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  }
}

const completedTurn = {
  turnId: TurnId.make('turn-1'),
  state: 'completed' as const,
  requestedAt: now,
  startedAt: '2026-03-29T00:00:01.000Z',
  completedAt: '2026-03-29T00:00:10.000Z',
  assistantMessageId: null,
}

const readySession = {
  threadId,
  status: 'ready' as const,
  providerName: 'codex',
  providerInstanceId: ProviderInstanceId.make('codex'),
  runtimeMode: 'full-access' as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: '2026-03-29T00:00:10.000Z',
}

describe('buildLoadingThreadFromShell', () =>
{
  it('preserves shell metadata and supplies empty detail collections', () =>
  {
    const shell = {
      environmentId,
      id: threadId,
      projectId,
      title: 'Loading thread',
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5.4',
      },
      runtimeMode: 'full-access',
      interactionMode: 'default',
      branch: 'main',
      worktreePath: null,
      latestTurn: null,
      providerSwitch: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      session: null,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      origin: null,
    } satisfies ThreadShell

    expect(buildLoadingThreadFromShell(shell)).toMatchObject({
      environmentId,
      id: threadId,
      projectId,
      title: 'Loading thread',
      branch: 'main',
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    })
  })
})

const importedOrigin = {
  kind: 'imported' as const,
  source: 'codex-cli' as const,
  sourcePath: '/tmp/.codex/sessions/imported.jsonl',
  contentHash: 'content-hash',
  nativeSessionId: 'native-session',
  providerInstanceId: ProviderInstanceId.make('codex_personal'),
  importedAt: now,
}

function makeProvider(instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider
{
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make('codex'),
    displayName: instanceId === 'codex_personal' ? 'Personal Codex' : 'Codex',
    enabled: true,
    installed: true,
    version: '1.0.0',
    status: 'ready',
    auth: { status: 'authenticated' },
    checkedAt: now,
    continuation: { groupKey: 'codex:test-source' },
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }
}

function importContinuationActivity(
  continuation:
    | {
        readonly state: 'verified'
        readonly providerInstanceId: ReturnType<typeof ProviderInstanceId.make>
        readonly continuationIdentity?: null
        readonly reason: null
      }
    | {
        readonly state: 'history-only'
        readonly providerInstanceId: ReturnType<typeof ProviderInstanceId.make>
        readonly continuationIdentity?: null
        readonly reason: string
      },
  driverKind = ProviderDriverKind.make('codex'),
)
{
  return {
    id: EventId.make(`event-import-${continuation.state}`),
    tone: 'info' as const,
    kind: 'task.completed',
    summary: 'Imported continuation state recorded.',
    payload: {
      type: 'import.continuation',
      driverKind,
      continuation: {
        ...continuation,
        continuationIdentity:
          continuation.continuationIdentity === null
            ? null
            : {
                driverKind,
                continuationKey: `${driverKind}:test-source`,
              },
      },
    },
    turnId: null,
    createdAt: now,
  }
}

describe('resolveImportContinuationGate', () =>
{
  it('fails closed when the newest continuation marker cannot be decoded', () =>
  {
    const providerInstanceId = ProviderInstanceId.make('codex_personal')
    const gate = resolveImportContinuationGate({
      thread: makeThread({
        origin: importedOrigin,
        activities: [
          importContinuationActivity({
            state: 'verified',
            providerInstanceId,
            reason: null,
          }),
          {
            id: EventId.make('event-summary-only'),
            tone: 'info',
            kind: 'task.completed',
            summary: 'Resume linked to codex_personal.',
            payload: {},
            turnId: null,
            createdAt: now,
          },
          {
            id: EventId.make('event-forward-version'),
            tone: 'info',
            kind: 'task.completed',
            summary: 'A newer continuation authority marker.',
            payload: {
              type: 'import.continuation',
              version: 2,
            },
            turnId: null,
            createdAt: now,
          },
        ],
      }),
      providers: [makeProvider('codex_personal')],
    })

    expect(gate).toMatchObject({
      state: 'unknown',
      unknownKind: 'invalid',
      providerInstanceId: null,
      providerState: 'missing',
    })
    expect(gate).toHaveProperty(
      'reason',
      'Continuation details for this imported transcript are invalid or require a newer 456code version.',
    )
    expect(importContinuationConsentToken('environment-local:thread-1', gate)).toBeNull()
    expect(isImportContinuationSendBlocked(gate, null, null)).toBe(true)
    if (gate.state !== 'unknown')
    {
      throw new Error('expected invalid imported continuation gate')
    }
    expect(
      resolveImportContinuationBannerCopy({
        gate,
        providerDisplayName: 'the configured provider',
        sourceName: 'Codex',
      }),
    ).toEqual({
      action: 'import-settings',
      actionLabel: 'Repair import',
      description:
        'Continuation details for this imported transcript are invalid or require a newer 456code version. Sending is blocked to prevent starting the wrong provider session.',
      isReady: false,
      title: 'Imported session needs repair',
    })
  })

  it('routes a missing completion marker to import repair instead of provider settings', () =>
  {
    const gate = resolveImportContinuationGate({
      thread: makeThread({
        origin: importedOrigin,
        activities: [],
      }),
      providers: [makeProvider('codex')],
    })

    expect(gate).toMatchObject({
      state: 'unknown',
      unknownKind: 'missing',
      providerInstanceId: null,
      providerState: 'missing',
    })
    if (gate.state !== 'unknown')
    {
      throw new Error('expected missing imported continuation gate')
    }
    expect(
      resolveImportContinuationBannerCopy({
        gate,
        providerDisplayName: 'Codex',
        sourceName: 'Codex',
      }),
    ).toEqual({
      action: 'import-settings',
      actionLabel: 'Repair import',
      description:
        'Continuation details for this imported transcript are missing. Retry the import before sending. Sending is blocked to prevent starting the wrong provider session.',
      isReady: false,
      title: 'Imported session is incomplete',
    })
  })

  it('requires consent for the exact ready provider instance from the typed payload', () =>
  {
    const providerInstanceId = ProviderInstanceId.make('codex_personal')
    const gate = resolveImportContinuationGate({
      thread: makeThread({
        origin: importedOrigin,
        activities: [
          importContinuationActivity({
            state: 'verified',
            providerInstanceId,
            reason: null,
          }),
        ],
      }),
      providers: [makeProvider('codex'), makeProvider('codex_personal')],
    })
    const token = importContinuationConsentToken('environment-local:thread-1', gate)

    expect(gate).toEqual({
      state: 'verified',
      providerInstanceId,
      driverKind: 'codex',
      providerState: 'ready',
      reason: null,
      consent: {
        originContentHash: importedOrigin.contentHash,
        activityId: EventId.make('event-import-verified'),
        driverKind: 'codex',
        targetProviderInstanceId: providerInstanceId,
        continuation: {
          state: 'verified',
          providerInstanceId,
          continuationIdentity: {
            driverKind: 'codex',
            continuationKey: 'codex:test-source',
          },
          reason: null,
        },
      },
    })
    expect(token).toBe(
      JSON.stringify([
        'environment-local:thread-1',
        importedOrigin.contentHash,
        'event-import-verified',
        'codex',
        'codex_personal',
        'verified',
        'codex_personal',
        'codex',
        'codex:test-source',
        null,
      ]),
    )
    expect(isImportContinuationSendBlocked(gate, token, null)).toBe(true)
    expect(isImportContinuationSendBlocked(gate, token, token)).toBe(false)
  })

  it('fails closed when an imported marker has no immutable continuation source', () =>
  {
    const gate = resolveImportContinuationGate({
      thread: makeThread({
        origin: importedOrigin,
        activities: [
          importContinuationActivity({
            state: 'history-only',
            providerInstanceId: ProviderInstanceId.make('codex_personal'),
            continuationIdentity: null,
            reason: 'No exact provider route was available.',
          }),
        ],
      }),
      providers: [makeProvider('codex_personal')],
    })

    expect(gate).toEqual({
      state: 'unknown',
      unknownKind: 'invalid',
      providerInstanceId: null,
      driverKind: null,
      providerState: 'missing',
      reason:
        'Continuation source identity for this imported transcript is missing. Retry the import before sending.',
    })
    expect(importContinuationConsentToken('environment-local:thread-1', gate)).toBeNull()
  })

  it('blocks dispatch and invokes the continuation feedback action for a guarded send', () =>
  {
    let feedbackCount = 0
    let dispatchCount = 0

    if (
      !handleImportContinuationSendBlock(true, () =>
      {
        feedbackCount += 1
      })
    )
    {
      dispatchCount += 1
    }

    expect(feedbackCount).toBe(1)
    expect(dispatchCount).toBe(0)
  })

  it('does not treat a missing, disabled, or wrong-driver exact instance as ready', () =>
  {
    const providerInstanceId = ProviderInstanceId.make('codex_personal')
    const thread = makeThread({
      origin: importedOrigin,
      activities: [
        importContinuationActivity({
          state: 'verified',
          providerInstanceId,
          reason: null,
        }),
      ],
    })

    for (const providers of [
      [],
      [makeProvider('codex_personal', { enabled: false, status: 'disabled' })],
      [
        makeProvider('codex_personal', {
          driver: ProviderDriverKind.make('claudeAgent'),
        }),
      ],
    ])
    {
      const gate = resolveImportContinuationGate({ thread, providers })
      expect(gate).toMatchObject({
        state: 'verified',
        providerInstanceId,
        providerState: 'unavailable',
      })
      expect(importContinuationConsentToken('environment-local:thread-1', gate)).toBeNull()
      expect(isImportContinuationSendBlocked(gate, null, null)).toBe(true)
    }
  })

  it('uses the imported model target for history-only starts and releases the gate after a native turn', () =>
  {
    const providerInstanceId = ProviderInstanceId.make('codex_personal')
    const activities = [
      importContinuationActivity({
        state: 'history-only' as const,
        providerInstanceId,
        reason: 'The native session could not be verified.',
      }),
    ]
    const importedThread = makeThread({
      origin: importedOrigin,
      modelSelection: {
        instanceId: providerInstanceId,
        model: 'gpt-5.4',
      },
      activities,
    })

    const gate = resolveImportContinuationGate({
      thread: importedThread,
      providers: [makeProvider('codex_personal')],
    })
    expect(gate).toEqual({
      state: 'history-only',
      providerInstanceId,
      driverKind: 'codex',
      providerState: 'ready',
      reason: 'The native session could not be verified.',
      consent: {
        originContentHash: importedOrigin.contentHash,
        activityId: EventId.make('event-import-history-only'),
        driverKind: 'codex',
        targetProviderInstanceId: providerInstanceId,
        continuation: {
          state: 'history-only',
          providerInstanceId,
          continuationIdentity: {
            driverKind: 'codex',
            continuationKey: 'codex:test-source',
          },
          reason: 'The native session could not be verified.',
        },
      },
    })
    const alternateProviderInstanceId = ProviderInstanceId.make('codex_work')
    const alternateGate = resolveImportContinuationGate({
      thread: {
        ...importedThread,
        modelSelection: {
          instanceId: alternateProviderInstanceId,
          model: 'gpt-5.4',
        },
      },
      providers: [makeProvider('codex_personal')],
    })
    expect(importContinuationConsentToken('environment-local:thread-1', alternateGate)).toBe(
      importContinuationConsentToken('environment-local:thread-1', gate),
    )
    expect(
      resolveImportContinuationGate({
        thread: { ...importedThread, latestTurn: completedTurn },
        providers: [makeProvider('codex_personal')],
      }),
    ).toEqual({ state: 'not-required' })
  })
})

describe('resolveImportContinuationProviderSnapshot', () =>
{
  it('excludes a reused instance id when its live driver differs from the marker', () =>
  {
    const providerInstanceId = ProviderInstanceId.make('codex_personal')
    const wrongDriverProvider = makeProvider('codex_personal', {
      driver: ProviderDriverKind.make('claudeAgent'),
      displayName: 'Claude Personal',
      continuation: { groupKey: 'claudeAgent:test-source' },
    })

    expect(
      resolveImportContinuationProviderSnapshot(
        [wrongDriverProvider],
        providerInstanceId,
        ProviderDriverKind.make('codex'),
        {
          driverKind: ProviderDriverKind.make('codex'),
          continuationKey: 'codex:test-source',
        },
      ),
    ).toBeNull()
    expect(
      resolveImportContinuationProviderSnapshot(
        [wrongDriverProvider],
        providerInstanceId,
        ProviderDriverKind.make('claudeAgent'),
        {
          driverKind: ProviderDriverKind.make('claudeAgent'),
          continuationKey: 'claudeAgent:test-source',
        },
      ),
    ).toBe(wrongDriverProvider)
  })

  it('excludes a same-driver instance when its continuation source changed', () =>
  {
    const providerInstanceId = ProviderInstanceId.make('codex_personal')
    const reconfiguredProvider = makeProvider('codex_personal', {
      continuation: { groupKey: 'codex:other-home' },
    })

    expect(
      resolveImportContinuationProviderSnapshot(
        [reconfiguredProvider],
        providerInstanceId,
        ProviderDriverKind.make('codex'),
        {
          driverKind: ProviderDriverKind.make('codex'),
          continuationKey: 'codex:test-source',
        },
      ),
    ).toBeNull()
  })
})

describe('deriveLockedProvider', () =>
{
  it('does not lock a started thread to its current provider', () =>
  {
    const customInstanceId = ProviderInstanceId.make('codex_personal')
    const importedThread = makeThread({
      modelSelection: {
        instanceId: customInstanceId,
        model: 'gpt-5.4',
      },
      origin: importedOrigin,
      messages: [
        {
          id: MessageId.make('imported-message'),
          role: 'user',
          text: 'Imported history',
          turnId: null,
          createdAt: now,
          updatedAt: now,
          streaming: false,
        },
      ],
    })

    expect(
      deriveLockedProvider({
        thread: importedThread,
        selectedProvider: customInstanceId,
        threadProvider: customInstanceId,
        providers: [makeProvider('codex_personal')],
      }),
    ).toBeNull()
  })

  it('locks history-only starts to the exact marker driver instead of a cross-driver fallback', () =>
  {
    const requestedInstanceId = ProviderInstanceId.make('claude_personal')
    const fallbackInstanceId = ProviderInstanceId.make('codex')
    const importedThread = makeThread({
      modelSelection: {
        instanceId: fallbackInstanceId,
        model: 'gpt-5.4',
      },
      origin: importedOrigin,
      messages: [
        {
          id: MessageId.make('imported-message'),
          role: 'user',
          text: 'Imported history',
          turnId: null,
          createdAt: now,
          updatedAt: now,
          streaming: false,
        },
      ],
    })
    const providers = [
      makeProvider('codex'),
      makeProvider('claude_personal', {
        driver: ProviderDriverKind.make('claudeAgent'),
      }),
    ]
    const importContinuationGate = resolveImportContinuationGate({
      thread: {
        ...importedThread,
        activities: [
          importContinuationActivity(
            {
              state: 'history-only',
              providerInstanceId: requestedInstanceId,
              reason: 'The native session could not be verified.',
            },
            ProviderDriverKind.make('claudeAgent'),
          ),
        ],
      },
      providers,
    })

    expect(
      deriveLockedProvider({
        thread: importedThread,
        selectedProvider: fallbackInstanceId,
        threadProvider: fallbackInstanceId,
        providers,
        importContinuationGate,
      }),
    ).toBe(ProviderDriverKind.make('claudeAgent'))
  })
})

describe('resolveThreadMetadataUpdateForNextTurn', () =>
{
  const modelSelection = {
    instanceId: ProviderInstanceId.make('codex'),
    model: 'gpt-5.4',
  }

  it('updates a stale local thread branch to the active checkout', () =>
  {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: 'feature/thread',
        nextBranch: 'feature/checkout',
      }),
    ).toEqual({ branch: 'feature/checkout', worktreePath: null })
  })

  it('does not write metadata when the model and branch are unchanged', () =>
  {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: 'feature/current',
        nextBranch: 'feature/current',
      }),
    ).toBeNull()
  })
})

describe('buildThreadTurnInterruptInput', () =>
{
  it("targets the session's active running turn", () =>
  {
    const activeTurnId = TurnId.make('turn-running')

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: 'running',
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId })
  })

  it('omits a turn id when the session is not running', () =>
  {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    })
  })
})

describe('deriveComposerSendState', () =>
{
  it('treats expired terminal pills as non-sendable content', () =>
  {
    const state = deriveComposerSendState({
      prompt: '\uFFFC',
      imageCount: 0,
      terminalContexts: [
        {
          id: 'ctx-expired',
          threadId,
          terminalId: 'default',
          terminalLabel: 'Terminal 1',
          lineStart: 4,
          lineEnd: 4,
          text: '',
          createdAt: now,
        },
      ],
    })

    expect(state.trimmedPrompt).toBe('')
    expect(state.sendableTerminalContexts).toEqual([])
    expect(state.expiredTerminalContextCount).toBe(1)
    expect(state.hasSendableContent).toBe(false)
  })

  it('keeps text sendable while excluding expired terminal pills', () =>
  {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: 'ctx-expired',
          threadId,
          terminalId: 'default',
          terminalLabel: 'Terminal 1',
          lineStart: 4,
          lineEnd: 4,
          text: '',
          createdAt: now,
        },
      ],
    })

    expect(state.trimmedPrompt).toBe('yoo  waddup')
    expect(state.expiredTerminalContextCount).toBe(1)
    expect(state.hasSendableContent).toBe(true)
  })

  it('treats element contexts as sendable content (no text, no images, no terminals)', () =>
  {
    const state = deriveComposerSendState({
      prompt: '',
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    })

    expect(state.trimmedPrompt).toBe('')
    expect(state.expiredTerminalContextCount).toBe(0)
    expect(state.hasSendableContent).toBe(true)
  })

  it('does NOT treat zero element contexts as sendable', () =>
  {
    expect(
      deriveComposerSendState({
        prompt: '',
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false)
  })
})

describe('getStartedThreadModelChangeBlockReason', () =>
{
  const providers = [
    {
      instanceId: ProviderInstanceId.make('codex'),
    },
    {
      instanceId: ProviderInstanceId.make('grok'),
      requiresNewThreadForModelChange: true,
    },
  ]

  it.each([
    [
      'allows model changes before a provider session has started',
      {
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make('grok'),
          model: 'grok-build',
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make('grok'),
          model: 'grok-other',
        },
      },
      null,
    ],
    [
      'allows unchanged model selections for restricted providers',
      {
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make('grok'),
          model: 'grok-build',
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make('grok'),
          model: 'grok-build',
        },
      },
      null,
    ],
    [
      'blocks started-session model changes when the provider requires a new thread',
      {
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make('grok'),
          model: 'grok-build',
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make('grok'),
          model: 'grok-other',
        },
      },
      {
        title: 'Start a new chat to change models',
        description:
          'This provider does not allow switching models after a conversation has started.',
      },
    ],
    [
      'allows provider-instance changes after a session has started',
      {
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5.4',
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make('grok'),
          model: 'grok-build',
        },
      },
      null,
    ],
  ])('%s', (_label, input, expected) =>
  {
    expect(getStartedThreadModelChangeBlockReason({ providers, ...input })).toEqual(expected)
  })
})

describe('getStartedThreadProviderSwitchBlockReason', () =>
{
  it('prioritizes active handoffs, running turns, approvals, and user input', () =>
  {
    expect(
      getStartedThreadProviderSwitchBlockReason({
        isSwitchingProvider: true,
        isTurnRunning: true,
        hasPendingApproval: true,
        hasPendingUserInput: true,
      }),
    ).toBe('A provider handoff is already in progress.')
    expect(
      getStartedThreadProviderSwitchBlockReason({
        isSwitchingProvider: false,
        isTurnRunning: true,
        hasPendingApproval: true,
        hasPendingUserInput: true,
      }),
    ).toBe('Wait for the current response to finish before switching providers.')
    expect(
      getStartedThreadProviderSwitchBlockReason({
        isSwitchingProvider: false,
        isTurnRunning: false,
        hasPendingApproval: true,
        hasPendingUserInput: true,
      }),
    ).toBe('Resolve the pending approval before switching providers.')
    expect(
      getStartedThreadProviderSwitchBlockReason({
        isSwitchingProvider: false,
        isTurnRunning: false,
        hasPendingApproval: false,
        hasPendingUserInput: true,
      }),
    ).toBe('Answer the pending question before switching providers.')
  })

  // clear flags are the only path that unblocks the picker; owning suite must pin null
  it('returns null when nothing blocks a provider switch', () =>
  {
    expect(
      getStartedThreadProviderSwitchBlockReason({
        isSwitchingProvider: false,
        isTurnRunning: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull()
  })
})

describe('resolveSendEnvMode', () =>
{
  it('keeps worktree mode only for git repositories', () =>
  {
    expect(resolveSendEnvMode({ requestedEnvMode: 'worktree', isGitRepo: true })).toBe('worktree')
    expect(resolveSendEnvMode({ requestedEnvMode: 'worktree', isGitRepo: false })).toBe('local')
  })
})

describe('shouldShowBranchMismatchBanner', () =>
{
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  }

  it('stays hidden during passive browsing (even though the composer autofocuses)', () =>
  {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false)
  })

  it('shows once the composer has draft content', () =>
  {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true)
  })

  it('stays mounted after the draft clears once shown for the current mismatch', () =>
  {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(true)
  })

  it.each([
    {
      label: 'dismissed',
      input: { ...base, composerHasContent: true, isDismissed: true },
    },
    {
      label: 'without mismatch',
      input: { ...base, composerHasContent: true, hasMismatch: false },
    },
  ])('never shows when $label', ({ input }) =>
  {
    expect(shouldShowBranchMismatchBanner(input)).toBe(false)
  })
})

describe('session branch mismatch dismissal', () =>
{
  it('tracks dismissed keys and treats other keys as active', () =>
  {
    expect(isBranchMismatchDismissedForSession('t1:a:b')).toBe(false)
    dismissBranchMismatchForSession('t1:a:b')
    expect(isBranchMismatchDismissedForSession('t1:a:b')).toBe(true)
    expect(isBranchMismatchDismissedForSession('t1:a:c')).toBe(false)
    expect(isBranchMismatchDismissedForSession(null)).toBe(false)
  })
})

describe('reconcileMountedTerminalThreadIds', () =>
{
  it('keeps open threads and makes the active thread most recent', () =>
  {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ['thread-a', 'thread-b', 'thread-c'],
        openThreadIds: ['thread-a', 'thread-b', 'thread-c'],
        activeThreadId: 'thread-a',
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(['thread-b', 'thread-c', 'thread-a'])
  })

  it('drops closed threads and enforces the hidden mounted cap', () =>
  {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    )
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS))
  })
})

describe('reconcileRetainedMountedThreadIds', () =>
{
  it('retains hidden open threads and adds the active open thread', () =>
  {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make('thread-hidden')],
        openThreadIds: [ThreadId.make('thread-hidden')],
        activeThreadId: ThreadId.make('thread-active'),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make('thread-hidden'), ThreadId.make('thread-active')])
  })

  it('can retain the active thread as hidden when it is inactive', () =>
  {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make('thread-active')],
        openThreadIds: [ThreadId.make('thread-active')],
        activeThreadId: ThreadId.make('thread-active'),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make('thread-active')])
  })

  it('evicts the oldest hidden threads beyond the configured cap', () =>
  {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    )

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS))
  })
})

describe('shouldWriteThreadErrorToCurrentServerThread', () =>
{
  it('writes errors for a shell-derived active server thread', () =>
  {
    const routeThreadRef = { environmentId, threadId }

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true)
  })

  it('requires an active server thread matching the environment, route, and target', () =>
  {
    const routeThreadRef = { environmentId, threadId }

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false)
  })
})

describe('startNewThreadForProject', () =>
{
  it('starts a thread through the shared handler for the active project', () =>
  {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = []
    const projectRef = { environmentId, projectId }

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) =>
      {
        calls.push(nextProjectRef)
        return Promise.resolve()
      }),
    ).toBe(true)
    expect(calls).toEqual([projectRef])
  })

  it('does nothing when the active project is unavailable', () =>
  {
    let called = false

    expect(
      startNewThreadForProject(null, () =>
      {
        called = true
        return Promise.resolve()
      }),
    ).toBe(false)
    expect(called).toBe(false)
  })
})

describe('hasServerAcknowledgedLocalDispatch', () =>
{
  it('does not acknowledge unchanged server state', () =>
  {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    )

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: 'ready',
        latestTurn: completedTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false)
  })

  it('acknowledges a settled newer turn', () =>
  {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    )
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make('turn-2'),
      requestedAt: '2026-03-29T00:01:00.000Z',
      startedAt: '2026-03-29T00:01:01.000Z',
      completedAt: '2026-03-29T00:01:30.000Z',
    }

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: 'ready',
        latestTurn: newerTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true)
  })

  it('waits for the matching running turn before acknowledging', () =>
  {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    )
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make('turn-2'),
      state: 'running' as const,
      requestedAt: '2026-03-29T00:01:00.000Z',
      startedAt: '2026-03-29T00:01:01.000Z',
      completedAt: null,
    }

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: 'running',
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: 'running',
          activeTurnId: TurnId.make('turn-other'),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false)
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: 'running',
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: 'running',
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true)
  })

  it('acknowledges a steering message projected onto the current running turn', () =>
  {
    const runningTurn = {
      ...completedTurn,
      state: 'running' as const,
      completedAt: null,
    }
    const runningSession = {
      ...readySession,
      status: 'running' as const,
      activeTurnId: runningTurn.turnId,
    }
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make('message-before-steer'),
            role: 'user',
            text: 'Initial prompt',
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
    )

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: 'running',
        latestTurn: runningTurn,
        latestUserMessageId: MessageId.make('message-steer'),
        session: runningSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true)
  })

  it('acknowledges pending user interaction and errors immediately', () =>
  {
    const localDispatch = createLocalDispatchSnapshot(makeThread())
    const common = {
      localDispatch,
      phase: 'ready' as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    }

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true)
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true)
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: 'failed' })).toBe(true)
  })
})
