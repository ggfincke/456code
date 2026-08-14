// apps/server/src/recovery/http.ts
// serves authenticated runtime recovery diagnostics and audited retry actions

import {
  AuthOrchestrationReadScope,
  AuthOrchestrationRecoverScope,
  RuntimeRecoveryActionDeniedError,
  RuntimeRecoveryConflictError,
  RuntimeRecoveryHttpApi,
  RuntimeRecoveryInvalidCursorError,
  RuntimeRecoveryInternalError,
  RuntimeRecoveryNotFoundError,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/unstable/httpapi/HttpApiBuilder'

import {
  annotateEnvironmentRequest,
  currentEnvironmentTraceId,
  requireEnvironmentScope,
} from '../auth/http.ts'
import {
  RuntimeRecoveryAdmin,
  type RuntimeRecoveryAdminInvalidCursorError,
  type RuntimeRecoveryAdminInternalError,
  type RuntimeRecoveryAdminNotFoundError,
  type RuntimeRecoveryAdminStaleError,
} from './RuntimeRecoveryAdmin.ts'
import type { RuntimeRecoveryPolicyDeniedError } from './RuntimeRecoveryPolicy.ts'

export const requireRuntimeRecoveryMutationPrincipal = Effect.fn(
  'runtimeRecovery.requireMutationPrincipal',
)(function* ()
{
  return yield* requireEnvironmentScope(AuthOrchestrationRecoverScope)
})

const failNotFound = (error: RuntimeRecoveryAdminNotFoundError) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new RuntimeRecoveryNotFoundError({
          code: 'not_found',
          subjectKind: error.subjectKind,
          subjectId: error.subjectId,
          traceId,
        }),
      ),
    ),
  )

const failStale = (error: RuntimeRecoveryAdminStaleError) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new RuntimeRecoveryConflictError({
          code: 'stale_state',
          subjectKind: error.subjectKind,
          subjectId: error.subjectId,
          traceId,
        }),
      ),
    ),
  )

const failInvalidCursor = (error: RuntimeRecoveryAdminInvalidCursorError) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new RuntimeRecoveryInvalidCursorError({
          code: 'invalid_cursor',
          listKind: error.listKind,
          traceId,
        }),
      ),
    ),
  )

const failPolicyDenied = (error: RuntimeRecoveryPolicyDeniedError) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new RuntimeRecoveryActionDeniedError({
          code: 'action_denied',
          reason: error.reason,
          traceId,
        }),
      ),
    ),
  )

const failInternal = (error: RuntimeRecoveryAdminInternalError) =>
  Effect.gen(function* ()
  {
    const traceId = yield* currentEnvironmentTraceId
    yield* Effect.logError('runtime recovery operation failed', {
      operation: error.operation,
      traceId,
      cause: error.cause,
    })
    return yield* new RuntimeRecoveryInternalError({ code: 'internal_error', traceId })
  })

export const runtimeRecoveryHttpApiLayer = HttpApiBuilder.group(
  RuntimeRecoveryHttpApi,
  'recovery',
  Effect.fnUntraced(function* (handlers)
  {
    const recovery = yield* RuntimeRecoveryAdmin

    return handlers
      .handle(
        'listReactorActions',
        Effect.fn('runtimeRecovery.listReactorActions')(function* (args)
        {
          yield* annotateEnvironmentRequest(args.endpoint.name)
          yield* requireEnvironmentScope(AuthOrchestrationReadScope)
          return yield* recovery
            .listReactorActions(
              args.query.cursor === undefined ? {} : { cursor: args.query.cursor },
            )
            .pipe(
              Effect.catchTags({
                RuntimeRecoveryAdminInvalidCursorError: failInvalidCursor,
                RuntimeRecoveryAdminInternalError: failInternal,
              }),
            )
        }),
      )
      .handle(
        'getReactorAction',
        Effect.fn('runtimeRecovery.getReactorAction')(function* (args)
        {
          yield* annotateEnvironmentRequest(args.endpoint.name)
          yield* requireEnvironmentScope(AuthOrchestrationReadScope)
          return yield* recovery.getReactorAction(args.params.actionId).pipe(
            Effect.catchTags({
              RuntimeRecoveryAdminNotFoundError: failNotFound,
              RuntimeRecoveryAdminInternalError: failInternal,
            }),
          )
        }),
      )
      .handle(
        'recoverReactorAction',
        Effect.fn('runtimeRecovery.recoverReactorAction')(function* (args)
        {
          yield* annotateEnvironmentRequest(args.endpoint.name)
          const actor = yield* requireRuntimeRecoveryMutationPrincipal()
          return yield* recovery
            .recoverReactorAction({
              actionId: args.params.actionId,
              mutation: args.payload,
              actor: {
                sessionId: actor.sessionId,
                subject: actor.subject,
              },
            })
            .pipe(
              Effect.catchTags({
                RuntimeRecoveryAdminNotFoundError: failNotFound,
                RuntimeRecoveryAdminStaleError: failStale,
                RuntimeRecoveryPolicyDeniedError: failPolicyDenied,
                RuntimeRecoveryAdminInternalError: failInternal,
              }),
            )
        }),
      )
      .handle(
        'listCheckpointReverts',
        Effect.fn('runtimeRecovery.listCheckpointReverts')(function* (args)
        {
          yield* annotateEnvironmentRequest(args.endpoint.name)
          yield* requireEnvironmentScope(AuthOrchestrationReadScope)
          return yield* recovery
            .listCheckpointReverts(
              args.query.cursor === undefined ? {} : { cursor: args.query.cursor },
            )
            .pipe(
              Effect.catchTags({
                RuntimeRecoveryAdminInvalidCursorError: failInvalidCursor,
                RuntimeRecoveryAdminInternalError: failInternal,
              }),
            )
        }),
      )
      .handle(
        'getCheckpointRevert',
        Effect.fn('runtimeRecovery.getCheckpointRevert')(function* (args)
        {
          yield* annotateEnvironmentRequest(args.endpoint.name)
          yield* requireEnvironmentScope(AuthOrchestrationReadScope)
          return yield* recovery.getCheckpointRevert(args.params.operationId).pipe(
            Effect.catchTags({
              RuntimeRecoveryAdminNotFoundError: failNotFound,
              RuntimeRecoveryAdminInternalError: failInternal,
            }),
          )
        }),
      )
  }),
)
