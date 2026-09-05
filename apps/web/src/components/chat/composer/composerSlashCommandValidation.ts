// apps/web/src/components/chat/composer/composerSlashCommandValidation.ts
// validates composer slash-command submission and reports unknown commands

import {
  isBareKnownProviderSlashCommand,
  parseBareProviderSlashCommand,
} from '@t3tools/shared/composerTrigger'
import { isUsageLimitsCommand, USAGE_LIMITS_COMMAND } from '@t3tools/shared/usageLimits'
import { findUnknownLeadingComposerSlashCommand } from '~/composer-logic'
import { toastManager } from '../../ui/toast'

export function shouldConfirmCompactComposerSlashCommand(input: {
  readonly text: string
  readonly providerSlashCommands: ReadonlyArray<{ readonly name: string }>
  readonly hasAttachmentsOrContext: boolean
}): boolean
{
  if (input.hasAttachmentsOrContext)
  {
    return false
  }
  return (
    parseBareProviderSlashCommand(input.text)?.toLowerCase() === 'compact' &&
    isBareKnownProviderSlashCommand(input.text, input.providerSlashCommands)
  )
}

export function blockUnknownComposerSlashCommand(
  text: string,
  providerSlashCommands: ReadonlyArray<{ readonly name: string }>,
): boolean
{
  const unknownCommand = findUnknownLeadingComposerSlashCommand(text, providerSlashCommands)
  if (unknownCommand === null)
  {
    return false
  }
  toastManager.add({
    type: 'warning',
    title: `Unknown slash command: /${unknownCommand}`,
    description: 'Choose a command from the slash menu.',
  })
  return true
}

export function shouldOpenUsageSettings(input: {
  readonly text: string
  readonly providerSlashCommands: ReadonlyArray<{ readonly name: string }>
  readonly hasNonPromptContent: boolean
}): boolean
{
  return (
    !input.hasNonPromptContent &&
    isUsageLimitsCommand(input.text) &&
    input.providerSlashCommands.some((command) => command.name === USAGE_LIMITS_COMMAND.name)
  )
}
