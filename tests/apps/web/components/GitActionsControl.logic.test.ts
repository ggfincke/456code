// tests/apps/web/components/GitActionsControl.logic.test.ts
// verify when: ref is clean and has an open pr behavior

import type { VcsStatusResult } from '@t3tools/contracts'
import { assert, describe, it } from 'vite-plus/test'
import {
  buildGitActionProgressStages,
  buildMenuItems,
  requiresDefaultBranchConfirmation,
  resolveAutoFeatureBranchName,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
  resolveThreadBranchUpdate,
  resolveThreadBranchMetadataPatch,
} from '../../../../apps/web/src/components/GitActionsControl.logic'

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult
{
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: 'feature/test',
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  }
}

describe('when: ref is clean and has an open PR', () =>
{
  it('opens the existing PR and disables commit/push in the menu', () =>
  {
    const openPr = status({
      pr: {
        number: 10,
        title: 'Open PR',
        url: 'https://example.com/pr/10',
        baseRef: 'main',
        headRef: 'feature/test',
        state: 'open',
      },
    })
    assert.deepInclude(resolveQuickAction(openPr, false), {
      kind: 'open_pr',
      label: 'View PR',
      disabled: false,
    })
    assert.deepEqual(buildMenuItems(openPr, false), [
      {
        id: 'commit',
        label: 'Commit',
        disabled: true,
        icon: 'commit',
        kind: 'open_dialog',
        dialogAction: 'commit',
      },
      {
        id: 'push',
        label: 'Push',
        disabled: true,
        icon: 'push',
        kind: 'open_dialog',
        dialogAction: 'push',
      },
      {
        id: 'pr',
        label: 'View PR',
        disabled: false,
        icon: 'pr',
        kind: 'open_pr',
      },
    ])
  })
})

describe('when: actions are busy', () =>
{
  it('disables the quick action and every menu item while a git action runs', () =>
  {
    const quick = resolveQuickAction(status(), true)
    assert.deepInclude(quick, {
      kind: 'show_hint',
      label: 'Commit',
      disabled: true,
      hint: 'Git action in progress.',
    })
    assert.deepEqual(buildMenuItems(status(), true), [
      {
        id: 'commit',
        label: 'Commit',
        disabled: true,
        icon: 'commit',
        kind: 'open_dialog',
        dialogAction: 'commit',
      },
      {
        id: 'push',
        label: 'Push',
        disabled: true,
        icon: 'push',
        kind: 'open_dialog',
        dialogAction: 'push',
      },
      {
        id: 'pr',
        label: 'Create PR',
        disabled: true,
        icon: 'pr',
        kind: 'open_dialog',
        dialogAction: 'create_pr',
      },
    ])
  })
})

describe('when: git status is unavailable', () =>
{
  it('disables the quick action and returns no menu items', () =>
  {
    assert.deepInclude(resolveQuickAction(null, false), {
      kind: 'show_hint',
      label: 'Commit',
      disabled: true,
      hint: 'Git status is unavailable.',
    })
    assert.deepEqual(buildMenuItems(null, false), [])
  })
})

describe('when: ref is clean, ahead, and has an open PR', () =>
{
  it('resolveQuickAction prefers push', () =>
  {
    const quick = resolveQuickAction(
      status({
        aheadCount: 3,
        pr: {
          number: 13,
          title: 'Open PR',
          url: 'https://example.com/pr/13',
          baseRef: 'main',
          headRef: 'feature/test',
          state: 'open',
        },
      }),
      false,
    )
    assert.deepInclude(quick, { kind: 'run_action', action: 'push', label: 'Push' })
  })
})

describe('when: ref is clean, ahead, and has no open PR', () =>
{
  it('resolveQuickAction pushes and creates a PR', () =>
  {
    const quick = resolveQuickAction(status({ aheadCount: 2, pr: null }), false)
    assert.deepInclude(quick, {
      kind: 'run_action',
      action: 'create_pr',
      label: 'Push & create PR',
    })
  })
})

describe('when: source control provider uses merge requests', () =>
{
  it('uses GitLab MR terminology in quick actions and menu items', () =>
  {
    const gitlabStatus = status({
      aheadCount: 2,
      sourceControlProvider: {
        kind: 'gitlab',
        name: 'GitLab',
        baseUrl: 'https://gitlab.com',
      },
    })

    const quick = resolveQuickAction(gitlabStatus, false)
    const items = buildMenuItems(gitlabStatus, false)

    assert.deepInclude(quick, {
      kind: 'run_action',
      action: 'create_pr',
      label: 'Push & create MR',
    })
    assert.deepInclude(items[2], {
      id: 'pr',
      label: 'Create MR',
    })
  })
})

describe('when: ref is clean, up to date, and has no open PR', () =>
{
  it('enables create PR when synced with upstream but ahead of default', () =>
  {
    const syncedFeature = status({
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 1,
      pr: null,
    })

    const quick = resolveQuickAction(syncedFeature, false)
    assert.deepInclude(quick, {
      label: 'Create PR',
      disabled: false,
      kind: 'run_action',
      action: 'create_pr',
    })

    const items = buildMenuItems(syncedFeature, false)
    assert.equal(items.find((item) => item.id === 'pr')?.disabled, false)
  })

  it('resolveQuickAction returns disabled no-action state', () =>
  {
    const quick = resolveQuickAction(
      status({ aheadCount: 0, behindCount: 0, hasWorkingTreeChanges: false, pr: null }),
      false,
    )
    assert.deepInclude(quick, { kind: 'show_hint', label: 'Commit', disabled: true })
  })
})

describe('when: ref is behind upstream', () =>
{
  it('resolveQuickAction returns pull', () =>
  {
    const quick = resolveQuickAction(status({ behindCount: 2 }), false)
    assert.deepInclude(quick, { kind: 'run_pull', label: 'Pull', disabled: false })
  })
})

describe('when: ref has diverged from upstream', () =>
{
  it('resolveQuickAction returns a disabled sync hint', () =>
  {
    const quick = resolveQuickAction(status({ aheadCount: 2, behindCount: 1 }), false)
    assert.deepEqual(quick, {
      label: 'Sync ref',
      disabled: true,
      kind: 'show_hint',
      hint: 'Branch has diverged from upstream. Rebase/merge first.',
    })
  })
})

describe('when: working tree has local changes', () =>
{
  it('offers commit/push/PR as the quick action while the menu only enables commit', () =>
  {
    const dirty = status({ hasWorkingTreeChanges: true })
    assert.deepInclude(resolveQuickAction(dirty, false), {
      kind: 'run_action',
      action: 'commit_push_pr',
      label: 'Commit, push & PR',
    })
    assert.deepEqual(buildMenuItems(dirty, false), [
      {
        id: 'commit',
        label: 'Commit',
        disabled: false,
        icon: 'commit',
        kind: 'open_dialog',
        dialogAction: 'commit',
      },
      {
        id: 'push',
        label: 'Push',
        disabled: true,
        icon: 'push',
        kind: 'open_dialog',
        dialogAction: 'push',
      },
      {
        id: 'pr',
        label: 'Create PR',
        disabled: true,
        icon: 'pr',
        kind: 'open_dialog',
        dialogAction: 'create_pr',
      },
    ])
  })

  it('resolveQuickAction falls back to commit when no origin remote exists', () =>
  {
    const quick = resolveQuickAction(
      status({ hasWorkingTreeChanges: true, hasUpstream: false }),
      false,
      false,
      false,
    )
    assert.deepInclude(quick, {
      kind: 'run_action',
      action: 'commit',
      label: 'Commit',
      disabled: false,
    })
  })

  it('resolveQuickAction returns commit and push when open PR exists', () =>
  {
    const quick = resolveQuickAction(
      status({
        hasWorkingTreeChanges: true,
        pr: {
          number: 16,
          title: 'Existing PR',
          url: 'https://example.com/pr/16',
          baseRef: 'main',
          headRef: 'feature/test',
          state: 'open',
        },
      }),
      false,
    )
    assert.deepInclude(quick, {
      kind: 'run_action',
      action: 'commit_push',
      label: 'Commit & push',
    })
  })

  it('buildMenuItems enables push for ahead commits while local changes remain uncommitted', () =>
  {
    const items = buildMenuItems(
      status({
        refName: 'feature/test',
        hasWorkingTreeChanges: true,
        aheadCount: 1,
        workingTree: {
          files: [{ path: '.vercel/project.json', insertions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
        },
      }),
      false,
    )
    assert.deepEqual(items, [
      {
        id: 'commit',
        label: 'Commit',
        disabled: false,
        icon: 'commit',
        kind: 'open_dialog',
        dialogAction: 'commit',
      },
      {
        id: 'push',
        label: 'Push',
        disabled: false,
        icon: 'push',
        kind: 'open_dialog',
        dialogAction: 'push',
      },
      {
        id: 'pr',
        label: 'Create PR',
        disabled: true,
        icon: 'pr',
        kind: 'open_dialog',
        dialogAction: 'create_pr',
      },
    ])
  })
})

describe('when: on default ref without open PR', () =>
{
  it('resolveQuickAction returns commit and push when local changes exist', () =>
  {
    const quick = resolveQuickAction(
      status({ refName: 'main', hasWorkingTreeChanges: true }),
      false,
      true,
    )
    assert.deepInclude(quick, {
      kind: 'run_action',
      action: 'commit_push',
      label: 'Commit & push',
      disabled: false,
    })
  })

  it('resolveQuickAction returns push when ref is ahead', () =>
  {
    const quick = resolveQuickAction(
      status({ refName: 'main', aheadCount: 2, pr: null }),
      false,
      true,
    )
    assert.deepInclude(quick, {
      kind: 'run_action',
      action: 'commit_push',
      label: 'Push',
      disabled: false,
    })
  })
})

describe('when: working tree has local changes and ref is behind upstream', () =>
{
  it('resolveQuickAction pulls first so the later push can fast-forward', () =>
  {
    // behind/diverged is now resolved before commit-and-push, which would
    // otherwise commit locally and fail the push non-fast-forward (megacore U-008)
    const quick = resolveQuickAction(status({ hasWorkingTreeChanges: true, behindCount: 1 }), false)
    assert.deepInclude(quick, {
      kind: 'run_pull',
      label: 'Pull',
      disabled: false,
    })
  })
})

describe('when: HEAD is detached and there are no local changes', () =>
{
  it('resolveQuickAction shows detached head hint', () =>
  {
    const quick = resolveQuickAction(
      status({ refName: null, hasWorkingTreeChanges: false, hasUpstream: false }),
      false,
    )
    assert.deepInclude(quick, { kind: 'show_hint', label: 'Commit', disabled: true })
  })
})

describe('when: ref has no upstream configured', () =>
{
  it('disables push/create PR when clean with no upstream and no commits ahead', () =>
  {
    const cleanNoUpstream = status({ hasUpstream: false, pr: null, aheadCount: 0 })
    assert.deepInclude(resolveQuickAction(cleanNoUpstream, false), {
      kind: 'show_hint',
      label: 'Push',
      hint: 'No local commits to push.',
      disabled: true,
    })
    assert.deepEqual(buildMenuItems(cleanNoUpstream, false), [
      {
        id: 'commit',
        label: 'Commit',
        disabled: true,
        icon: 'commit',
        kind: 'open_dialog',
        dialogAction: 'commit',
      },
      {
        id: 'push',
        label: 'Push',
        disabled: true,
        icon: 'push',
        kind: 'open_dialog',
        dialogAction: 'push',
      },
      {
        id: 'pr',
        label: 'Create PR',
        disabled: true,
        icon: 'pr',
        kind: 'open_dialog',
        dialogAction: 'create_pr',
      },
    ])
  })

  it('resolveQuickAction opens PR when clean, no upstream, no local commits are ahead, and PR exists', () =>
  {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 0,
        pr: {
          number: 14,
          title: 'Existing PR',
          url: 'https://example.com/pr/14',
          baseRef: 'main',
          headRef: 'feature/test',
          state: 'open',
        },
      }),
      false,
    )
    assert.deepInclude(quick, {
      kind: 'open_pr',
      label: 'View PR',
      disabled: false,
    })
  })

  it('resolveQuickAction runs push when clean, no upstream, and local commits are ahead', () =>
  {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 1,
        pr: {
          number: 15,
          title: 'Existing PR',
          url: 'https://example.com/pr/15',
          baseRef: 'main',
          headRef: 'feature/test',
          state: 'open',
        },
      }),
      false,
    )
    assert.deepInclude(quick, {
      kind: 'run_action',
      action: 'push',
      label: 'Push',
      disabled: false,
    })
  })

  it('enables push and create PR when no upstream and commits are ahead', () =>
  {
    const aheadNoUpstream = status({
      hasUpstream: false,
      aheadCount: 2,
      pr: null,
    })
    assert.deepInclude(resolveQuickAction(aheadNoUpstream, false), {
      kind: 'run_action',
      action: 'create_pr',
      label: 'Push & create PR',
      disabled: false,
    })
    assert.deepEqual(buildMenuItems(aheadNoUpstream, false), [
      {
        id: 'commit',
        label: 'Commit',
        disabled: true,
        icon: 'commit',
        kind: 'open_dialog',
        dialogAction: 'commit',
      },
      {
        id: 'push',
        label: 'Push',
        disabled: false,
        icon: 'push',
        kind: 'open_dialog',
        dialogAction: 'push',
      },
      {
        id: 'pr',
        label: 'Create PR',
        disabled: false,
        icon: 'pr',
        kind: 'open_dialog',
        dialogAction: 'create_pr',
      },
    ])
  })

  it('publishes when no origin remote exists and hides push/create PR from the menu', () =>
  {
    const aheadNoOrigin = status({
      hasUpstream: false,
      aheadCount: 2,
      pr: null,
    })
    assert.deepEqual(resolveQuickAction(aheadNoOrigin, false, false, false), {
      kind: 'open_publish',
      label: 'Publish repository',
      disabled: false,
    })
    assert.deepEqual(buildMenuItems(aheadNoOrigin, false, false), [
      {
        id: 'commit',
        label: 'Commit',
        disabled: true,
        icon: 'commit',
        kind: 'open_dialog',
        dialogAction: 'commit',
      },
    ])
  })

  it('resolveQuickAction is disabled on default ref when no upstream exists and no commits are ahead', () =>
  {
    const quick = resolveQuickAction(
      status({
        refName: 'main',
        hasUpstream: false,
        aheadCount: 0,
        pr: null,
      }),
      false,
      true,
    )
    assert.deepInclude(quick, {
      kind: 'show_hint',
      label: 'Push',
      hint: 'No local commits to push.',
      disabled: true,
    })
  })

  it('resolveQuickAction uses push-only on default ref when no upstream exists and commits are ahead', () =>
  {
    const quick = resolveQuickAction(
      status({
        refName: 'main',
        hasUpstream: false,
        aheadCount: 1,
        pr: null,
      }),
      false,
      true,
    )
    assert.deepInclude(quick, {
      kind: 'run_action',
      action: 'commit_push',
      label: 'Push',
      disabled: false,
    })
  })

  it('buildMenuItems still disables push and create PR when ref is behind', () =>
  {
    const items = buildMenuItems(
      status({
        hasUpstream: false,
        behindCount: 1,
        aheadCount: 0,
        pr: null,
      }),
      false,
    )
    assert.deepEqual(items, [
      {
        id: 'commit',
        label: 'Commit',
        disabled: true,
        icon: 'commit',
        kind: 'open_dialog',
        dialogAction: 'commit',
      },
      {
        id: 'push',
        label: 'Push',
        disabled: true,
        icon: 'push',
        kind: 'open_dialog',
        dialogAction: 'push',
      },
      {
        id: 'pr',
        label: 'Create PR',
        disabled: true,
        icon: 'pr',
        kind: 'open_dialog',
        dialogAction: 'create_pr',
      },
    ])
  })
})

describe('requiresDefaultBranchConfirmation', () =>
{
  it('requires confirmation for push actions on default ref', () =>
  {
    assert.isFalse(requiresDefaultBranchConfirmation('commit', true))
    assert.isTrue(requiresDefaultBranchConfirmation('push', true))
    assert.isTrue(requiresDefaultBranchConfirmation('create_pr', true))
    assert.isTrue(requiresDefaultBranchConfirmation('commit_push', true))
    assert.isTrue(requiresDefaultBranchConfirmation('commit_push_pr', true))
    assert.isFalse(requiresDefaultBranchConfirmation('commit_push', false))
    assert.isFalse(requiresDefaultBranchConfirmation('push', false))
  })
})

describe('resolveDefaultBranchActionDialogCopy', () =>
{
  it('uses push-only copy when pushing without a commit', () =>
  {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: 'commit_push',
      branchName: 'main',
      includesCommit: false,
    })

    assert.deepEqual(copy, {
      title: 'Push to default ref?',
      description:
        'This action will push local commits on "main". You can continue on this ref or create a feature ref and run the same action there.',
      continueLabel: 'Push to main',
    })
  })

  it('uses push-and-pr copy when creating a PR without a commit', () =>
  {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: 'commit_push_pr',
      branchName: 'main',
      includesCommit: false,
    })

    assert.deepEqual(copy, {
      title: 'Push & create PR from default ref?',
      description:
        'This action will push local commits and create a pull request on "main". You can continue on this ref or create a feature ref and run the same action there.',
      continueLabel: 'Push & create PR',
    })
  })

  it('keeps commit copy when the action includes a commit', () =>
  {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: 'commit_push_pr',
      branchName: 'main',
      includesCommit: true,
    })

    assert.deepEqual(copy, {
      title: 'Commit, push & create PR from default ref?',
      description:
        'This action will commit, push, and create a pull request on "main". You can continue on this ref or create a feature ref and run the same action there.',
      continueLabel: 'Commit, push & create PR',
    })
  })
})

describe('buildGitActionProgressStages', () =>
{
  it.each([
    {
      name: 'explicit push',
      input: {
        action: 'push' as const,
        hasCustomCommitMessage: false,
        hasWorkingTreeChanges: false,
        pushTarget: 'origin/feature/test',
      },
      expected: ['Pushing to origin/feature/test...'],
    },
    {
      name: 'create-pr with push',
      input: {
        action: 'create_pr' as const,
        hasCustomCommitMessage: false,
        hasWorkingTreeChanges: false,
        pushTarget: 'origin/feature/test',
        shouldPushBeforePr: true,
      },
      expected: [
        'Pushing to origin/feature/test...',
        'Preparing PR...',
        'Generating PR content...',
        'Creating pull request...',
      ],
    },
    {
      name: 'create-pr skipping push',
      input: {
        action: 'create_pr' as const,
        hasCustomCommitMessage: false,
        hasWorkingTreeChanges: false,
        shouldPushBeforePr: false,
      },
      expected: ['Preparing PR...', 'Generating PR content...', 'Creating pull request...'],
    },
    {
      name: 'commit+push dirty tree',
      input: {
        action: 'commit_push' as const,
        hasCustomCommitMessage: false,
        hasWorkingTreeChanges: true,
        pushTarget: 'origin/feature/test',
      },
      expected: [
        'Generating commit message...',
        'Committing...',
        'Pushing to origin/feature/test...',
      ],
    },
    {
      name: 'commit+push+PR',
      input: {
        action: 'commit_push_pr' as const,
        hasCustomCommitMessage: true,
        hasWorkingTreeChanges: true,
        pushTarget: 'origin/feature/test',
      },
      expected: [
        'Committing...',
        'Pushing to origin/feature/test...',
        'Preparing PR...',
        'Generating PR content...',
        'Creating pull request...',
      ],
    },
  ])('maps $name actions to progress stages', ({ input, expected }) =>
  {
    assert.deepEqual(buildGitActionProgressStages(input), expected)
  })
})

describe('resolveThreadBranchUpdate', () =>
{
  it('returns a branch update when the action created a new branch', () =>
  {
    const update = resolveThreadBranchUpdate({
      action: 'commit_push_pr',
      branch: {
        status: 'created',
        name: 'feature/fix-toast-copy',
      },
      commit: {
        status: 'created',
        commitSha: '89abcdef01234567',
        subject: 'feat: add ref sync',
      },
      push: { status: 'pushed', branch: 'feature/fix-toast-copy' },
      pr: { status: 'skipped_not_requested' },
      toast: {
        title: 'Pushed 89abcde to origin/feature/fix-toast-copy',
        cta: { kind: 'none' },
      },
    })

    assert.deepEqual(update, {
      branch: 'feature/fix-toast-copy',
    })
  })

  it('returns null when the action stayed on the existing branch', () =>
  {
    const update = resolveThreadBranchUpdate({
      action: 'commit_push',
      branch: {
        status: 'skipped_not_requested',
      },
      commit: {
        status: 'created',
        commitSha: '89abcdef01234567',
        subject: 'feat: add ref sync',
      },
      push: { status: 'pushed', branch: 'feature/fix-toast-copy' },
      pr: { status: 'skipped_not_requested' },
      toast: {
        title: 'Pushed 89abcde to origin/feature/fix-toast-copy',
        cta: { kind: 'none' },
      },
    })

    assert.equal(update, null)
  })
})

describe('resolveLiveThreadBranchUpdate', () =>
{
  it('returns a branch update when live git status differs from stored thread metadata', () =>
  {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: 'feature/old-ref',
      gitStatus: status({ refName: 'effect-atom' }),
    })

    assert.deepEqual(update, {
      branch: 'effect-atom',
    })
  })

  it('returns null when live git status is unavailable', () =>
  {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: 'feature/old-ref',
      gitStatus: null,
    })

    assert.equal(update, null)
  })

  it('returns null when the stored thread ref already matches git status', () =>
  {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: 'effect-atom',
      gitStatus: status({ refName: 'effect-atom' }),
    })

    assert.equal(update, null)
  })

  it('returns null when git status is detached HEAD but the thread already has a ref', () =>
  {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: 'effect-atom',
      gitStatus: status({ refName: null }),
    })

    assert.equal(update, null)
  })

  it('does not regress a semantic thread ref back to a temporary worktree ref', () =>
  {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: '456code/github-query-rate-limit',
      gitStatus: status({ refName: '456code/bda76797' }),
    })

    assert.equal(update, null)
  })

  it('allows a temporary worktree ref to reconcile to a semantic branch', () =>
  {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: '456code/a9628676',
      gitStatus: status({ refName: 'feature/diff-panel-toggle' }),
    })

    assert.deepEqual(update, { branch: 'feature/diff-panel-toggle' })
  })
})

describe('resolveThreadBranchMetadataPatch', () =>
{
  it('does not overwrite worktree metadata while reconciling a branch', () =>
  {
    assert.deepEqual(
      resolveThreadBranchMetadataPatch('feature/current-ref', 'feature/previous-ref'),
      {
        branch: 'feature/current-ref',
        expectedBranch: 'feature/previous-ref',
      },
    )
  })
})

describe('resolveAutoFeatureBranchName', () =>
{
  it('uses semantic preferred ref names when available', () =>
  {
    const ref = resolveAutoFeatureBranchName(['main', 'feature/other'], 'fix toast copy')
    assert.equal(ref, 'feature/fix-toast-copy')
  })

  it('normalizes preferred names that already include a ref namespace', () =>
  {
    const ref = resolveAutoFeatureBranchName(['main'], 'feature/refine-toolbar-actions')
    assert.equal(ref, 'feature/refine-toolbar-actions')
  })

  it('increments suffix when the preferred ref name already exists', () =>
  {
    const ref = resolveAutoFeatureBranchName(
      ['main', 'feature/fix-toast-copy', 'feature/fix-toast-copy-2'],
      'fix toast copy',
    )
    assert.equal(ref, 'feature/fix-toast-copy-3')
  })

  it('treats existing ref names as case-insensitive for collision checks', () =>
  {
    const ref = resolveAutoFeatureBranchName(['Feature/Ticket-1'], 'feature/ticket-1')
    assert.equal(ref, 'feature/ticket-1-2')
  })

  it('falls back to feature/update when no preferred name is provided', () =>
  {
    const ref = resolveAutoFeatureBranchName(['main'])
    assert.equal(ref, 'feature/update')
  })
})
