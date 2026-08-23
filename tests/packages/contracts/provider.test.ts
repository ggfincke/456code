// tests/packages/contracts/provider.test.ts
// verifies provider capability defaults and runtime warning invariants

import { describe, expect, it } from 'vite-plus/test'
import * as Schema from 'effect/Schema'

import {
  ProviderRuntimeCapabilities,
  ProviderRuntimeModeWarning,
  ProviderSessionStartInput,
} from '../../../packages/contracts/src/provider.ts'

const decodeCapabilities = Schema.decodeUnknownSync(ProviderRuntimeCapabilities)
const decodeWarning = Schema.decodeUnknownSync(ProviderRuntimeModeWarning)
const decodeSessionStart = Schema.decodeUnknownSync(ProviderSessionStartInput)

describe('provider runtime capability contracts', () =>
{
  it('decodes legacy capabilities with safe defaults', () =>
  {
    const decoded = decodeCapabilities({
      supportedRuntimeModes: ['approval-required'],
    })
    expect(decoded).not.toHaveProperty('defaultRuntimeMode')
    expect(decoded).toMatchObject({
      runtimeModeWarnings: [],
      supportedAttachmentTypes: ['image'],
    })
  })

  it('rejects unsupported defaults and warning modes', () =>
  {
    expect(() =>
      decodeCapabilities({
        defaultRuntimeMode: 'full-access',
        supportedRuntimeModes: ['approval-required'],
      }),
    ).toThrow('Provider default runtime mode must be supported')

    expect(() =>
      decodeCapabilities({
        supportedRuntimeModes: ['approval-required'],
        runtimeModeWarnings: [
          {
            id: 'warning-1',
            mode: 'full-access',
            severity: 'danger',
            message: 'unsafe',
            requiresAcknowledgement: true,
          },
        ],
      }),
    ).toThrow('Provider runtime mode warning modes must be supported')
  })

  it('rejects duplicate warning ids and preserves warning fields', () =>
  {
    expect(() =>
      decodeCapabilities({
        supportedRuntimeModes: ['approval-required'],
        runtimeModeWarnings: [
          {
            id: 'warning-1',
            mode: 'approval-required',
            severity: 'warning',
            message: 'one',
            requiresAcknowledgement: false,
          },
          {
            id: 'warning-1',
            mode: 'approval-required',
            severity: 'danger',
            message: 'two',
            requiresAcknowledgement: true,
          },
        ],
      }),
    ).toThrow('Provider runtime mode warning ids must be unique')

    expect(
      decodeWarning({
        id: 'warning-1',
        mode: 'approval-required',
        severity: 'warning',
        message: 'display only',
        requiresAcknowledgement: false,
      }),
    ).toMatchObject({ requiresAcknowledgement: false })
  })

  it('decodes legacy session starts with an empty acknowledgement list', () =>
  {
    expect(
      decodeSessionStart({
        threadId: 'thread-1',
        provider: 'codex',
        providerInstanceId: 'codex',
        runtimeMode: 'full-access',
      }),
    ).toMatchObject({ runtimeModeAcknowledgements: [] })
  })
})
