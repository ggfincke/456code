// tests/apps/web/components/chat/orchestrate-plan/OrchestratePlanCard.test.ts
// verifies exact orchestrate plan rendering, linkage states, and reply grammar
import {
  type EnvironmentId,
  type OrchestratePlanRevision,
  type ProposalGeneration,
  type ProposalOrchestratePlanLookupResult,
  type ScopedThreadRef,
  ThreadId,
} from '@t3tools/contracts'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  resolveOrchestrateArchitectureState,
  selectExactOrchestrateProposalLookup,
} from '../../../../../../apps/web/src/components/cartographer/orchestrateArchitecture'
import {
  buildOrchestrateApprovalReply,
  OrchestratePlanCard,
  type OrchestratePlan,
  type OrchestratePlanActions,
  parseOrchestratePlan,
  refreshOrchestrateArchitectureQueries,
  resolveOrchestrateArchitectureRevision,
} from '../../../../../../apps/web/src/components/chat/orchestrate-plan/OrchestratePlanCard'
import {
  hashOrchestratePlanText,
  registerOrchestratePlanCard,
  resetOrchestratePlanStoreForTests,
} from '../../../../../../apps/web/src/components/chat/orchestrate-plan/orchestratePlanStore'
import {
  planContentText,
  resolvePersistedRevision,
} from '../../../../../../apps/web/src/components/chat/orchestrate-plan/parse'

const mocks = vi.hoisted(() => ({
  buttons: [] as Array<{ readonly label: string; readonly onClick?: () => void }>,
  clearInterval: vi.fn(),
  effectCleanups: [] as Array<() => void>,
  findProposalByOrchestrateRevision: vi.fn((input: unknown) => ({
    kind: 'find-proposal-by-orchestrate-revision',
    input,
  })),
  generation: null as unknown,
  generationRefresh: vi.fn(),
  intervalCallbacks: [] as Array<() => void>,
  latestProposalGeneration: vi.fn((input: unknown) => ({
    kind: 'latest-proposal-generation',
    input,
  })),
  lookup: null as unknown,
  lookupRefresh: vi.fn(),
  openExplorer: vi.fn(),
  query: vi.fn(),
  setInterval: vi.fn(),
  startProposalGeneration: vi.fn(),
  workersRefresh: vi.fn(),
}))

vi.mock('react', async (importOriginal) =>
{
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useEffect: (setup: () => void | (() => void)) =>
    {
      const cleanup = setup()
      if (typeof cleanup === 'function') mocks.effectCleanups.push(cleanup)
    },
    useSyncExternalStore: <Snapshot>(
      _subscribe: (listener: () => void) => () => void,
      getSnapshot: () => Snapshot,
    ): Snapshot => getSnapshot(),
  }
})

vi.mock('~/state/projects', () => ({
  projectEnvironment: {
    findProposalByOrchestrateRevision: mocks.findProposalByOrchestrateRevision,
    latestProposalGeneration: mocks.latestProposalGeneration,
    startProposalGeneration: mocks.startProposalGeneration,
  },
}))

vi.mock('~/state/query', () => ({
  useEnvironmentQuery: (query: unknown) => mocks.query(query),
}))

vi.mock('~/state/workers', () => ({
  workersEnvironment: {
    list: (input: unknown) => ({ kind: 'workers-list', input }),
  },
}))

vi.mock('~/rightPanelStore', () => ({
  useRightPanelStore: {
    getState: () => ({ openExplorer: mocks.openExplorer }),
  },
}))

vi.mock('~/components/ui/button', async () =>
{
  const react = await vi.importActual<typeof import('react')>('react')
  const labelFor = (child: ReactNode): string =>
  {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    if (Array.isArray(child)) return child.map(labelFor).join('')
    if (react.isValidElement(child))
    {
      return labelFor((child.props as { readonly children?: ReactNode }).children)
    }
    return ''
  }

  return {
    Button: (props: {
      readonly children?: ReactNode
      readonly disabled?: boolean
      readonly onClick?: () => void
      readonly type?: 'button' | 'reset' | 'submit'
    }) =>
    {
      const label = labelFor(props.children)
      mocks.buttons.push({
        label,
        ...(props.onClick === undefined ? {} : { onClick: props.onClick }),
      })
      return react.createElement(
        'button',
        {
          'data-button-label': label,
          disabled: props.disabled,
          type: props.type,
        },
        props.children,
      )
    },
  }
})

function parsePlan(value: Record<string, unknown>): OrchestratePlan
{
  const plan = parseOrchestratePlan(JSON.stringify(value))
  if (plan === null) throw new Error('Expected a valid orchestrate plan fixture.')
  return plan
}

const BASE_PLAN = {
  workflow: 'review-and-fix',
  task: 'Review the change and implement the fix',
  runId: 'run-42',
  stages: [
    {
      id: 'review',
      provider: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
      mode: 'read',
      workers: 1,
      scope: 'apps/web',
    },
    {
      id: 'implement',
      provider: 'claudeAgent',
      model: 'claude-opus-5',
      effort: 'medium',
      mode: 'edit',
      workers: 1,
      scope: 'apps/server',
    },
  ],
  totalWorkers: 2,
  maxWorkers: 2,
} satisfies Record<string, unknown>

function persistedRevision(revision: number): OrchestratePlanRevision
{
  return {
    runId: 'run-42',
    revision,
    turnId: null,
    workflow: 'review-and-fix',
    task: 'Review the change and implement the fix',
    stages: [],
    totalWorkers: 0,
    maxWorkers: 0,
    source: 'tool',
    leadModelSelection: null,
    status: 'pending',
    createdAt: '2026-08-07T12:00:00.000Z',
    updatedAt: '2026-08-07T12:00:00.000Z',
  }
}

function generation(state: ProposalGeneration['state']): ProposalGeneration
{
  return { state } as ProposalGeneration
}

const environmentId = 'environment-orchestrate-card' as EnvironmentId
const threadRef = {
  environmentId,
  threadId: ThreadId.make('thread-1'),
} as ScopedThreadRef
const linkedLookup = {
  link: {
    proposalId: 'proposal-1',
    proposalRevision: 2,
    sourceThreadId: threadRef.threadId,
    runId: 'run-42',
    revision: 3,
  },
  proposal: { proposalId: 'proposal-1', sourceThreadId: threadRef.threadId },
  revision: { proposalId: 'proposal-1', revision: 2 },
  orchestratePlan: { runId: 'run-42', revision: 3 },
} as ProposalOrchestratePlanLookupResult

function planActions(
  orchestratePlans: ReadonlyArray<OrchestratePlanRevision>,
): OrchestratePlanActions
{
  return {
    environmentId,
    threadRef,
    instanceEntries: [],
    modelOptionsByInstance: new Map(),
    orchestratePlans,
    lead: null,
    onApprove: async () => true,
    onRespond: async () => true,
    onEditInChat: () => undefined,
  }
}

function renderCard(
  plan: OrchestratePlan,
  revisions: ReadonlyArray<OrchestratePlanRevision>,
): string
{
  return renderToStaticMarkup(
    createElement(OrchestratePlanCard, {
      plan,
      actions: planActions(revisions),
    }),
  )
}

const hadWindow = 'window' in globalThis
const originalWindow = globalThis.window

beforeEach(() =>
{
  vi.clearAllMocks()
  resetOrchestratePlanStoreForTests()
  mocks.buttons.length = 0
  mocks.effectCleanups.length = 0
  mocks.intervalCallbacks.length = 0
  mocks.lookup = linkedLookup
  mocks.generation = null
  mocks.setInterval.mockImplementation((handler: TimerHandler) =>
  {
    if (typeof handler === 'function') mocks.intervalCallbacks.push(() => handler())
    return 41
  })
  mocks.query.mockImplementation((query: { readonly kind?: string } | null) =>
  {
    switch (query?.kind)
    {
      case 'find-proposal-by-orchestrate-revision':
        return {
          data: mocks.lookup,
          error: null,
          isPending: false,
          hasSettled: true,
          refresh: mocks.lookupRefresh,
        }
      case 'latest-proposal-generation':
        return {
          data: mocks.generation,
          error: null,
          isPending: false,
          hasSettled: true,
          refresh: mocks.generationRefresh,
        }
      case 'workers-list':
        return {
          data: { jobs: [] },
          error: null,
          isPending: false,
          hasSettled: true,
          refresh: mocks.workersRefresh,
        }
      default:
        return { data: null, error: null, isPending: false, hasSettled: true, refresh: vi.fn() }
    }
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      clearInterval: mocks.clearInterval,
      setInterval: mocks.setInterval,
    },
    writable: true,
  })
})

afterEach(() =>
{
  for (const cleanup of mocks.effectCleanups.splice(0)) cleanup()
  if (hadWindow)
  {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
      writable: true,
    })
  }
  else
  {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

describe('parseOrchestratePlan', () =>
{
  it('normalizes optional descriptive fields while retaining run correlation', () =>
  {
    const plan = parsePlan({
      workflow: 'inspect',
      runId: 'run-inspect',
      stages: [
        {
          id: 'inspect',
          provider: 'codex',
          model: null,
          mode: 'read',
          workers: 2,
          scope: ['apps/web', 'tests/apps/web'],
        },
      ],
    })

    expect(plan).toEqual({
      workflow: 'inspect',
      task: '',
      runId: 'run-inspect',
      stages: [
        {
          id: 'inspect',
          provider: 'codex',
          model: '',
          mode: 'read',
          workers: 2,
          scope: 'apps/web; tests/apps/web',
        },
      ],
      totalWorkers: 2,
      maxWorkers: 2,
      validationError: null,
    })
  })

  it('accepts only a safe non-negative committed revision fence', () =>
  {
    expect(parsePlan({ ...BASE_PLAN, revision: 7 }).revision).toBe(7)
    expect(parseOrchestratePlan(JSON.stringify({ ...BASE_PLAN, revision: -1 }))).toBeNull()
    expect(parseOrchestratePlan(JSON.stringify({ ...BASE_PLAN, revision: 1.5 }))).toBeNull()
  })

  it('rejects structurally invalid plans', () =>
  {
    expect(parseOrchestratePlan('not json')).toBeNull()
    expect(
      parseOrchestratePlan(
        JSON.stringify({
          workflow: 'broken',
          stages: [{ id: 'edit', provider: 'codex', mode: 'write', workers: 1 }],
        }),
      ),
    ).toBeNull()
  })

  it('flags duplicate stage IDs with an approval-blocking error', () =>
  {
    const plan = parsePlan({
      ...BASE_PLAN,
      stages: [BASE_PLAN.stages[0], { ...BASE_PLAN.stages[1], id: 'review' }],
    })

    expect(plan.validationError).toBe(
      'Duplicate stage ID "review". Stage IDs must be unique before approval.',
    )
  })
})

describe('persisted orchestrate revision resolution', () =>
{
  const revisions = [persistedRevision(1), persistedRevision(3)]

  it('resolves only the exact committed revision for a new fence', () =>
  {
    expect(resolvePersistedRevision(revisions, 'run-42', 1)?.revision).toBe(1)
    expect(resolvePersistedRevision(revisions, 'run-42', 2)).toBeNull()
  })

  it('keeps latest-for-run resolution only for legacy fences', () =>
  {
    expect(resolvePersistedRevision(revisions, 'run-42', undefined)?.revision).toBe(3)
  })

  it('withholds exact-link architecture routing from moving legacy fences', () =>
  {
    expect(resolveOrchestrateArchitectureRevision(revisions[1]!, undefined)).toBeNull()
    expect(resolveOrchestrateArchitectureRevision(revisions[1]!, 2)).toBeNull()
    expect(resolveOrchestrateArchitectureRevision(revisions[1]!, 3)).toBe(revisions[1])
  })

  it('includes the committed revision in streamed content identity', () =>
  {
    const first = parsePlan({ ...BASE_PLAN, revision: 1 })
    const second = parsePlan({ ...BASE_PLAN, revision: 2 })
    expect(planContentText(first)).not.toBe(planContentText(second))
  })
})

describe('OrchestratePlanCard architecture strip', () =>
{
  it('places the immutable-revision strip on an active card and opens the exact proposal target', () =>
  {
    const plan = parsePlan({ ...BASE_PLAN, revision: 3 })
    const markup = renderCard(plan, [persistedRevision(3)])
    const stripIndex = markup.indexOf('data-orchestrate-architecture=')

    expect(stripIndex).toBeGreaterThan(markup.indexOf('</header>'))
    expect(stripIndex).toBeLessThan(markup.indexOf('<table'))
    expect(markup.match(/data-orchestrate-architecture=/g)).toHaveLength(1)
    expect(markup).toContain('data-orchestrate-architecture="linked-no-generation"')
    expect(mocks.findProposalByOrchestrateRevision).toHaveBeenCalledWith({
      environmentId,
      input: {
        sourceThreadId: threadRef.threadId,
        runId: 'run-42',
        revision: 3,
      },
    })
    expect(mocks.latestProposalGeneration).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        proposalId: 'proposal-1',
        revision: 2,
      },
    })

    const openExplorer = mocks.buttons.find((button) => button.label === 'Open review')
    expect(openExplorer?.onClick).toBeTypeOf('function')
    openExplorer?.onClick?.()
    expect(mocks.openExplorer).toHaveBeenCalledWith(threadRef, {
      kind: 'orchestrate',
      threadId: threadRef.threadId,
      runId: 'run-42',
      revision: 3,
    })
  })

  it('keeps the immutable-revision strip directly under a compact superseded summary', () =>
  {
    const plan = parsePlan({ ...BASE_PLAN, revision: 3 })
    const emissionRevisionKey = `content:${hashOrchestratePlanText(planContentText(plan))}`
    registerOrchestratePlanCard('run-42', emissionRevisionKey, {
      messageIndex: 10,
      planIndex: 0,
    })
    registerOrchestratePlanCard('run-42', 'newer-revision', {
      messageIndex: 11,
      planIndex: 0,
    })

    const markup = renderCard(plan, [persistedRevision(3)])
    const summaryIndex = markup.indexOf('A newer card owns this run response')
    const summaryEndIndex = markup.indexOf('</div>', summaryIndex)
    const stripIndex = markup.indexOf('data-orchestrate-architecture=')

    expect(markup).toContain('data-orchestrate-plan-superseded="true"')
    expect(summaryIndex).toBeGreaterThan(-1)
    expect(summaryEndIndex).toBeGreaterThan(summaryIndex)
    expect(stripIndex).toBeGreaterThan(summaryEndIndex)
    expect(markup).toContain('border-t')
    expect(markup).not.toContain('<table')
  })

  it('omits the strip when an exact committed revision is missing or the fence is legacy', () =>
  {
    const revisions = [persistedRevision(3)]
    const missing = renderCard(parsePlan({ ...BASE_PLAN, revision: 2 }), revisions)
    const legacy = renderCard(parsePlan(BASE_PLAN), revisions)

    expect(missing).not.toContain('data-orchestrate-architecture=')
    expect(legacy).not.toContain('data-orchestrate-architecture=')
    expect(mocks.findProposalByOrchestrateRevision).not.toHaveBeenCalled()
  })

  it('refreshes linked queries without starting proposal generation', () =>
  {
    const plan = parsePlan({ ...BASE_PLAN, revision: 3 })
    renderCard(plan, [persistedRevision(3)])

    expect(mocks.intervalCallbacks).toHaveLength(1)
    mocks.intervalCallbacks[0]!()
    expect(mocks.lookupRefresh).toHaveBeenCalledTimes(1)
    expect(mocks.generationRefresh).toHaveBeenCalledTimes(1)
    expect(mocks.startProposalGeneration).not.toHaveBeenCalled()
  })
})

describe('orchestrate architecture linkage', () =>
{
  const target = {
    kind: 'orchestrate' as const,
    threadId: ThreadId.make('thread-1'),
    runId: 'run-42',
    revision: 3,
  }
  const lookup = {
    link: {
      proposalId: 'proposal-1',
      proposalRevision: 2,
      sourceThreadId: 'thread-1',
      runId: 'run-42',
      revision: 3,
    },
    proposal: { proposalId: 'proposal-1', sourceThreadId: 'thread-1' },
    revision: { proposalId: 'proposal-1', revision: 2 },
    orchestratePlan: { runId: 'run-42', revision: 3 },
  } as ProposalOrchestratePlanLookupResult

  it('accepts only a lookup matching the complete immutable target', () =>
  {
    expect(selectExactOrchestrateProposalLookup(lookup, target)).toBe(lookup)
    expect(
      selectExactOrchestrateProposalLookup(
        {
          ...lookup,
          orchestratePlan: { ...lookup.orchestratePlan, revision: 4 },
        },
        target,
      ),
    ).toBeNull()
  })

  it('covers pending, no-link, linked, active, ready, and terminal states', () =>
  {
    const base = {
      lookup: null,
      lookupSettled: true,
      lookupError: null,
      generation: null,
      generationSettled: true,
      generationError: null,
    }
    expect(resolveOrchestrateArchitectureState({ ...base, lookupSettled: false }).kind).toBe(
      'pending',
    )
    expect(resolveOrchestrateArchitectureState(base).kind).toBe('no-link')
    expect(resolveOrchestrateArchitectureState({ ...base, lookup }).kind).toBe(
      'linked-no-generation',
    )
    expect(
      resolveOrchestrateArchitectureState({ ...base, lookup, generationSettled: false }).kind,
    ).toBe('pending')
    expect(
      resolveOrchestrateArchitectureState({
        ...base,
        lookup,
        generation: generation('analyzing'),
      }).kind,
    ).toBe('active')
    expect(
      resolveOrchestrateArchitectureState({
        ...base,
        lookup,
        generation: generation('ready'),
      }).kind,
    ).toBe('ready')
    expect(
      resolveOrchestrateArchitectureState({
        ...base,
        lookup,
        generation: generation('abandoned'),
      }).kind,
    ).toBe('terminal')
  })

  it('keeps polling the exact link and stops generation polling after revert pruning', () =>
  {
    const refreshLookup = vi.fn()
    const refreshGeneration = vi.fn()

    refreshOrchestrateArchitectureQueries({
      linked: true,
      refreshLookup,
      refreshGeneration,
    })
    refreshOrchestrateArchitectureQueries({
      linked: false,
      refreshLookup,
      refreshGeneration,
    })

    expect(refreshLookup).toHaveBeenCalledTimes(2)
    expect(refreshGeneration).toHaveBeenCalledTimes(1)
  })
})

describe('buildOrchestrateApprovalReply', () =>
{
  it('emits the exact no-override grammar with run correlation', () =>
  {
    const plan = parsePlan(BASE_PLAN)

    expect(buildOrchestrateApprovalReply(plan)).toBe('approve run=run-42')
  })

  it('emits provider, model-only, effort, and max-worker overrides in stage order', () =>
  {
    const plan = parsePlan(BASE_PLAN)

    expect(
      buildOrchestrateApprovalReply(plan, {
        selections: {
          '0:review': {
            provider: 'cursor',
            model: 'cursor-pro',
            instanceId: null,
          },
          '1:implement': {
            provider: 'claudeAgent',
            model: 'claude-opus-5.1',
            instanceId: null,
          },
        },
        efforts: {
          '0:review': 'xhigh',
          '1:implement': 'high',
        },
        maxWorkers: 4,
      }),
    ).toBe(
      'approve run=run-42 review=cursor:cursor-pro:xhigh implement=claude-opus-5.1:high max-workers=4',
    )
  })

  it('emits a provider-only override for a provider-default model', () =>
  {
    const plan = parsePlan({
      ...BASE_PLAN,
      stages: [{ ...BASE_PLAN.stages[0], model: null, effort: undefined }],
      totalWorkers: 1,
      maxWorkers: 1,
    })

    expect(
      buildOrchestrateApprovalReply(plan, {
        selections: {
          '0:review': { provider: 'cursor', model: '', instanceId: null },
        },
      }),
    ).toBe('approve run=run-42 review=cursor')
  })
})
