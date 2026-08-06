// tests/apps/server/pathExpansion.test.ts
// verify expand home path behavior

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { describe, expect, it } from 'vite-plus/test'

import { expandHomePath } from '../../../apps/server/src/pathExpansion.ts'

describe('expandHomePath', () =>
{
  it.each([
    ['', ''],
    ['/absolute/path', '/absolute/path'],
    ['relative/path', 'relative/path'],
    ['~alice/foo', '~alice/foo'],
  ] as const)('leaves %s unchanged', (input, expected) =>
  {
    expect(expandHomePath(input)).toBe(expected)
  })

  it.each([
    ['~', NodeOS.homedir()],
    ['~/.codex-work', NodePath.join(NodeOS.homedir(), '.codex-work')],
    ['~\\.codex', NodePath.join(NodeOS.homedir(), '.codex')],
  ] as const)('expands home prefix %s', (input, expected) =>
  {
    expect(expandHomePath(input)).toBe(expected)
  })
})
