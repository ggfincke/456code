// apps/server/src/orchestration/Services/AttachmentCleanupReactor.ts
// defines bounded durable attachment cleanup work

import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import type { PersistenceSqlError } from '../../persistence/Errors.ts'

export class AttachmentCleanupDeliveryError extends Schema.TaggedErrorClass<AttachmentCleanupDeliveryError>()(
  'AttachmentCleanupDeliveryError',
  {
    cleanupKey: Schema.String,
    message: Schema.String,
  },
)
{}

export interface AttachmentCleanupReactorShape
{
  readonly start: () => Effect.Effect<void, never, Scope.Scope>
  readonly drain: Effect.Effect<void, PersistenceSqlError>
}

export class AttachmentCleanupReactor extends Context.Service<
  AttachmentCleanupReactor,
  AttachmentCleanupReactorShape
>()('456code/orchestration/Services/AttachmentCleanupReactor')
{}
