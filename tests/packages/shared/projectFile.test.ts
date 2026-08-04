import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import { ProjectFileFromJson } from '../../../packages/shared/src/projectFile.ts'

const decodeJson = Schema.decodeUnknownSync(ProjectFileFromJson)

describe('ProjectFileFromJson', () =>
{
  it('decodes lenient JSONC with comments and trailing commas', () =>
  {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`)

    expect(decoded.iconPath).toBe('assets/logo.svg')
    expect(decoded.scripts?.[0]).toEqual({ name: 'Dev', command: 'pnpm dev' })
  })

  it('fails on malformed JSON', () =>
  {
    expect(() => decodeJson('{ not json')).toThrow()
  })
})
