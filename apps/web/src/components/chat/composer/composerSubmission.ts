// apps/web/src/components/chat/composer/composerSubmission.ts
// validate fully composed provider input before dispatch mutates chat state

import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from '@t3tools/contracts'

export function getProviderInputLengthValidationMessage(providerInput: string): string | null
{
  const excessCharacters = providerInput.trim().length - PROVIDER_SEND_TURN_MAX_INPUT_CHARS
  if (excessCharacters <= 0) return null

  const characterLabel = excessCharacters === 1 ? 'character' : 'characters'
  return `Prompt is ${excessCharacters.toLocaleString('en-US')} ${characterLabel} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString('en-US')}-character limit. Shorten or split it before sending.`
}
