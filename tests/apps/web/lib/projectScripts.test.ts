// tests/apps/web/lib/projectScripts.test.ts
// verify web project script builders and command helpers

import { MAX_SCRIPT_ID_LENGTH } from '@t3tools/contracts'
import { setupProjectScript } from '@t3tools/shared/projectScripts'
import { describe, expect, it } from 'vite-plus/test'

import { shortcutLabelForCommand } from '../../../../apps/web/src/lib/keybindings'
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptIdFromCommand,
} from '../../../../apps/web/src/lib/projectScripts'

describe('projectScripts helpers', () =>
{
  it('builds scripts with preview settings', () =>
  {
    expect(
      buildProjectScript('dev', {
        name: 'Dev server',
        command: 'pnpm dev',
        icon: 'debug',
        runOnWorktreeCreate: false,
        previewUrl: 'http://localhost:5733',
        autoOpenPreview: true,
      }),
    ).toEqual({
      id: 'dev',
      name: 'Dev server',
      command: 'pnpm dev',
      icon: 'debug',
      runOnWorktreeCreate: false,
      previewUrl: 'http://localhost:5733',
      autoOpenPreview: true,
    })
  })

  it('omits preview settings when no preview URL is configured', () =>
  {
    expect(
      buildProjectScript('test', {
        name: 'Test',
        command: 'pnpm test',
        icon: 'test',
        runOnWorktreeCreate: false,
        previewUrl: null,
        autoOpenPreview: false,
      }),
    ).toEqual({
      id: 'test',
      name: 'Test',
      command: 'pnpm test',
      icon: 'test',
      runOnWorktreeCreate: false,
    })
  })

  it('builds and parses script run commands', () =>
  {
    const command = commandForProjectScript('lint')
    expect(command).toBe('script.lint.run')
    expect(projectScriptIdFromCommand(command ?? '')).toBe('lint')
    expect(projectScriptIdFromCommand('terminal.toggle')).toBeNull()
  })

  it.each([
    'install-javascript-dependencies',
    'A',
    'a.b',
    'a b',
    '-a',
    '',
    'a'.repeat(MAX_SCRIPT_ID_LENGTH + 1),
  ])('omits shortcuts for legacy script ID %j without crashing script menus', (id) =>
  {
    const commands = ['lint', id, 'test'].map(commandForProjectScript)
    expect(commands).toEqual(['script.lint.run', null, 'script.test.run'])
    expect(commands.map((candidate) => shortcutLabelForCommand([], candidate))).toEqual([
      null,
      null,
      null,
    ])
  })

  it('preserves the exact ID at the shortcut length limit', () =>
  {
    const id = 'a'.repeat(MAX_SCRIPT_ID_LENGTH)
    expect(projectScriptIdFromCommand(commandForProjectScript(id) ?? '')).toBe(id)
  })

  it('slugifies and dedupes project script ids', () =>
  {
    expect(nextProjectScriptId('Run Tests', [])).toBe('run-tests')
    expect(nextProjectScriptId('Run Tests', ['run-tests'])).toBe('run-tests-2')
    expect(nextProjectScriptId('!!!', [])).toBe('script')
  })

  it('resolves primary and setup scripts', () =>
  {
    const scripts = [
      {
        id: 'setup',
        name: 'Setup',
        command: 'bun install',
        icon: 'configure' as const,
        runOnWorktreeCreate: true,
      },
      {
        id: 'test',
        name: 'Test',
        command: 'bun test',
        icon: 'test' as const,
        runOnWorktreeCreate: false,
      },
    ]

    expect(primaryProjectScript(scripts)?.id).toBe('test')
    expect(setupProjectScript(scripts)?.id).toBe('setup')
  })
})
