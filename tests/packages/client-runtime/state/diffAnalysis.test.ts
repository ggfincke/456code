// tests/packages/client-runtime/state/diffAnalysis.test.ts
// verifies normalized diff-analysis identity and command admission

import {
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type DiffAnalysisGeneration,
  type DiffAnalysisSource,
} from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import { AsyncResult, Atom, AtomRegistry } from 'effect/unstable/reactivity'

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from '../../../../packages/client-runtime/src/connection/model.ts'
import * as EnvironmentRegistry from '../../../../packages/client-runtime/src/connection/registry.ts'
import * as EnvironmentSupervisor from '../../../../packages/client-runtime/src/connection/supervisor.ts'
import type { WsRpcProtocolClient } from '../../../../packages/client-runtime/src/rpc/protocol.ts'
import type { RpcSession } from '../../../../packages/client-runtime/src/rpc/session.ts'
import {
  createDiffAnalysisEnvironmentAtoms,
  diffAnalysisGenerationKey,
  diffAnalysisSourceKey,
  diffAnalysisTargetKey,
  normalizeDiffAnalysisSource,
  shouldPollDiffAnalysisGeneration,
} from '../../../../packages/client-runtime/src/state/workspace/diffAnalysis.ts'

const ENVIRONMENT_ID = EnvironmentId.make('environment-1')
const OWNER = { threadId: ThreadId.make('thread-1') } as const
const CONNECTION_TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: 'Test environment',
  httpBaseUrl: 'https://environment.example.test',
  wsBaseUrl: 'wss://environment.example.test',
})

const REVIEW_SOURCE = {
  sourceKind: 'review' as const,
  cwd: '/repo',
  kind: 'branch-range',
  baseRef: 'origin/main',
} satisfies DiffAnalysisSource

const GENERATION = {
  diffAnalysisId: 'diff-analysis-1',
  state: 'queued',
} as unknown as DiffAnalysisGeneration

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

describe('diff analysis identity', () =>
{
  it('normalizes only semantic source fields into stable target keys', () =>
  {
    const normalized = normalizeDiffAnalysisSource({
      sourceKind: 'review' as const,
      cwd: ' /repo ',
      kind: 'branch-range',
      baseRef: ' origin/main ',
      sourceId: 'preview-source-1',
      patch: 'diff --git a/file b/file',
      truncated: true,
      ignoreWhitespace: true,
    } as unknown as DiffAnalysisSource)

    expect(normalized).toEqual(REVIEW_SOURCE)
    expect(diffAnalysisSourceKey(normalized)).toBe(diffAnalysisSourceKey(REVIEW_SOURCE))
    expect(
      diffAnalysisTargetKey({
        environmentId: ENVIRONMENT_ID,
        input: { owner: OWNER, source: normalized },
      }),
    ).toBe(
      diffAnalysisTargetKey({
        environmentId: ENVIRONMENT_ID,
        input: { owner: OWNER, source: REVIEW_SOURCE },
      }),
    )
    expect(
      diffAnalysisTargetKey({
        environmentId: ENVIRONMENT_ID,
        input: {
          owner: { threadId: ThreadId.make('thread-2') },
          source: REVIEW_SOURCE,
        },
      }),
    ).not.toBe(
      diffAnalysisTargetKey({
        environmentId: ENVIRONMENT_ID,
        input: { owner: OWNER, source: REVIEW_SOURCE },
      }),
    )
  })

  it('keys an immutable commit pair by both exact commit OIDs', () =>
  {
    const source = normalizeDiffAnalysisSource({
      sourceKind: 'commit-pair',
      cwd: ' /repo ',
      baseCommitOid: 'A'.repeat(40),
      headCommitOid: 'B'.repeat(40),
    })

    expect(source).toEqual({
      sourceKind: 'commit-pair',
      cwd: '/repo',
      baseCommitOid: 'a'.repeat(40),
      headCommitOid: 'b'.repeat(40),
    })
    if (source.sourceKind !== 'commit-pair')
    {
      throw new Error('expected a normalized commit-pair source')
    }
    expect(diffAnalysisSourceKey(source)).not.toBe(
      diffAnalysisSourceKey({
        ...source,
        headCommitOid: 'c'.repeat(40),
      }),
    )
  })

  it('keys retained analysis generations by target and generation', () =>
  {
    const target = {
      environmentId: ENVIRONMENT_ID,
      input: { owner: OWNER, source: REVIEW_SOURCE },
    }
    const firstKey = diffAnalysisGenerationKey({ ...target, generation: GENERATION })
    const nextKey = diffAnalysisGenerationKey({
      ...target,
      generation: {
        ...GENERATION,
        diffAnalysisId: 'diff-analysis-2',
      } as unknown as DiffAnalysisGeneration,
    })
    const otherOwnerKey = diffAnalysisGenerationKey({
      ...target,
      input: {
        owner: { threadId: ThreadId.make('thread-2') },
        source: REVIEW_SOURCE,
      },
      generation: GENERATION,
    })

    expect(nextKey).not.toBe(firstKey)
    expect(otherOwnerKey).not.toBe(firstKey)
  })

  it.each([
    [{ ...GENERATION, state: 'analyzing' as const }, true],
    [{ ...GENERATION, state: 'ready' as const }, false],
    [null, true],
  ] as const)('polls only non-terminal generations (%j -> %s)', (generation, expected) =>
  {
    expect(shouldPollDiffAnalysisGeneration(generation)).toBe(expected)
  })

  it('canonicalizes target-identity read atoms', () =>
  {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry.EnvironmentRegistry,
      never
    >
    const atoms = createDiffAnalysisEnvironmentAtoms(runtime)
    const canonical = {
      environmentId: ENVIRONMENT_ID,
      input: { owner: OWNER, source: REVIEW_SOURCE },
    }
    const padded = {
      environmentId: ENVIRONMENT_ID,
      input: {
        owner: OWNER,
        source: {
          sourceKind: 'review' as const,
          cwd: ' /repo ',
          kind: 'branch-range' as const,
          baseRef: ' origin/main ',
        },
      },
    }

    expect(atoms.getDiffAnalysis(padded)).toBe(atoms.getDiffAnalysis(canonical))
  })
})

describe('diff analysis commands', () =>
{
  it.effect('shares one active request for equivalent normalized targets', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        let requestCount = 0
        let releaseRequest: () => void = () => undefined
        const requestGate = new Promise<void>((resolve) =>
        {
          releaseRequest = () => resolve()
        })
        const receivedInputs: Array<{
          readonly owner: typeof OWNER
          readonly source: DiffAnalysisSource
        }> = []
        const client = {
          [WS_METHODS.cartographerRequestDiffAnalysis]: (input: {
            readonly owner: typeof OWNER
            readonly source: DiffAnalysisSource
          }) =>
          {
            requestCount += 1
            receivedInputs.push(input)
            return Effect.promise(() => requestGate).pipe(Effect.as(GENERATION))
          },
        } as unknown as WsRpcProtocolClient
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: CONNECTION_TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
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
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry['Service'])
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        )
        const atoms = createDiffAnalysisEnvironmentAtoms(runtime)
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        )
        const first = atoms.requestDiffAnalysis.run(registry, {
          environmentId: ENVIRONMENT_ID,
          input: { owner: OWNER, source: REVIEW_SOURCE },
        })
        const second = atoms.requestDiffAnalysis.run(registry, {
          environmentId: ENVIRONMENT_ID,
          input: {
            owner: OWNER,
            source: {
              sourceKind: 'review' as const,
              cwd: ' /repo ',
              kind: 'branch-range',
              baseRef: ' origin/main ',
            },
          },
        })

        releaseRequest()
        const results = yield* Effect.promise(() => Promise.all([first, second]))

        expect(results.every(AsyncResult.isSuccess)).toBe(true)
        expect(requestCount).toBe(1)
        expect(receivedInputs).toEqual([{ owner: OWNER, source: REVIEW_SOURCE }])
      }),
    ),
  )
})
