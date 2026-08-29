// scripts/check-js-comments.ts
// run strict Oxlint comment rules over explicit migrated JavaScript and TypeScript paths

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

const paths = process.argv.slice(2)
if (paths.length === 0)
{
  NodeFS.writeSync(2, 'usage: pnpm run comments:check -- <file-or-directory> [...]\n')
  process.exit(2)
}

const commentRules = [
  '456code/block-doc-comments',
  '456code/comment-tags',
  '456code/file-header',
  '456code/no-inline-prose',
  '456code/no-unicode-arrow',
  '456code/plain-comment-case',
]
const ignorePatterns = [
  '.repos',
  '.repos/**',
  'dist',
  'dist-electron',
  'node_modules',
  'pnpm-lock.yaml',
  '*.tsbuildinfo',
  '**/routeTree.gen.ts',
  '**/*.generated.ts',
  '**/*.generated.tsx',
  '**/_generated/**',
  'apps/mobile/ios/**',
  'apps/mobile/uniwind-types.d.ts',
  'packages/shared/src/qrCode.ts',
]

const temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), '456code-comments-'))
const configPath = NodePath.join(temporaryDirectory, '.oxlintrc.json')
const oxlintPath = NodePath.resolve(
  'node_modules/.pnpm/node_modules/.bin',
  NodePath.sep === '\\' ? 'oxlint.CMD' : 'oxlint',
)

NodeFS.writeFileSync(
  configPath,
  JSON.stringify({
    categories: { correctness: 'off' },
    jsPlugins: [
      {
        name: '456code',
        specifier: NodePath.resolve('oxlint-plugin-456code/index.ts'),
      },
    ],
    rules: Object.fromEntries(commentRules.map((rule) => [rule, 'error'])),
  }),
)

let result: NodeChildProcess.SpawnSyncReturns<Buffer>
try
{
  result = NodeChildProcess.spawnSync(
    oxlintPath,
    [
      '--config',
      configPath,
      '--disable-nested-config',
      ...ignorePatterns.map((pattern) => `--ignore-pattern=${pattern}`),
      ...paths,
    ],
    {
      cwd: process.cwd(),
      shell: NodePath.sep === '\\',
      stdio: 'inherit',
    },
  )
}
finally
{
  NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true })
}

if (result.error) throw result.error
process.exit(result.status ?? 1)
