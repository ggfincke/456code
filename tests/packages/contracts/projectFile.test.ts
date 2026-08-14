// tests/packages/contracts/projectFile.test.ts
// verify project file behavior

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import { ProjectFile } from '../../../packages/contracts/src/projectFile.ts'

const decode = Schema.decodeUnknownSync(ProjectFile)

describe('ProjectFile', () =>
{
  it('defaults empty objects, trims fields, and ignores unknown keys', () =>
  {
    expect(decode({})).toEqual({})
    expect(decode({ futureField: true })).toEqual({})

    const decoded = decode({
      iconPath: ' assets/logo.svg ',
      scripts: [{ name: ' Dev ', command: ' pnpm dev ' }],
    })

    expect(decoded.iconPath).toBe('assets/logo.svg')
    expect(decoded.scripts?.[0]).toEqual({ name: 'Dev', command: 'pnpm dev' })
  })

  it('rejects scripts without a command', () =>
  {
    expect(() => decode({ scripts: [{ name: 'Dev' }] })).toThrow()
  })

  it('rejects unknown script icons', () =>
  {
    expect(() =>
      decode({ scripts: [{ name: 'Dev', command: 'pnpm dev', icon: 'rocket' }] }),
    ).toThrow()
  })
})
