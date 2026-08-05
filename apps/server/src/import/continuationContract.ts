// apps/server/src/import/continuationContract.ts
// defines the stable continuation binding seam used by transcript imports

import type {
  ModelSelection,
  ProviderInstanceId,
  ThreadId,
  ThreadImportContinuation,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import type { ImportedSessionMeta } from './types.ts'

export type ContinuationOutcome = ThreadImportContinuation

export const IMPORT_CONTINUATION_PRESERVED_BINDING_REASON =
  'the thread already has a newer or different provider binding; that binding was preserved'

export interface ContinuationRequest
{
  readonly threadId: ThreadId
  readonly meta: ImportedSessionMeta
  readonly providerInstanceId: ProviderInstanceId
  readonly modelSelection: ModelSelection
  readonly runtimeMode: 'approval-required'
}

export class ImportContinuationDeps extends Context.Service<
  ImportContinuationDeps,
  {
    readonly bind: (request: ContinuationRequest) => Effect.Effect<ContinuationOutcome>
  }
>()('456code/import/continuationContract/ImportContinuationDeps')
{}

export const bindImportedContinuation = Effect.fn('bindImportedContinuation')(function* (
  request: ContinuationRequest,
)
{
  const deps = yield* ImportContinuationDeps
  return yield* deps.bind(request)
})

export const ImportContinuationDepsUnbound = Layer.succeed(
  ImportContinuationDeps,
  ImportContinuationDeps.of({
    bind: (request) =>
      Effect.succeed({
        state: 'history-only',
        providerInstanceId: request.providerInstanceId,
        continuationIdentity: null,
        reason: 'continuation module not wired',
      }),
  }),
)
