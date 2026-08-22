// tests/packages/client-runtime/state/projectCommands.test.ts
// verifies native architecture command, query, and subscription atom boundaries

import {
  type ArchitectureImpactProjectionResult,
  ArchitectureGenerationId,
  ArchitectureGraphDigest,
  EnvironmentId,
  ProjectId,
  ProposalGenerationId,
  ProposalId,
  ProposalRevisionId,
  ThreadId,
  WS_METHODS,
  type ProjectAtlasStatus,
} from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import * as TestClock from 'effect/testing/TestClock'
import { AsyncResult, Atom, AtomRegistry } from 'effect/unstable/reactivity'

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from '../../../../packages/client-runtime/src/connection/model.ts'
import * as EnvironmentRegistry from '../../../../packages/client-runtime/src/connection/registry.ts'
import * as EnvironmentSupervisor from '../../../../packages/client-runtime/src/connection/supervisor.ts'
import type { WsRpcProtocolClient } from '../../../../packages/client-runtime/src/rpc/protocol.ts'
import type { RpcSession } from '../../../../packages/client-runtime/src/rpc/session.ts'
import { createProjectEnvironmentAtoms } from '../../../../packages/client-runtime/src/state/projectCommands.ts'

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make('environment-1'),
  label: 'Test environment',
  httpBaseUrl: 'https://environment.example.test',
  wsBaseUrl: 'wss://environment.example.test',
})
const PROJECT_ID = ProjectId.make('project-1')
const THREAD_ID = ThreadId.make('thread-architecture-impact')
const PLAN = {
  _tag: 'plan' as const,
  planId: 'plan:thread-architecture-impact:turn:impact',
}
const PROPOSAL_GENERATION_ID = ProposalGenerationId.make('generation-impact')
const PROPOSAL_ID = ProposalId.make('proposal-impact')
const PROPOSAL_REVISION_ID = ProposalRevisionId.make('proposal-impact:1')
const READY_STATUS: ProjectAtlasStatus = {
  state: 'ready',
  source: {
    kind: 'standing-project-generation',
    projectId: PROJECT_ID,
    generationId: ArchitectureGenerationId.make('a'.repeat(64)),
    side: 'analyzed',
    graphDigest: ArchitectureGraphDigest.make(`sha256:${'b'.repeat(64)}`),
  },
  freshness: {
    builtAt: '2026-08-07T12:00:00.000Z',
    dirty: false,
  },
  lastBuildError: null,
}
const IMPACT_RESULT: ArchitectureImpactProjectionResult = {
  version: 1,
  descriptor: {
    version: 1,
    descriptorId: 'c'.repeat(64),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    target: { kind: 'plan', plan: PLAN, state: 'active' },
    verifiedCandidate: {
      authority: 'verified',
      source: {
        kind: 'verified-proposal-impact',
        threadId: THREAD_ID,
        generationId: PROPOSAL_GENERATION_ID,
        proposalId: PROPOSAL_ID,
        revisionId: PROPOSAL_REVISION_ID,
        baseTreeOid: '1'.repeat(40),
        headTreeOid: '2'.repeat(40),
        baseGraphDigest: `sha256:${'3'.repeat(64)}`,
        headGraphDigest: `sha256:${'4'.repeat(64)}`,
        projectionDigest: `sha256:${'5'.repeat(64)}`,
      },
      projectionId: 'projection-impact',
      projectionRevision: 1,
      projectionDigest: `sha256:${'5'.repeat(64)}`,
      resultState: 'no-impact',
      freshness: 'fresh',
      generatedAt: '2026-08-20T12:00:00.000Z',
      publishedAt: '2026-08-20T12:00:00.000Z',
    },
    defaultAuthority: 'verified',
    resolvedAt: '2026-08-20T12:00:00.000Z',
  },
  selectedAuthority: 'verified',
  projection: {
    projectionVersion: 1,
    projectionId: 'projection-impact',
    projectionRevision: 1,
    kind: 'impact-diff',
    authority: 'verified',
    resultState: 'no-impact',
    freshness: 'fresh',
    generatedAt: '2026-08-20T12:00:00.000Z',
    publishedAt: '2026-08-20T12:00:00.000Z',
    source: {
      kind: 'verified-proposal-impact',
      threadId: THREAD_ID,
      generationId: PROPOSAL_GENERATION_ID,
      proposalId: PROPOSAL_ID,
      revisionId: PROPOSAL_REVISION_ID,
      baseTreeOid: '1'.repeat(40),
      headTreeOid: '2'.repeat(40),
      baseGraphDigest: `sha256:${'3'.repeat(64)}`,
      headGraphDigest: `sha256:${'4'.repeat(64)}`,
      projectionDigest: `sha256:${'5'.repeat(64)}`,
    },
    lens: 'architecture',
    semanticLevel: 'files',
    breadcrumbs: [],
    layoutVersion: 'semantic-impact-v1',
    totals: {
      nodes: { total: 0, returned: 0, omitted: 0 },
      edges: { total: 0, returned: 0, omitted: 0 },
      evidence: { total: 0, returned: 0, omitted: 0 },
      changedFiles: { total: 1, returned: 0, omitted: 1 },
    },
    nodes: [],
    edges: [],
    evidence: [],
    anchors: [],
  },
}

function session(client: WsRpcProtocolClient): RpcSession
{
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  }
}

describe('project atlas environment atoms', () =>
{
  it('keys project atlas status subscriptions by environment and project', () =>
  {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry.EnvironmentRegistry | Crypto.Crypto,
      never
    >
    const atoms = createProjectEnvironmentAtoms(runtime)
    const target = {
      environmentId: TARGET.environmentId,
      input: { projectId: PROJECT_ID },
    }

    expect(atoms.projectAtlasStatus(target)).toBe(atoms.projectAtlasStatus({ ...target }))
    expect(
      atoms.projectAtlasStatus({
        environmentId: TARGET.environmentId,
        input: { projectId: ProjectId.make('project-2') },
      }),
    ).not.toBe(atoms.projectAtlasStatus(target))
    expect(
      atoms.projectAtlasStatus({
        environmentId: EnvironmentId.make('environment-2'),
        input: target.input,
      }),
    ).not.toBe(atoms.projectAtlasStatus(target))
  })

  it.effect('delivers the project atlas status stream through the environment atom', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const inputs: Array<{ readonly projectId: ProjectId }> = []
        const client = {
          [WS_METHODS.subscribeProjectAtlasStatus]: (input: { readonly projectId: ProjectId }) =>
            Stream.sync(() =>
            {
              inputs.push(input)
              return READY_STATUS
            }),
        } as unknown as WsRpcProtocolClient
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor['Service'])
        const followStream: EnvironmentRegistry.EnvironmentRegistry['Service']['followStream'] = (
          _environmentId,
          stream,
        ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor)
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          followStream,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry['Service'])
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        ) as unknown as Atom.AtomRuntime<
          EnvironmentRegistry.EnvironmentRegistry | Crypto.Crypto,
          never
        >
        const atoms = createProjectEnvironmentAtoms(runtime)
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        )
        const statuses: ProjectAtlasStatus[] = []
        registry.subscribe(
          atoms.projectAtlasStatus({
            environmentId: TARGET.environmentId,
            input: { projectId: PROJECT_ID },
          }),
          (result) =>
          {
            if (AsyncResult.isSuccess(result)) statuses.push(result.value)
          },
          { immediate: true },
        )

        for (let attempt = 0; attempt < 20 && statuses.length === 0; attempt += 1)
        {
          yield* TestClock.withLive(Effect.sleep('1 millis'))
        }

        expect(inputs).toEqual([{ projectId: PROJECT_ID }])
        expect(statuses).toEqual([READY_STATUS])
      }),
    ),
  )

  it.effect('routes exact Impact projection queries and revalidates them on remount', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const connectionState: SupervisorConnectionState = {
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: 'online',
          phase: 'connected',
          attempt: 1,
          generation: 1,
        }
        const inputs = new Array<{
          readonly version: 1
          readonly kind: 'resolve-plan'
          readonly threadId: typeof THREAD_ID
          readonly plan: typeof PLAN
        }>()
        const client = {
          [WS_METHODS.cartographerGetArchitectureImpactProjection]: (
            input: (typeof inputs)[number],
          ) =>
            Effect.sync(() =>
            {
              inputs.push(input)
              return IMPACT_RESULT
            }),
        } as unknown as WsRpcProtocolClient
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(connectionState),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor['Service'])
        const run: EnvironmentRegistry.EnvironmentRegistry['Service']['run'] = (
          _environmentId,
          effect,
        ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor)
        const followStream: EnvironmentRegistry.EnvironmentRegistry['Service']['followStream'] = (
          _environmentId,
          stream,
        ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor)
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
          followStream,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry['Service'])
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        ) as unknown as Atom.AtomRuntime<
          EnvironmentRegistry.EnvironmentRegistry | Crypto.Crypto,
          never
        >
        const atoms = createProjectEnvironmentAtoms(runtime)
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        )
        const impactAtom = atoms.getArchitectureImpactProjection({
          environmentId: TARGET.environmentId,
          input: {
            version: 1,
            kind: 'resolve-plan',
            threadId: THREAD_ID,
            plan: PLAN,
          },
        })
        const results: ArchitectureImpactProjectionResult[] = []
        const subscribe = () =>
          registry.subscribe(
            impactAtom,
            (result) =>
            {
              if (AsyncResult.isSuccess(result)) results.push(result.value)
            },
            { immediate: true },
          )

        const unsubscribeFirst = subscribe()
        for (let attempt = 0; attempt < 20 && inputs.length < 1; attempt += 1)
        {
          yield* TestClock.withLive(Effect.sleep('1 millis'))
        }
        unsubscribeFirst()

        const unsubscribeSecond = subscribe()
        for (let attempt = 0; attempt < 20 && inputs.length < 2; attempt += 1)
        {
          yield* TestClock.withLive(Effect.sleep('1 millis'))
        }
        unsubscribeSecond()

        expect(inputs).toEqual([
          {
            version: 1,
            kind: 'resolve-plan',
            threadId: THREAD_ID,
            plan: PLAN,
          },
          {
            version: 1,
            kind: 'resolve-plan',
            threadId: THREAD_ID,
            plan: PLAN,
          },
        ])
        expect(results.at(-1)).toBe(IMPACT_RESULT)
      }),
    ),
  )
})
