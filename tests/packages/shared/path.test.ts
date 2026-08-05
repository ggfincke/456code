// tests/packages/shared/path.test.ts
// verify path helpers behavior

import { describe, expect, it } from 'vite-plus/test'
import {
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
} from '../../../packages/shared/src/path.ts'

describe('path helpers', () =>
{
  it.each([
    ['drive C:\\repo', () => isWindowsDrivePath('C:\\repo'), true],
    ['unc \\\\server\\share\\repo', () => isUncPath('\\\\server\\share\\repo'), true],
    ['absolute UNC', () => isWindowsAbsolutePath('\\\\server\\share\\repo'), true],
    ['relative ./repo', () => isExplicitRelativePath('./repo'), true],
    ['relative ~/repo', () => isExplicitRelativePath('~/repo'), false],
  ] as const)('%s', (_label, run, expected) =>
  {
    expect(run()).toBe(expected)
  })
})
