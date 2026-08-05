// tests/packages/shared/composerTrigger.test.ts
// verify serialize composer mention path behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  detectComposerTrigger,
  parseStandaloneComposerSlashCommand,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from '../../../packages/shared/src/composerTrigger.ts'

describe('serializeComposerMentionPath', () =>
{
  it.each([
    ['src/index.ts', 'src/index.ts'],
    ['docs/My File.md', '"docs/My File.md"'],
    ['docs/My "File".md', '"docs/My \\"File\\".md"'],
  ])('serializes mention path %s', (input, expected) =>
  {
    expect(serializeComposerMentionPath(input)).toBe(expected)
  })
})

describe('serializeComposerFileLink', () =>
{
  it.each([
    ['path/to/package.json', '[package.json](path/to/package.json)'],
    ['docs/My File (draft).md', '[My File (draft).md](docs/My%20File%20%28draft%29.md)'],
    ['C:\\repo\\src\\index.ts', '[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)'],
    ['@scope/package.json', '[package.json](@scope/package.json)'],
  ])('serializes file link %s', (input, expected) =>
  {
    expect(serializeComposerFileLink(input)).toBe(expected)
  })
})

describe('detectComposerTrigger', () =>
{
  it('detects mid-line / after a skill token', () =>
  {
    const text = '$review-follow-up /ui'
    const trigger = detectComposerTrigger(text, text.length)

    expect(trigger).toEqual({
      kind: 'slash-command',
      query: 'ui',
      rangeStart: '$review-follow-up '.length,
      rangeEnd: text.length,
    })
  })

  it('keeps line-start /model as slash-model', () =>
  {
    const text = '/model'
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: 'slash-model',
      query: '',
      rangeStart: 0,
      rangeEnd: text.length,
    })
  })

  it('keeps /model query args as slash-model', () =>
  {
    const text = '/model spark'
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: 'slash-model',
      query: 'spark',
      rangeStart: 0,
      rangeEnd: text.length,
    })
  })

  it('treats line-start /plan as a slash-command token', () =>
  {
    const text = '/plan'
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: 'slash-command',
      query: 'plan',
      rangeStart: 0,
      rangeEnd: text.length,
    })
  })

  it('parses /orchestrate as a standalone mode command', () =>
  {
    expect(parseStandaloneComposerSlashCommand(' /orchestrate ')).toBe('orchestrate')
  })
})
