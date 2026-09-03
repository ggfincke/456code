// packages/contracts/src/providerSetup.ts
// define provider installation and private authentication flow contracts

import * as Schema from 'effect/Schema'

import { IsoDateTime, TrimmedNonEmptyString } from './baseSchemas.ts'
import { ProviderDriverKind, ProviderInstanceId } from './providerInstance.ts'

export const ProviderSetupInput = Schema.Struct({
  instanceId: ProviderInstanceId,
})
export type ProviderSetupInput = typeof ProviderSetupInput.Type

export const ProviderSetupOperationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128))
export type ProviderSetupOperationId = typeof ProviderSetupOperationId.Type

// this state is private to the authenticated client session that started the flow.
// shared provider snapshots expose only ServerProvider.auth.
export const ProviderAuthFlowState = Schema.Struct({
  instanceId: ProviderInstanceId,
  phase: Schema.Literals([
    'idle',
    'starting',
    'waiting',
    'verifying',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  flowId: Schema.NullOr(ProviderSetupOperationId),
  authorizationUrl: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_384))),
  expiresAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(Schema.String),
})
export type ProviderAuthFlowState = typeof ProviderAuthFlowState.Type

// internal server code uses the shorter name while the RPC surface emphasizes
// that authorization details are flow-scoped and private.
export const ProviderAuthState = ProviderAuthFlowState
export type ProviderAuthState = ProviderAuthFlowState

export const ProviderAuthFlowInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: ProviderSetupOperationId,
})
export type ProviderAuthFlowInput = typeof ProviderAuthFlowInput.Type

export const ProviderAuthCompleteInput = Schema.Struct({
  ...ProviderAuthFlowInput.fields,
  callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
})
export type ProviderAuthCompleteInput = typeof ProviderAuthCompleteInput.Type

export const ProviderAuthLogoutResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  signedOut: Schema.Literal(true),
  message: Schema.NullOr(Schema.String),
})
export type ProviderAuthLogoutResult = typeof ProviderAuthLogoutResult.Type

const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ProviderInstallState = Schema.Struct({
  driver: ProviderDriverKind,
  operationId: Schema.NullOr(ProviderSetupOperationId),
  phase: Schema.Literals([
    'idle',
    'downloading',
    'extracting',
    'verifying',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  downloadedBytes: ByteCount,
  totalBytes: Schema.NullOr(ByteCount),
  version: Schema.NullOr(TrimmedNonEmptyString),
  installedVersion: Schema.NullOr(TrimmedNonEmptyString),
  canRemove: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
})
export type ProviderInstallState = typeof ProviderInstallState.Type

export const ProviderInstallCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  operationId: ProviderSetupOperationId,
})
export type ProviderInstallCancelInput = typeof ProviderInstallCancelInput.Type

// wire failures carry only reviewed user-facing text. Native errors, URLs, callback
// values, and credential material are redacted before local diagnostics too.
export class ProviderSetupError extends Schema.TaggedError<ProviderSetupError>()(
  'ProviderSetupError',
  {
    instanceId: ProviderInstanceId,
    operation: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  },
)
{
  override get message(): string
  {
    return this.detail
  }
}
