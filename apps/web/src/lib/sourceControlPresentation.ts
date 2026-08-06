// apps/web/src/lib/sourceControlPresentation.ts
// resolve source control presentation without view icons

import type { SourceControlProviderInfo } from '@t3tools/contracts'
export {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  formatChangeRequestAction,
  formatCreateChangeRequestPhrase,
  getChangeRequestTerminology,
  resolveChangeRequestPresentation,
  type ChangeRequestPresentation,
  type ChangeRequestTerminology,
} from '@t3tools/shared/sourceControl'
import {
  getChangeRequestTerminology,
  resolveChangeRequestPresentation,
  type ChangeRequestPresentation,
  type ChangeRequestTerminology,
} from '@t3tools/shared/sourceControl'

export type SourceControlIconKind = ChangeRequestPresentation['icon']

export interface SourceControlPresentation
{
  readonly providerName: string
  readonly terminology: ChangeRequestTerminology
  readonly icon: SourceControlIconKind
}

export function getSourceControlPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): SourceControlPresentation
{
  const presentation = resolveChangeRequestPresentation(provider)
  return {
    providerName: provider?.name || presentation.providerName,
    terminology: getChangeRequestTerminology(provider),
    icon: presentation.icon,
  }
}
