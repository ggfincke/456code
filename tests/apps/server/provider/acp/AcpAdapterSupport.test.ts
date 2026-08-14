// tests/apps/server/provider/acp/AcpAdapterSupport.test.ts
// verifies ACP adapter error, permission, and termination mapping

import { describe, expect, it } from 'vite-plus/test'
import * as EffectAcpErrors from 'effect-acp/errors'
import { ProviderDriverKind } from '@t3tools/contracts'

import {
  classifyAcpTermination,
  mapAcpToAdapterError,
} from '../../../../../apps/server/src/provider/acp/AcpAdapterSupport.ts'

describe('AcpAdapterSupport', () =>
{
  it('maps ACP request errors to provider adapter request errors', () =>
  {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make('cursor'),
      'thread-1' as never,
      'session/prompt',
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: 'Invalid params',
      }),
    )

    expect(error._tag).toBe('ProviderAdapterRequestError')
    expect(error.message).toContain('Invalid params')
  })

  it('classifies ACP process and protocol termination with canonical reasons', () =>
  {
    expect(classifyAcpTermination({ _tag: 'AdapterStop' })).toEqual({
      finalization: 'graceful',
      exitKind: 'graceful',
      reason: 'ACP session terminated',
      recoverable: false,
    })
    expect(classifyAcpTermination(new EffectAcpErrors.AcpInputStreamEndedError({}))).toEqual({
      finalization: 'graceful',
      exitKind: 'graceful',
      reason: 'ACP input stream ended',
      recoverable: false,
    })
    expect(classifyAcpTermination(new EffectAcpErrors.AcpProcessExitedError({ code: 0 }))).toEqual({
      finalization: 'graceful',
      exitKind: 'graceful',
      reason: 'ACP process exited cleanly',
      recoverable: false,
    })
    expect(classifyAcpTermination(new EffectAcpErrors.AcpProcessExitedError({ code: 9 }))).toEqual({
      finalization: 'abnormal',
      exitKind: 'error',
      reason: 'ACP process exited with code 9',
      recoverable: false,
    })
    expect(classifyAcpTermination(new EffectAcpErrors.AcpProcessExitedError({})).reason).toBe(
      'ACP process exit status unavailable',
    )
    expect(
      classifyAcpTermination(
        new EffectAcpErrors.AcpProtocolParseError({
          operation: 'decode-wire-message',
          cause: new Error('invalid JSON'),
        }),
      ),
    ).toEqual({
      finalization: 'abnormal',
      exitKind: 'error',
      reason: 'ACP protocol operation failed',
      recoverable: false,
    })
  })

  it('maps unavailable exit status separately from other transport failures', () =>
  {
    expect(
      classifyAcpTermination(
        new EffectAcpErrors.AcpTransportError({
          operation: 'read-process-exit-status',
          cause: new Error('missing status'),
        }),
      ).reason,
    ).toBe('ACP process exit status unavailable')
    expect(
      classifyAcpTermination(
        new EffectAcpErrors.AcpTransportError({
          operation: 'read-input-stream',
          cause: new Error('broken pipe'),
        }),
      ).reason,
    ).toBe('ACP transport operation failed')
  })
})
