// tests/apps/server/provider/Drivers/ClaudeSkillDispatch.test.ts
// verify Claude skill mention dispatch planning

import { describe, expect, it } from '@effect/vitest'

import { planClaudeSkillDispatch } from '../../../../../apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts'

const SKILLS = new Set(['implement', 'review', 're-release-version'])

describe('planClaudeSkillDispatch', () =>
{
  it('leaves prompts without known skills untouched', () =>
  {
    expect(planClaudeSkillDispatch('fix the build', SKILLS)).toBeUndefined()
    expect(planClaudeSkillDispatch('echo $HOME then $unknown', SKILLS)).toBeUndefined()
  })

  it('moves a mid-prompt mention into a trailing slash command', () =>
  {
    expect(planClaudeSkillDispatch('ok, now $implement all the tickets', SKILLS)).toEqual({
      leadingText: 'ok, now',
      commandText: '/implement all the tickets',
      skillName: 'implement',
    })
  })

  it('keeps a prompt-opening mention as one command block', () =>
  {
    expect(planClaudeSkillDispatch('$review\nfocus on auth', SKILLS)).toEqual({
      leadingText: undefined,
      commandText: '/review\nfocus on auth',
      skillName: 'review',
    })
  })

  it('dispatches the last mention and rewrites earlier mentions inline', () =>
  {
    expect(planClaudeSkillDispatch('$review the diff, then $implement the fixes', SKILLS)).toEqual({
      leadingText: '/review the diff, then',
      commandText: '/implement the fixes',
      skillName: 'implement',
    })
  })

  it('ignores dollar tokens joined to other text', () =>
  {
    expect(planClaudeSkillDispatch('cost is 5$implement', SKILLS)).toBeUndefined()
  })
})
