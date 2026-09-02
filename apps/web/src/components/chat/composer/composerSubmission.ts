// apps/web/src/components/chat/composer/composerSubmission.ts
// validate fully composed provider input before dispatch mutates chat state

import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from '@t3tools/contracts'
import { expandAssistantCitationsForProvider } from '@t3tools/shared/assistantCitations'

export function getProviderInputLengthValidationMessage(providerInput: string): string | null
{
  const normalizedInput = providerInput.trim()
  const inputLength = Math.max(
    normalizedInput.length,
    expandAssistantCitationsForProvider(normalizedInput).length,
  )
  const excessCharacters = inputLength - PROVIDER_SEND_TURN_MAX_INPUT_CHARS
  if (excessCharacters <= 0) return null

  const characterLabel = excessCharacters === 1 ? 'character' : 'characters'
  return `Prompt is ${excessCharacters.toLocaleString('en-US')} ${characterLabel} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString('en-US')}-character limit. Shorten or split it before sending.`
}
