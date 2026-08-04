import { describe, expect, it } from 'vite-plus/test'

import { parseCliArgs, tokenizeCliArgs } from '../../../packages/shared/src/cliArgs.ts'

describe('tokenizeCliArgs', () =>
{
  it('preserves quoted values and escaped spaces', () =>
  {
    expect(
      tokenizeCliArgs(
        String.raw`--config model="gpt 5" --enable foo\ bar --config=profile='work profile'`,
      ),
    ).toEqual(['--config', 'model=gpt 5', '--enable', 'foo bar', '--config=profile=work profile'])
  })

  it('preserves literal backslashes in path values', () =>
  {
    expect(
      tokenizeCliArgs(String.raw`--config cacheDir=C:\Users\me --config "quoted=C:\Users\me"`),
    ).toEqual([
      '--config',
      String.raw`cacheDir=C:\Users\me`,
      '--config',
      String.raw`quoted=C:\Users\me`,
    ])
  })
})

describe('parseCliArgs', () =>
{
  it('returns empty result for empty inputs', () =>
  {
    expect(parseCliArgs('')).toEqual({ flags: {}, positionals: [] })
    expect(parseCliArgs('   ')).toEqual({ flags: {}, positionals: [] })
    expect(parseCliArgs([])).toEqual({ flags: {}, positionals: [] })
  })

  it.each([
    {
      label: 'boolean chrome flag',
      input: '--chrome',
      expected: { flags: { chrome: null }, positionals: [] },
    },
    {
      label: 'boolean flags combined with valued flag',
      input: '--chrome --effort high --debug',
      expected: { flags: { chrome: null, effort: 'high', debug: null }, positionals: [] },
    },
    {
      label: 'key=value mixed with boolean flags',
      input: '--chrome --model=claude-sonnet-4-6 --debug',
      expected: {
        flags: { chrome: null, model: 'claude-sonnet-4-6', debug: null },
        positionals: [],
      },
    },
    {
      label: 'quoted valued flag with chrome',
      input: `--append-system-prompt "always think step by step" --chrome`,
      expected: {
        flags: { 'append-system-prompt': 'always think step by step', chrome: null },
        positionals: [],
      },
    },
    {
      label: 'equals-form valued flag',
      input: '--effort=high',
      expected: { flags: { effort: 'high' }, positionals: [] },
    },
    {
      label: 'extra whitespace between tokens',
      input: '  --chrome   --verbose  ',
      expected: { flags: { chrome: null, verbose: null }, positionals: [] },
    },
    {
      label: 'bare -- with no flag name',
      input: '--',
      expected: { flags: {}, positionals: [] },
    },
    {
      label: 'positional only',
      input: '1.2.3',
      expected: { flags: {}, positionals: ['1.2.3'] },
    },
  ])('parses $label', ({ input, expected }) =>
  {
    expect(parseCliArgs(input)).toEqual(expected)
  })

  it('collects positionals mixed with flags (argv array)', () =>
  {
    expect(parseCliArgs(['1.2.3', '--root', '/path', '--github-output'])).toEqual({
      flags: { root: '/path', 'github-output': null },
      positionals: ['1.2.3'],
    })
  })

  it('boolean flag does not consume next token as value', () =>
  {
    expect(parseCliArgs(['--github-output', '1.2.3'], { booleanFlags: ['github-output'] })).toEqual(
      {
        flags: { 'github-output': null },
        positionals: ['1.2.3'],
      },
    )
  })

  it('non-boolean flag still consumes next token', () =>
  {
    expect(parseCliArgs(['--root', '/path', '1.2.3'], { booleanFlags: ['github-output'] })).toEqual(
      {
        flags: { root: '/path' },
        positionals: ['1.2.3'],
      },
    )
  })

  it('mixes boolean and value flags with positionals', () =>
  {
    expect(
      parseCliArgs(['--github-output', '--root', '/path', '1.2.3'], {
        booleanFlags: ['github-output'],
      }),
    ).toEqual({
      flags: { 'github-output': null, root: '/path' },
      positionals: ['1.2.3'],
    })
  })
})
