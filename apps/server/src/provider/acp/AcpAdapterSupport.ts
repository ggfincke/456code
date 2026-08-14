// apps/server/src/provider/acp/AcpAdapterSupport.ts
// maps ACP outcomes and termination facts into adapter-level policy

import { type ProviderDriverKind, type ThreadId } from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import * as EffectAcpErrors from 'effect-acp/errors'

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from '../Errors.ts'
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError)
const isAcpInputStreamEndedError = Schema.is(EffectAcpErrors.AcpInputStreamEndedError)
const isAcpProtocolParseError = Schema.is(EffectAcpErrors.AcpProtocolParseError)
const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError)
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError)

export type AcpTerminationCause = EffectAcpErrors.AcpError | { readonly _tag: 'AdapterStop' }

export interface AcpTerminationClassification
{
  readonly finalization: 'graceful' | 'abnormal'
  readonly exitKind: 'graceful' | 'error'
  readonly reason: string
  readonly recoverable: false
}

export function classifyAcpTermination(cause: AcpTerminationCause): AcpTerminationClassification
{
  if (cause._tag === 'AdapterStop')
  {
    return {
      finalization: 'graceful',
      exitKind: 'graceful',
      reason: 'ACP session terminated',
      recoverable: false,
    }
  }
  if (isAcpInputStreamEndedError(cause))
  {
    return {
      finalization: 'graceful',
      exitKind: 'graceful',
      reason: 'ACP input stream ended',
      recoverable: false,
    }
  }
  if (isAcpProcessExitedError(cause))
  {
    if (cause.code === 0)
    {
      return {
        finalization: 'graceful',
        exitKind: 'graceful',
        reason: 'ACP process exited cleanly',
        recoverable: false,
      }
    }
    return {
      finalization: 'abnormal',
      exitKind: 'error',
      reason:
        cause.code === undefined
          ? 'ACP process exit status unavailable'
          : `ACP process exited with code ${cause.code}`,
      recoverable: false,
    }
  }
  if (isAcpProtocolParseError(cause))
  {
    return {
      finalization: 'abnormal',
      exitKind: 'error',
      reason: 'ACP protocol operation failed',
      recoverable: false,
    }
  }
  if (isAcpTransportError(cause))
  {
    return {
      finalization: 'abnormal',
      exitKind: 'error',
      reason:
        cause.operation === 'read-process-exit-status'
          ? 'ACP process exit status unavailable'
          : 'ACP transport operation failed',
      recoverable: false,
    }
  }
  return {
    finalization: 'abnormal',
    exitKind: 'error',
    reason: 'ACP session terminated',
    recoverable: false,
  }
}

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError
{
  if (isAcpProcessExitedError(error))
  {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    })
  }
  if (isAcpRequestError(error))
  {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    })
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  })
}
