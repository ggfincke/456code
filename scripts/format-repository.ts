// scripts/format-repository.ts
// partition repository and staged formatting between Prettier and Oxfmt

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

const prettierExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const ignoredSegments = new Set([
  '.alchemy',
  '.reference',
  '.repos',
  'dist',
  'dist-electron',
  'node_modules',
])
const ignoredPaths = new Set([
  'apps/mobile/uniwind-types.d.ts',
  'apps/web/public/mockServiceWorker.js',
  'apps/web/src/lib/vendor/qrcodegen.ts',
  'pnpm-lock.yaml',
])
const prettierGlob = '**/*.{cjs,js,jsx,mjs,ts,tsx}'

const normalizePath = (value: string): string => value.replaceAll('\\', '/')

const toRepoPath = (value: string): string =>
{
  const absolute = NodePath.resolve(value)
  return normalizePath(NodePath.relative(process.cwd(), absolute))
}

const isIgnoredPath = (repoPath: string): boolean =>
{
  const parts = repoPath.split('/')
  return (
    repoPath.startsWith('.plans/') ||
    repoPath.startsWith('dev-docs/') ||
    repoPath.startsWith('apps/mobile/android/') ||
    repoPath.startsWith('apps/mobile/ios/') ||
    repoPath.endsWith('.tsbuildinfo') ||
    parts.some((part) => ignoredSegments.has(part) || part.endsWith('.icon')) ||
    ignoredPaths.has(repoPath) ||
    repoPath.endsWith('/routeTree.gen.ts')
  )
}

const runnableFile = (value: string): string | undefined =>
{
  const repoPath = toRepoPath(value)
  if (repoPath.startsWith('../') || isIgnoredPath(repoPath)) return undefined

  try
  {
    return NodeFS.statSync(repoPath).isFile() ? repoPath : undefined
  }
  catch
  {
    return undefined
  }
}

const binaryPath = (name: string): string =>
  NodePath.resolve('node_modules/.bin', NodePath.sep === '\\' ? `${name}.CMD` : name)

const run = (binary: string, args: ReadonlyArray<string>): void =>
{
  const result = NodeChildProcess.spawnSync(binaryPath(binary), args, {
    cwd: process.cwd(),
    shell: NodePath.sep === '\\',
    stdio: 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const runPrettier = (check: boolean, files?: ReadonlyArray<string>): void =>
{
  run('prettier', [
    check ? '--check' : '--write',
    '--no-error-on-unmatched-pattern',
    ...(files ?? [prettierGlob]),
  ])
}

const runOxfmt = (check: boolean, files?: ReadonlyArray<string>): void =>
{
  run('vp', [
    'fmt',
    ...(check ? ['--check'] : []),
    '--no-error-on-unmatched-pattern',
    ...(files ?? []),
  ])
}

const runStaged = (check: boolean, prettierOnly: boolean, values: ReadonlyArray<string>): void =>
{
  const files = values.flatMap((value) =>
  {
    const file = runnableFile(value)
    return file === undefined ? [] : [file]
  })
  const prettierFiles = files.filter((file) => prettierExtensions.has(NodePath.extname(file)))
  const oxfmtFiles = prettierOnly
    ? []
    : files.filter((file) => !prettierExtensions.has(NodePath.extname(file)))

  if (prettierFiles.length > 0) runPrettier(check, prettierFiles)
  if (oxfmtFiles.length > 0) runOxfmt(check, oxfmtFiles)
}

const args = process.argv.slice(2)
const check = args.includes('--check')
const prettierOnly = args.includes('--prettier-only')
const stagedIndex = args.indexOf('--staged')

if (stagedIndex !== -1)
{
  runStaged(check, prettierOnly, args.slice(stagedIndex + 1))
}
else
{
  runPrettier(check)
  if (!prettierOnly) runOxfmt(check)
}
