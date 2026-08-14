// tests/packages/client-runtime/state/projectCommands.test.ts
// verifies native architecture command, query, and subscription atom boundaries

import {
  type ArchitectureGraphDiffResult,
  type ArchitectureImpactResult,
  ArchitectureGenerationId,
  ArchitectureGraphDigest,
  EnvironmentId,
  ProjectId,
  ProposalGenerationId,
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
const PROPOSAL_GENERATION_ID = ProposalGenerationId.make('proposal-generation-impact')
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
const IMPACT_RESULT: ArchitectureGraphDiffResult = {
  version: 1,
  summary: 'architecture impact ready',
  base: { generatedAt: '2026-08-09T12:00:00.000Z', gitRef: 'base-ref' },
  head: { generatedAt: '2026-08-09T12:00:01.000Z', gitRef: 'head-ref' },
  changed: true,
  addedNodes: { items: [], total: 0, omitted: 0 },
  removedNodes: { items: [], total: 0, omitted: 0 },
  addedEdges: { items: [], total: 0, omitted: 0 },
  removedEdges: { items: [], total: 0, omitted: 0 },
  movedNodes: { items: [], total: 0, omitted: 0 },
  moveFlows: { items: [], total: 0, omitted: 0 },
  movedEdges: 0,
  apiChanges: { items: [], total: 3, omitted: 3 },
  apiTotals: { files: 3, addedExports: 2, removedExports: 1, brokenConsumers: 4 },
  newViolations: { items: [], total: 0, omitted: 0 },
  resolvedViolations: { items: [], total: 0, omitted: 0 },
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

  it.effect('routes architecture impact queries and revalidates them on remount', () =>
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
          readonly threadId: typeof THREAD_ID
          readonly comparison: {
            readonly kind: 'proposal-generation'
            readonly generationId: typeof PROPOSAL_GENERATION_ID
          }
        }>()
        const client = {
          [WS_METHODS.cartographerGetArchitectureImpact]: (input: (typeof inputs)[number]) =>
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
        const impactAtom = atoms.getArchitectureImpact({
          environmentId: TARGET.environmentId,
          input: {
            threadId: THREAD_ID,
            comparison: {
              kind: 'proposal-generation',
              generationId: PROPOSAL_GENERATION_ID,
            },
          },
        })
        const results: ArchitectureImpactResult[] = []
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
            threadId: THREAD_ID,
            comparison: {
              kind: 'proposal-generation',
              generationId: PROPOSAL_GENERATION_ID,
            },
          },
          {
            threadId: THREAD_ID,
            comparison: {
              kind: 'proposal-generation',
              generationId: PROPOSAL_GENERATION_ID,
            },
          },
        ])
        expect(results.at(-1)).toBe(IMPACT_RESULT)
      }),
    ),
  )
})
