// tests/apps/server/provider/opencodeRuntime.permissions.test.ts
// verifies open code runtime permission rules preserve supervised boundaries

import * as NodeAssert from 'node:assert/strict'

import { describe, it } from 'vite-plus/test'

import { buildOpenCodePermissionRules } from '../../../../apps/server/src/provider/opencodeRuntime.ts'

function actionFor(
  runtimeMode: Parameters<typeof buildOpenCodePermissionRules>[0],
  permission: string,
)
{
  return buildOpenCodePermissionRules(runtimeMode).find((rule) => rule.permission === permission)
    ?.action
}

describe('buildOpenCodePermissionRules', () =>
{
  it('auto-accepts edits while keeping unrelated permissions supervised', () =>
  {
    NodeAssert.equal(actionFor('auto-accept-edits', 'edit'), 'allow')
    NodeAssert.equal(actionFor('auto-accept-edits', 'bash'), 'ask')
    NodeAssert.equal(actionFor('auto-accept-edits', 'webfetch'), 'ask')
    NodeAssert.equal(actionFor('auto-accept-edits', 'external_directory'), 'ask')
    NodeAssert.equal(actionFor('auto-accept-edits', '*'), 'ask')
  })

  it('keeps approval-required and auto modes supervised', () =>
  {
    NodeAssert.equal(actionFor('approval-required', 'edit'), 'ask')
    NodeAssert.equal(actionFor('auto', 'edit'), 'ask')
  })

  it('allows everything only in full-access mode', () =>
  {
    NodeAssert.deepEqual(buildOpenCodePermissionRules('full-access'), [
      { permission: '*', pattern: '*', action: 'allow' },
    ])
  })
})
