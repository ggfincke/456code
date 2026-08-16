// tests/packages/contracts/git.test.ts
// verify stacked-action git input/result wire pins

import { describe, expect, it } from 'vite-plus/test'
import * as Schema from 'effect/Schema'

import { GitRefString } from '../../../packages/contracts/src/baseSchemas.ts'
import {
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  VcsCreateRefInput,
} from '../../../packages/contracts/src/git.ts'

const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput)
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult)
const decodeCreateRefInput = Schema.decodeUnknownSync(VcsCreateRefInput)
const encodeCreateRefInput = Schema.encodeSync(VcsCreateRefInput)
const decodeGitRefString = Schema.decodeUnknownSync(GitRefString)
const encodeGitRefString = Schema.encodeSync(GitRefString)

describe('Git ref strings', () =>
{
  it('round-trips boundary NBSP while trimming only ASCII boundary whitespace', () =>
  {
    const decoded = decodeCreateRefInput({
      cwd: '/repo',
      refName: ' \t\u00a0feature/new\u00a0\r\n',
      switchRef: true,
    })

    expect(decoded.refName).toBe('\u00a0feature/new\u00a0')
    expect(encodeCreateRefInput(decoded)).toEqual({
      cwd: '/repo',
      refName: '\u00a0feature/new\u00a0',
      switchRef: true,
    })
  })

  it('rejects ASCII-only whitespace on both decode and encode', () =>
  {
    expect(() => decodeGitRefString(' \t\r\n')).toThrow()
    expect(() => encodeGitRefString(' \t\r\n')).toThrow()
  })
})

describe('GitRunStackedActionInput', () =>
{
  it.each([
    {
      label: 'accepts explicit stacked actions with client-provided actionId',
      input: { actionId: 'action-1', cwd: '/repo', action: 'create_pr' as const },
      expectValid: true,
    },
    {
      label: 'rejects missing actionId',
      input: { cwd: '/repo', action: 'create_pr' as const },
      expectValid: false,
    },
  ])('$label', ({ input, expectValid }) =>
  {
    if (expectValid)
    {
      const parsed = decodeRunStackedActionInput(input)
      expect(parsed.actionId).toBe('action-1')
      expect(parsed.action).toBe('create_pr')
      return
    }
    expect(() => decodeRunStackedActionInput(input)).toThrow()
  })
})

describe('GitRunStackedActionResult', () =>
{
  it('decodes a server-authored completion toast', () =>
  {
    const parsed = decodeRunStackedActionResult({
      action: 'commit_push',
      branch: {
        status: 'created',
        name: 'feature/server-owned-toast',
      },
      commit: {
        status: 'created',
        commitSha: '89abcdef01234567',
        subject: 'feat: move toast state into git manager',
      },
      push: {
        status: 'pushed',
        branch: 'feature/server-owned-toast',
        upstreamBranch: 'origin/feature/server-owned-toast',
      },
      pr: {
        status: 'skipped_not_requested',
      },
      toast: {
        title: 'Pushed 89abcde to origin/feature/server-owned-toast',
        description: 'feat: move toast state into git manager',
        cta: {
          kind: 'run_action',
          label: 'Create PR',
          action: {
            kind: 'create_pr',
          },
        },
      },
    })

    expect(parsed.toast.cta.kind).toBe('run_action')
    if (parsed.toast.cta.kind === 'run_action')
    {
      expect(parsed.toast.cta.action.kind).toBe('create_pr')
    }
  })
})
