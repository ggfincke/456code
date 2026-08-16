// tests/apps/server/provider/opencodeRuntime.environment.test.ts
// verifies OpenCode config environment precedence

import { describe, expect, it } from 'vite-plus/test'

import { resolveOpenCodeConfigContent } from '../../../../apps/server/src/provider/opencodeRuntime.ts'

describe('resolveOpenCodeConfigContent', () =>
{
  it('prefers caller config, then inherited config, then the empty fallback', () =>
  {
    expect(
      resolveOpenCodeConfigContent(
        { OPENCODE_CONFIG_CONTENT: '{"source":"caller"}' },
        { OPENCODE_CONFIG_CONTENT: '{"source":"process"}' },
      ),
    ).toBe('{"source":"caller"}')
    expect(
      resolveOpenCodeConfigContent(undefined, {
        OPENCODE_CONFIG_CONTENT: '{"source":"process"}',
      }),
    ).toBe('{"source":"process"}')
    expect(resolveOpenCodeConfigContent(undefined, {})).toBe('{}')
  })
})
