// tests/packages/shared/projectScripts.test.ts
// verify shared project script cwd and runtime env helpers

import { describe, expect, it } from 'vite-plus/test'

import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
} from '../../../packages/shared/src/projectScripts.ts'

describe('projectScripts helpers', () =>
{
  it('builds default runtime env for scripts', () =>
  {
    const env = projectScriptRuntimeEnv({
      project: { cwd: '/repo' },
      worktreePath: '/repo/worktree-a',
    })

    expect(env).toMatchObject({
      CODE456_PROJECT_ROOT: '/repo',
      T3CODE_WORKTREE_PATH: '/repo/worktree-a',
    })
  })

  it('allows overriding runtime env values', () =>
  {
    const env = projectScriptRuntimeEnv({
      project: { cwd: '/repo' },
      extraEnv: {
        CODE456_PROJECT_ROOT: '/custom-root',
        CUSTOM_FLAG: '1',
      },
    })

    expect(env.CODE456_PROJECT_ROOT).toBe('/custom-root')
    expect(env.CUSTOM_FLAG).toBe('1')
    expect(env.T3CODE_WORKTREE_PATH).toBeUndefined()
  })

  it('prefers the worktree path for script cwd resolution', () =>
  {
    expect(
      projectScriptCwd({
        project: { cwd: '/repo' },
        worktreePath: '/repo/worktree-a',
      }),
    ).toBe('/repo/worktree-a')
    expect(
      projectScriptCwd({
        project: { cwd: '/repo' },
        worktreePath: null,
      }),
    ).toBe('/repo')
  })
})
