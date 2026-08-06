// apps/web/src/components/sourceControlIcons.ts
// map source-control icon kinds to react icon components

import { GitPullRequestIcon } from 'lucide-react'
import type { ElementType } from 'react'

import type { SourceControlIconKind } from '../lib/sourceControlPresentation'
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from './Icons'

export type SourceControlIcon = ElementType<{ className?: string }>

const SOURCE_CONTROL_ICONS: Record<SourceControlIconKind, SourceControlIcon> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  'azure-devops': AzureDevOpsIcon,
  bitbucket: BitbucketIcon,
  'change-request': GitPullRequestIcon,
}

export function resolveSourceControlIcon(icon: SourceControlIconKind): SourceControlIcon
{
  return SOURCE_CONTROL_ICONS[icon]
}
