// apps/server/src/orchestration/dispatchWithAttachmentLifecycle.ts
// records durable cleanup intent for unsuccessful normalized dispatches

import type { OrchestrationCommand } from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import type { PersistenceSqlError } from '../persistence/Errors.ts'
import { AttachmentLifecycleRepository } from '../persistence/Services/AttachmentLifecycle.ts'

export const dispatchWithAttachmentLifecycle = <A, E, R>(
  command: OrchestrationCommand,
  dispatch: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PersistenceSqlError, R | AttachmentLifecycleRepository> =>
  Effect.gen(function* ()
  {
    const attachmentLifecycle = yield* AttachmentLifecycleRepository
    return yield* dispatch.pipe(
      Effect.onExit((exit) =>
      {
        if (Exit.isSuccess(exit))
        {
          return Effect.void
        }
        const reason = Cause.hasInterruptsOnly(exit.cause)
          ? 'dispatch_interrupted'
          : 'dispatch_failed_or_rejected'
        return DateTime.now.pipe(
          Effect.flatMap((now) =>
            attachmentLifecycle.markDispatchFailure({
              commandId: command.commandId,
              reason,
              now: DateTime.formatIso(now),
            }),
          ),
        )
      }),
    )
  })
