// tests/apps/server/provider/opencodeRuntime.permissions.test.ts
// verifies open code runtime permission rules preserve supervised boundaries

import * as NodeAssert from 'node:assert/strict'

import * as RegExpUtils from 'effect/RegExp'
import { describe, it } from 'vite-plus/test'

import {
  buildOpenCodePermissionRules,
  toOpenCodePermissionReply,
} from '../../../../apps/server/src/provider/opencodeRuntime.ts'

function actionFor(
  runtimeMode: Parameters<typeof buildOpenCodePermissionRules>[0],
  permission: string,
  target = '*',
)
{
  // opencode uses the last matching rule, and its wildcards match directory separators
  return buildOpenCodePermissionRules(runtimeMode).findLast(
    (rule) =>
      (rule.permission === '*' || rule.permission === permission) &&
      new RegExp(`^${RegExpUtils.escape(rule.pattern).replaceAll('\\*', '.*')}$`, 's').test(target),
  )?.action
}

describe('buildOpenCodePermissionRules', () =>
{
  it('auto-accepts edits while keeping unrelated permissions supervised', () =>
  {
    NodeAssert.equal(actionFor('auto-accept-edits', 'edit'), 'allow')
    NodeAssert.equal(actionFor('auto-accept-edits', 'bash'), 'ask')
    NodeAssert.equal(actionFor('auto-accept-edits', 'webfetch'), 'ask')
    NodeAssert.equal(actionFor('auto-accept-edits', 'external_directory'), 'ask')
  })

  it('keeps approval-required and auto modes supervised', () =>
  {
    NodeAssert.equal(actionFor('approval-required', 'edit'), 'ask')
    NodeAssert.equal(actionFor('auto', 'edit'), 'ask')
  })

  it('allows workspace reads and task updates without asking in supervised modes', () =>
  {
    for (const runtimeMode of ['approval-required', 'auto-accept-edits', 'auto'] as const)
    {
      for (const permission of ['read', 'glob', 'grep', 'lsp', 'skill', 'todowrite'])
      {
        NodeAssert.equal(actionFor(runtimeMode, permission, 'src/index.ts'), 'allow')
      }
    }
  })

  it('preserves OpenCode environment-file approval rules', () =>
  {
    for (const runtimeMode of ['approval-required', 'auto-accept-edits', 'auto'] as const)
    {
      for (const target of [
        '.env',
        '.env.local',
        'config/service.env',
        'config/service.env.local',
      ])
      {
        NodeAssert.equal(actionFor(runtimeMode, 'read', target), 'ask')
      }
      for (const target of ['.env.example', 'config/service.env.example'])
      {
        NodeAssert.equal(actionFor(runtimeMode, 'read', target), 'allow')
      }
    }
  })

  it('still asks before commands, network access, external directories, and unknown tools', () =>
  {
    for (const runtimeMode of ['approval-required', 'auto-accept-edits', 'auto'] as const)
    {
      NodeAssert.equal(actionFor(runtimeMode, 'bash'), 'ask')
      NodeAssert.equal(actionFor(runtimeMode, 'webfetch'), 'ask')
      NodeAssert.equal(actionFor(runtimeMode, 'websearch'), 'ask')
      NodeAssert.equal(actionFor(runtimeMode, 'external_directory'), 'ask')
      NodeAssert.equal(actionFor(runtimeMode, 'doom_loop'), 'ask')
      NodeAssert.equal(actionFor(runtimeMode, 'custom_tool'), 'ask')
    }
  })

  it('allows everything only in full-access mode', () =>
  {
    NodeAssert.deepEqual(buildOpenCodePermissionRules('full-access'), [
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'allow' },
    ])
  })
})

describe('toOpenCodePermissionReply', () =>
{
  it.each([
    ['accept', 'once'],
    ['acceptForSession', 'always'],
    ['acceptAlways', 'always'],
    ['decline', 'reject'],
    ['cancel', 'reject'],
  ] as const)('maps %s to %s', (decision, reply) =>
  {
    NodeAssert.equal(toOpenCodePermissionReply(decision), reply)
  })
})
