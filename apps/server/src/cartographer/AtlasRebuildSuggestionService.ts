// apps/server/src/cartographer/AtlasRebuildSuggestionService.ts
// debounces retained project atlas turn and authoring rebuild suggestions

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from 'node:fs'

import {
  type CartographerError,
  type OrchestrationEvent,
  type ProjectId,
  type ThreadId,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import * as OrchestrationEngine from '../orchestration/Services/OrchestrationEngine.ts'
import * as ProjectionSnapshotQuery from '../orchestration/Services/ProjectionSnapshotQuery.ts'
import * as ProjectArchitectureLifecycleService from './ProjectArchitectureLifecycleService.ts'

// watcher start failures are logged and swallowed; the tag keeps the channel typed
class AtlasWatcherStartError extends Data.TaggedError('AtlasWatcherStartError')<{
  readonly cause: unknown
}>
{}

export const PROJECT_ATLAS_REBUILD_DEBOUNCE_MS = 300
const RECENT_TURN_ID_CAP = 64
const AUTHORING_FILENAMES = new Set(['.cartographer.json', '.cartographer.annotations.json'])

export interface ProjectAuthoringWatcher
{
  readonly close: () => void
}

// injected factory keeps fs.watch lifecycle tests deterministic
export type ProjectAuthoringWatcherFactory = (
  root: string,
  onChange: (filename: string | null) => void,
) => ProjectAuthoringWatcher

export interface AtlasRebuildSuggestionServiceShape
{
  readonly start: () => Effect.Effect<void, never, Scope.Scope>
}

export class AtlasRebuildSuggestionService extends Context.Service<
  AtlasRebuildSuggestionService,
  AtlasRebuildSuggestionServiceShape
>()('456code/cartographer/AtlasRebuildSuggestionService')
{}

export interface AtlasRebuildSuggestionOptions
{
  readonly events: Stream.Stream<OrchestrationEvent>
  readonly resolveProjectId: (threadId: ThreadId) => Effect.Effect<ProjectId | null>
  readonly hasRetainedProjectContext: (projectId: ProjectId) => Effect.Effect<boolean>
  readonly requestRebuild: (projectId: ProjectId) => Effect.Effect<void, CartographerError>
  readonly retentionChanges?: Stream.Stream<ProjectArchitectureLifecycleService.ProjectArchitectureRetentionChange>
  readonly watchProjectRoot?: ProjectAuthoringWatcherFactory
  readonly debounceMs?: number
}

const watchProjectRoot: ProjectAuthoringWatcherFactory = (root, onChange) =>
  NodeFS.watch(root, { recursive: false }, (_eventType, filename) =>
  {
    const name = typeof filename === 'string' ? filename : null
    onChange(name)
  })

export const make = (
  options: AtlasRebuildSuggestionOptions,
): AtlasRebuildSuggestionServiceShape =>
{
  const pending = new Map<
    ProjectId,
    { readonly token: object; readonly fiber: Fiber.Fiber<void, never> }
  >()
  const recentTurnIds = new Map<ProjectId, Map<string, true>>()
  const watchers = new Map<
    ProjectId,
    { readonly root: string; readonly watcher: ProjectAuthoringWatcher }
  >()
  const debounceMs = options.debounceMs ?? PROJECT_ATLAS_REBUILD_DEBOUNCE_MS
  let serviceScope: Scope.Scope | null = null
  let runSchedule: ((projectId: ProjectId) => void) | null = null

  const rememberTurn = (projectId: ProjectId, turnId: string): boolean =>
  {
    let recent = recentTurnIds.get(projectId)
    if (recent === undefined)
    {
      recent = new Map()
      recentTurnIds.set(projectId, recent)
    }
    if (recent.has(turnId))
    {
      recent.delete(turnId)
      recent.set(turnId, true)
      return false
    }
    recent.set(turnId, true)
    if (recent.size > RECENT_TURN_ID_CAP)
    {
      const oldest = recent.keys().next().value
      if (oldest !== undefined) recent.delete(oldest)
    }
    return true
  }

  const schedule = Effect.fn('AtlasRebuildSuggestionService.schedule')(function* (
    projectId: ProjectId,
  )
  {
    const previous = pending.get(projectId)
    if (previous !== undefined) yield* Fiber.interrupt(previous.fiber).pipe(Effect.ignore)
    const token = {}
    if (serviceScope === null) return
    const fiber = yield* Effect.forkIn(
      Effect.sleep(debounceMs).pipe(
        Effect.andThen(
          options
            .hasRetainedProjectContext(projectId)
            .pipe(
              Effect.flatMap((retained) =>
                Effect.suspend(() => (retained ? options.requestRebuild(projectId) : Effect.void)),
              ),
            ),
        ),
        Effect.catch((cause) =>
          Effect.logWarning('Project Atlas rebuild suggestion failed', { cause, projectId }),
        ),
        Effect.ensuring(
          Effect.sync(() =>
          {
            if (pending.get(projectId)?.token === token) pending.delete(projectId)
          }),
        ),
      ),
      serviceScope,
    )
    pending.set(projectId, { token, fiber })
  })

  // v1 intentionally excludes thread.session-set; ready turn diffs are the sole trigger
  const consume = options.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* ()
      {
        if (event.type !== 'thread.turn-diff-completed' || event.payload.status !== 'ready')
        {
          return
        }
        const projectId = yield* options.resolveProjectId(event.payload.threadId)
        if (projectId === null) return
        if (!(yield* options.hasRetainedProjectContext(projectId))) return
        if (!rememberTurn(projectId, event.payload.turnId)) return
        yield* schedule(projectId)
      }),
    ),
  )

  const consumeRetention = (options.retentionChanges ?? Stream.empty).pipe(
    Stream.runForEach((change) =>
      Effect.gen(function* ()
      {
        const existing = watchers.get(change.projectId)
        if (!change.retained || change.root === null)
        {
          existing?.watcher.close()
          watchers.delete(change.projectId)
          recentTurnIds.delete(change.projectId)
          return
        }
        if (existing?.root === change.root) return
        const root = change.root
        existing?.watcher.close()
        // the cached entry is dropped before the replacement is attempted; leaving the closed
        // watcher behind would let the root-identity check above skip re-watching forever
        watchers.delete(change.projectId)
        const created = yield* Effect.try({
          try: () =>
            (options.watchProjectRoot ?? watchProjectRoot)(root, (filename) =>
            {
              if (filename !== null && AUTHORING_FILENAMES.has(filename))
              {
                runSchedule?.(change.projectId)
              }
            }),
          catch: (cause) => new AtlasWatcherStartError({ cause }),
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning('Project Atlas authoring watcher failed', {
              cause,
              projectId: change.projectId,
              root,
            }).pipe(Effect.as(null)),
          ),
        )
        if (created !== null)
        {
          watchers.set(change.projectId, { root, watcher: created })
        }
      }),
    ),
  )

  const start = Effect.fn('AtlasRebuildSuggestionService.start')(function* ()
  {
    serviceScope = yield* Scope.Scope
    const context = yield* Effect.context<never>()
    const runFork = Effect.runForkWith(context)
    runSchedule = (projectId) =>
    {
      runFork(schedule(projectId))
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() =>
      {
        for (const entry of watchers.values()) entry.watcher.close()
        watchers.clear()
        serviceScope = null
        runSchedule = null
      }),
    )
    yield* Effect.forkScoped(consume)
    yield* Effect.forkScoped(consumeRetention)
  })

  return {
    start,
  }
}

export const layer = Layer.effect(
  AtlasRebuildSuggestionService,
  Effect.gen(function* ()
  {
    const engine = yield* OrchestrationEngine.OrchestrationEngineService
    const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
    const lifecycle = yield* ProjectArchitectureLifecycleService.ProjectArchitectureLifecycleService
    return make({
      events: engine.streamDomainEvents,
      resolveProjectId: (threadId) =>
        projection.getThreadShellById(threadId).pipe(
          Effect.map((thread) => (Option.isSome(thread) ? thread.value.projectId : null)),
          Effect.catch((cause) =>
            Effect.logWarning('Project Atlas thread lookup failed', { cause, threadId }).pipe(
              Effect.as(null),
            ),
          ),
        ),
      hasRetainedProjectContext: lifecycle.hasRetainedProjectContext,
      retentionChanges: lifecycle.projectRetentionChanges,
      requestRebuild: (projectId) =>
        Effect.gen(function* ()
        {
          const snapshot = yield* lifecycle.getProjectSnapshot(projectId)
          if (snapshot === null) return
          yield* lifecycle.rebuildProject({ projectId, workspaceRoot: snapshot.root })
        }),
    })
  }),
)
