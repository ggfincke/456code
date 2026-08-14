// tests/apps/web/components/chat/composer/runtimeModeForSend.test.ts
// send must coerce draft DEFAULT_RUNTIME_MODE before Coral startSession
import { describe, expect, it } from 'vite-plus/test'

import { DEFAULT_RUNTIME_MODE } from '@t3tools/contracts'

import { runtimeModeForSend } from '../../../../../../apps/web/src/components/chat/composer/chatComposerHandle'

describe('runtimeModeForSend', () =>
{
  it('coerces Coral draft full-access to approval-required at send', () =>
  {
    expect(DEFAULT_RUNTIME_MODE).toBe('full-access')
    expect(runtimeModeForSend(DEFAULT_RUNTIME_MODE, ['approval-required'])).toBe(
      'approval-required',
    )
  })

  it('keeps a requested mode that the provider advertises', () =>
  {
    expect(runtimeModeForSend('full-access', ['approval-required', 'full-access'])).toBe(
      'full-access',
    )
  })

  it('keeps the draft when the provider does not advertise modes', () =>
  {
    expect(runtimeModeForSend('full-access', undefined)).toBe('full-access')
    expect(runtimeModeForSend('full-access', [])).toBe('full-access')
  })
})
