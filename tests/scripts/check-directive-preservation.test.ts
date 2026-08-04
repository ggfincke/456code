// tests/scripts/check-directive-preservation.test.ts
// verify changed files retain every compiler and linter directive occurrence

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { assert, it } from '@effect/vitest'

const scriptPath = NodePath.resolve('scripts/check-directive-preservation.ts')
const directive = '  // @effect-diagnostics-next-line preferSchemaOverJson:off'

function git(cwd: string, args: ReadonlyArray<string>): void
{
  const result = NodeChildProcess.spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

function makeFixture(): string
{
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'directive-preservation-'))
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  NodeFS.writeFileSync(
    NodePath.join(cwd, 'fixture.ts'),
    [
      'export function first() {',
      directive,
      "  return JSON.parse('{}')",
      '}',
      'export function second() {',
      directive,
      "  return JSON.parse('{}')",
      '}',
      '',
    ].join('\n'),
  )
  git(cwd, ['add', 'fixture.ts'])
  git(cwd, ['commit', '-m', 'fixture'])
  return cwd
}

function runCheck(cwd: string): NodeChildProcess.SpawnSyncReturns<string>
{
  return NodeChildProcess.spawnSync(process.execPath, [scriptPath, 'HEAD'], {
    cwd,
    encoding: 'utf8',
  })
}

it('detects removal of one duplicated indented directive', () =>
{
  const cwd = makeFixture()
  try
  {
    NodeFS.writeFileSync(
      NodePath.join(cwd, 'fixture.ts'),
      [
        'export function first() {',
        "  return JSON.parse('{}')",
        '}',
        'export function second() {',
        directive,
        "  return JSON.parse('{}')",
        '}',
        '',
      ].join('\n'),
    )

    const result = runCheck(cwd)

    assert.equal(result.status, 1)
    assert.include(result.stderr, `fixture.ts: dropped directive from HEAD: ${directive.trim()}`)
    assert.include(result.stderr, 'check-directive-preservation: 1 dropped directive(s)')
  }
  finally
  {
    NodeFS.rmSync(cwd, { recursive: true, force: true })
  }
})

it('passes when duplicate indented directives remain intact', () =>
{
  const cwd = makeFixture()
  try
  {
    NodeFS.appendFileSync(NodePath.join(cwd, 'fixture.ts'), '// unrelated change\n')

    const result = runCheck(cwd)

    assert.equal(result.status, 0, result.stderr)
  }
  finally
  {
    NodeFS.rmSync(cwd, { recursive: true, force: true })
  }
})

it('passes when a directive and its guarded statement are removed together', () =>
{
  const cwd = makeFixture()
  try
  {
    NodeFS.writeFileSync(
      NodePath.join(cwd, 'fixture.ts'),
      ['export function second() {', directive, "  return JSON.parse('{}')", '}', ''].join('\n'),
    )

    const result = runCheck(cwd)

    assert.equal(result.status, 0, result.stderr)
  }
  finally
  {
    NodeFS.rmSync(cwd, { recursive: true, force: true })
  }
})
