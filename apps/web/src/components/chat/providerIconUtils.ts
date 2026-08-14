// apps/web/src/components/chat/providerIconUtils.ts
// provide provider icon by integration

import { ProviderDriverKind } from '@t3tools/contracts'
import { ClaudeAI, CoralIcon, CursorIcon, GrokIcon, Icon, OpenAI, OpenCodeIcon } from '../Icons'
import { PROVIDER_OPTIONS } from '../../session-logic'

export {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
  type ModelEsque,
} from '../../lib/modelDisplay'

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make('codex')]: OpenAI,
  [ProviderDriverKind.make('claudeAgent')]: ClaudeAI,
  [ProviderDriverKind.make('opencode')]: OpenCodeIcon,
  [ProviderDriverKind.make('cursor')]: CursorIcon,
  [ProviderDriverKind.make('grok')]: GrokIcon,
  [ProviderDriverKind.make('coral')]: CoralIcon,
}

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind
  label: string
  available: true
  pickerSidebarBadge?: 'new' | 'soon'
}
{
  return option.available
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption)
