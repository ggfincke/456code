// apps/web/src/components/git-actions/actionChrome.tsx
// render git action menu icons and disabled-reason / progress copy

import type { VcsStatusResult } from '@t3tools/contracts'
import { CloudUploadIcon, GitCommitIcon, InfoIcon } from 'lucide-react'

import { getSourceControlPresentation } from '~/lib/sourceControlPresentation'
import {
  type GitActionIconName,
  type GitActionMenuItem,
  type GitQuickAction,
} from '../GitActionsControl.logic'
import { type SourceControlIcon as SourceControlIconComponent } from '../sourceControlIcons'
import { type ThreadToastData } from '~/components/ui/toast'
import { toastManager } from '~/components/ui/toast'

export type GitActionToastId = ReturnType<typeof toastManager.add>

export interface ActiveGitActionProgress
{
  toastId: GitActionToastId
  toastData: ThreadToastData | undefined
  actionId: string
  title: string
  phaseStartedAtMs: number | null
  hookStartedAtMs: number | null
  hookName: string | null
  lastOutputLine: string | null
  currentPhaseLabel: string | null
}

export function formatElapsedDescription(startedAtMs: number | null): string | undefined
{
  if (startedAtMs === null)
  {
    return undefined
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
  if (elapsedSeconds < 60)
  {
    return `Running for ${elapsedSeconds}s`
  }
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  return `Running for ${minutes}m ${seconds}s`
}

export function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined
{
  if (progress.lastOutputLine)
  {
    return progress.lastOutputLine
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs)
}

export function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasPrimaryRemote,
}: {
  item: GitActionMenuItem
  gitStatus: VcsStatusResult | null
  isBusy: boolean
  hasPrimaryRemote: boolean
}): string | null
{
  if (!item.disabled) return null
  if (isBusy) return 'Git action in progress.'
  if (!gitStatus) return 'Git status is unavailable.'

  const hasBranch = gitStatus.refName !== null
  const hasChanges = gitStatus.hasWorkingTreeChanges
  const hasOpenPr = gitStatus.pr?.state === 'open'
  const isAhead = gitStatus.aheadCount > 0
  const isBehind = gitStatus.behindCount > 0
  const terminology = getSourceControlPresentation(gitStatus.sourceControlProvider).terminology

  if (item.id === 'commit')
  {
    if (!hasChanges)
    {
      return 'Worktree is clean. Make changes before committing.'
    }
    return 'Commit is currently unavailable.'
  }

  if (item.id === 'push')
  {
    if (!hasBranch)
    {
      return 'Detached HEAD: checkout a refName before pushing.'
    }
    if (hasChanges)
    {
      return 'Commit or stash local changes before pushing.'
    }
    if (isBehind)
    {
      return 'Branch is behind upstream. Pull/rebase before pushing.'
    }
    if (!gitStatus.hasUpstream && !hasPrimaryRemote)
    {
      return 'Add an "origin" remote before pushing.'
    }
    if (!isAhead)
    {
      return 'No local commits to push.'
    }
    return 'Push is currently unavailable.'
  }

  if (hasOpenPr)
  {
    return `View ${terminology.singular} is currently unavailable.`
  }
  if (!hasBranch)
  {
    return `Detached HEAD: checkout a refName before creating a ${terminology.singular}.`
  }
  if (hasChanges)
  {
    return `Commit local changes before creating a ${terminology.singular}.`
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote)
  {
    return `Add an "origin" remote before creating a ${terminology.singular}.`
  }
  if (!isAhead)
  {
    return `No local commits to include in a ${terminology.singular}.`
  }
  if (isBehind)
  {
    return `Branch is behind upstream. Pull/rebase before creating a ${terminology.singular}.`
  }
  return `Create ${terminology.singular} is currently unavailable.`
}

export const COMMIT_DIALOG_TITLE = 'Commit changes'
export const COMMIT_DIALOG_DESCRIPTION =
  'Review and confirm your commit. Leave the message blank to auto-generate one.'

export function GitActionItemIcon({
  icon,
  SourceControlIcon,
}: {
  icon: GitActionIconName
  SourceControlIcon: SourceControlIconComponent
})
{
  if (icon === 'commit') return <GitCommitIcon />
  if (icon === 'push') return <CloudUploadIcon />
  return <SourceControlIcon />
}

export function GitQuickActionIcon({
  quickAction,
  SourceControlIcon,
}: {
  quickAction: GitQuickAction
  SourceControlIcon: SourceControlIconComponent
})
{
  const iconClassName = 'size-3.5'
  if (quickAction.kind === 'open_pr') return <SourceControlIcon className={iconClassName} />
  if (quickAction.kind === 'open_publish') return <CloudUploadIcon className={iconClassName} />
  if (quickAction.kind === 'run_pull') return <InfoIcon className={iconClassName} />
  if (quickAction.kind === 'run_action')
  {
    if (quickAction.action === 'commit') return <GitCommitIcon className={iconClassName} />
    if (quickAction.action === 'push' || quickAction.action === 'commit_push')
    {
      return <CloudUploadIcon className={iconClassName} />
    }
    return <SourceControlIcon className={iconClassName} />
  }
  if (quickAction.label === 'Commit') return <GitCommitIcon className={iconClassName} />
  return <InfoIcon className={iconClassName} />
}
