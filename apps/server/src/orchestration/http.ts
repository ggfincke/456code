// apps/server/src/orchestration/http.ts
// serves authenticated orchestration http endpoints
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type ClientOrchestrationCommand,
  EnvironmentHttpApi,
  EnvironmentOrchestrationCommandUnsupportedError,
  type EnvironmentProjectCommandV1,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as HttpApiBuilder from 'effect/unstable/httpapi/HttpApiBuilder'

import { projectThreadDetailSnapshot } from './ActivityPayloadProjection.ts'
import { normalizeDispatchCommand } from './Normalizer.ts'
import { dispatchWithAttachmentLifecycle } from './dispatchWithAttachmentLifecycle.ts'
import {
  annotateEnvironmentRequest,
  currentEnvironmentTraceId,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from '../auth/http.ts'
import { OrchestrationEngineService } from './Services/OrchestrationEngine.ts'
import { ProjectionSnapshotQuery } from './Services/ProjectionSnapshotQuery.ts'

const isEnvironmentProjectCommand = (
  command: ClientOrchestrationCommand,
): command is EnvironmentProjectCommandV1 =>
  command.type === 'project.create' ||
  command.type === 'project.meta.update' ||
  command.type === 'project.delete'

const failEnvironmentUnsupportedCommand = (commandType: string) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentOrchestrationCommandUnsupportedError({
          code: 'unsupported_command',
          commandType,
          traceId,
        }),
      ),
    ),
  )

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  'orchestration',
  Effect.fnUntraced(function* (handlers)
  {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery
    const orchestrationEngine = yield* OrchestrationEngineService

    const dispatchProjectCommand = Effect.fn('environment.orchestration.dispatchProject')(
      function* (command: EnvironmentProjectCommandV1)
      {
        const normalizedCommand = yield* normalizeDispatchCommand(command).pipe(
          Effect.catch(() => failEnvironmentInvalidRequest('invalid_command')),
        )
        return yield* dispatchWithAttachmentLifecycle(
          normalizedCommand,
          orchestrationEngine.dispatch(normalizedCommand),
        ).pipe(
          Effect.catch((cause) => failEnvironmentInternal('orchestration_dispatch_failed', cause)),
        )
      },
    )

    return handlers
      .handle(
        'snapshot',
        Effect.fn('environment.orchestration.snapshot')(function* (args)
        {
          yield* annotateEnvironmentRequest(args.endpoint.name)
          yield* requireEnvironmentScope(AuthOrchestrationReadScope)
          return yield* projectionSnapshotQuery
            .getSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal('orchestration_snapshot_failed', cause),
              ),
            )
        }),
      )
      .handle(
        'shellSnapshot',
        Effect.fn('environment.orchestration.shellSnapshot')(function* (args)
        {
          yield* annotateEnvironmentRequest(args.endpoint.name)
          yield* requireEnvironmentScope(AuthOrchestrationReadScope)
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal('orchestration_snapshot_failed', cause),
              ),
            )
        }),
      )
      .handle(
        'threadSnapshot',
        Effect.fn('environment.orchestration.threadSnapshot')(function* (args)
        {
          yield* annotateEnvironmentRequest(args.endpoint.name)
          yield* requireEnvironmentScope(AuthOrchestrationReadScope)
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal('orchestration_thread_snapshot_failed', cause),
              ),
            )
          if (Option.isNone(snapshot))
          {
            return yield* failEnvironmentNotFound('thread_not_found')
          }
          return projectThreadDetailSnapshot(snapshot.value)
        }),
      )
      .handle(
        'dispatchProjectV1',
        Effect.fn('environment.orchestration.dispatchProjectV1')(function* (args)
        {
          yield* annotateEnvironmentRequest(args.endpoint.name)
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope)
          return yield* dispatchProjectCommand(args.payload)
        }),
      )
      .handle(
        'dispatch',
        Effect.fn('environment.orchestration.dispatch')(function* (args)
        {
          yield* annotateEnvironmentRequest(args.endpoint.name)
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope)
          if (!isEnvironmentProjectCommand(args.payload))
          {
            return yield* failEnvironmentUnsupportedCommand(args.payload.type)
          }
          return yield* dispatchProjectCommand(args.payload)
        }),
      )
  }),
)
