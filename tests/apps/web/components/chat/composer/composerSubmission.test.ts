// tests/apps/web/components/chat/composer/composerSubmission.test.ts
// verifies final provider input length validation at the wire contract boundary

import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { getProviderInputLengthValidationMessage } from '../../../../../../apps/web/src/components/chat/composer/composerSubmission'

describe('getProviderInputLengthValidationMessage', () =>
{
  it('allows provider input at the exact wire limit', () =>
  {
    expect(
      getProviderInputLengthValidationMessage('x'.repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    ).toBeNull()
  })

  it('reports how far fully composed provider input exceeds the wire limit', () =>
  {
    const providerInput = `${'x'.repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)}context`

    expect(getProviderInputLengthValidationMessage(providerInput)).toBe(
      'Prompt is 7 characters over the 120,000-character limit. Shorten or split it before sending.',
    )
  })
})
