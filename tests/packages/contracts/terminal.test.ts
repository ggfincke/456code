// tests/packages/contracts/terminal.test.ts
// verify terminal open input behavior

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import {
  DEFAULT_TERMINAL_ID,
  TerminalAttachInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalThreadInput,
  TerminalWriteInput,
} from '../../../packages/contracts/src/terminal.ts'

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S>
{
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>
}

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean
{
  try
  {
    Schema.decodeUnknownSync(schema as never)(input)
    return true
  }
  catch
  {
    return false
  }
}

describe('TerminalOpenInput', () =>
{
  it('rejects invalid bounds', () =>
  {
    expect(
      decodes(TerminalOpenInput, {
        threadId: 'thread-1',
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: '/tmp/project',
        cols: 10,
        rows: 0,
      }),
    ).toBe(false)
  })

  it('requires terminalId — the client must always pick an id', () =>
  {
    expect(
      decodes(TerminalOpenInput, {
        threadId: 'thread-1',
        cwd: '/tmp/project',
        cols: 100,
        rows: 24,
      }),
    ).toBe(false)
  })

  it('rejects invalid env keys', () =>
  {
    expect(
      decodes(TerminalOpenInput, {
        threadId: 'thread-1',
        cwd: '/tmp/project',
        cols: 100,
        rows: 24,
        env: {
          'bad-key': '1',
        },
      }),
    ).toBe(false)
  })
})

describe('TerminalWriteInput', () =>
{
  it('rejects empty data', () =>
  {
    expect(
      decodes(TerminalWriteInput, {
        threadId: 'thread-1',
        terminalId: DEFAULT_TERMINAL_ID,
        data: '',
      }),
    ).toBe(false)
  })
})

describe('TerminalThreadInput', () =>
{
  it('trims thread ids', () =>
  {
    const parsed = decodeSync(TerminalThreadInput, { threadId: ' thread-1 ' })
    expect(parsed.threadId).toBe('thread-1')
  })
})

describe('optional-field accepts', () =>
{
  const isoTimestamp = '2026-01-01T00:00:00.000Z'

  it.each([
    {
      label: 'Open env overrides + worktreePath',
      run: () =>
      {
        const parsed = decodeSync(TerminalOpenInput, {
          threadId: 'thread-1',
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: '/tmp/project',
          worktreePath: '/tmp/project/.456code/worktrees/feature-a',
          cols: 100,
          rows: 24,
          env: {
            CODE456_PROJECT_ROOT: '/tmp/project',
            CUSTOM_FLAG: '1',
          },
        })
        expect(parsed.env).toMatchObject({
          CODE456_PROJECT_ROOT: '/tmp/project',
          CUSTOM_FLAG: '1',
        })
        expect(parsed.worktreePath).toBe('/tmp/project/.456code/worktrees/feature-a')
      },
    },
    {
      label: 'Attach restartIfNotRunning + Close deleteHistory',
      run: () =>
      {
        expect(
          decodeSync(TerminalAttachInput, {
            threadId: 'thread-1',
            terminalId: DEFAULT_TERMINAL_ID,
            cwd: '/tmp/project',
            restartIfNotRunning: true,
          }).restartIfNotRunning,
        ).toBe(true)
        expect(
          decodes(TerminalCloseInput, {
            threadId: 'thread-1',
            deleteHistory: true,
          }),
        ).toBe(true)
      },
    },
    {
      label: 'Write non-empty data',
      run: () =>
      {
        expect(
          decodes(TerminalWriteInput, {
            threadId: 'thread-1',
            terminalId: DEFAULT_TERMINAL_ID,
            data: 'echo hello\n',
          }),
        ).toBe(true)
      },
    },
    {
      label: 'Event output',
      run: () =>
      {
        expect(
          decodes(TerminalEvent, {
            type: 'output',
            threadId: 'thread-1',
            terminalId: DEFAULT_TERMINAL_ID,
            data: 'line\n',
          }),
        ).toBe(true)
      },
    },
    {
      label: 'Event started with snapshot worktree metadata',
      run: () =>
      {
        expect(
          decodes(TerminalEvent, {
            type: 'started',
            threadId: 'thread-1',
            terminalId: DEFAULT_TERMINAL_ID,
            snapshot: {
              threadId: 'thread-1',
              terminalId: DEFAULT_TERMINAL_ID,
              cwd: '/tmp/project/.456code/worktrees/feature-a',
              worktreePath: '/tmp/project/.456code/worktrees/feature-a',
              status: 'running',
              pid: 1234,
              history: '',
              exitCode: null,
              exitSignal: null,
              label: 'Primary',
              updatedAt: isoTimestamp,
            },
          }),
        ).toBe(true)
      },
    },
  ])('accepts $label', ({ run }) =>
  {
    run()
  })
})
