// apps/mobile/modules/code456-markdown-text/scripts/sync-pierre-file-icons.mjs
// synchronizes checked-in mobile assets from the neutral pierre icon catalog

import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

import { getBuiltInSpriteSheet } from '@pierre/trees'
import {
  PIERRE_CUSTOM_FILE_ICON_BY_FILE_NAME,
  PIERRE_CUSTOM_FILE_ICON_SPRITE,
  PIERRE_MOBILE_CUSTOM_ICON_BY_TOKEN,
} from '@t3tools/shared/pierreFileIcons'

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))
const moduleDirectory = NodePath.resolve(scriptDirectory, '..')
const repositoryRoot = NodePath.resolve(moduleDirectory, '../../../..')
const outputDirectory = NodePath.join(moduleDirectory, 'assets/file-icons')
const generatedModulePath = NodePath.join(moduleDirectory, 'src/markdownFileIcons.generated.ts')
const recoveryMarkerPath = NodePath.join(moduleDirectory, '.pierre-file-icons-recovery.json')

const colors = {
  astro: '#a631be',
  babel: '#d5a910',
  bash: '#199f43',
  biome: '#1a85d4',
  bootstrap: '#693acf',
  browserslist: '#d5a910',
  bun: '#594c5b',
  c: '#1a85d4',
  claude: '#d47628',
  cpp: '#1a85d4',
  css: '#693acf',
  database: '#a631be',
  default: '#84848a',
  docker: '#1a85d4',
  eslint: '#693acf',
  font: '#84848a',
  git: '#ff8c5b',
  go: '#1ca1c7',
  graphql: '#d32a61',
  html: '#d47628',
  image: '#d32a61',
  javascript: '#d5a910',
  json: '#d47628',
  markdown: '#199f43',
  mcp: '#17a5af',
  nextjs: '#84848a',
  npm: '#d52c36',
  oxc: '#1ca1c7',
  postcss: '#d52c36',
  prettier: '#17a5af',
  python: '#1a85d4',
  react: '#1ca1c7',
  ruby: '#d52c36',
  rust: '#d47628',
  sass: '#d32a61',
  stylelint: '#84848a',
  svelte: '#d52c36',
  svg: '#d47628',
  svgo: '#199f43',
  swift: '#d47628',
  table: '#17a5af',
  tailwind: '#1ca1c7',
  terraform: '#693acf',
  text: '#84848a',
  typescript: '#1a85d4',
  vite: '#a631be',
  vscode: '#1a85d4',
  vue: '#199f43',
  wasm: '#693acf',
  webpack: '#1a85d4',
  yml: '#d52c36',
  zig: '#d47628',
  zip: '#d47628',
}

function fail(message)
{
  throw new Error(message)
}

function errorMessage(error)
{
  return error instanceof Error ? error.message : String(error)
}

function sortedUnique(values, label)
{
  const sorted = [...values].sort()
  if (new Set(sorted).size !== sorted.length)
  {
    fail(`Duplicate ${label}: ${sorted.join(', ')}`)
  }
  return sorted
}

function symbolIdsFromSprite(sprite)
{
  return [...sprite.matchAll(/<symbol\s+id="([^"]+)"/g)].map((match) => match[1])
}

export function validatePierreIconCatalog({
  customSprite = PIERRE_CUSTOM_FILE_ICON_SPRITE,
  byFileName = PIERRE_CUSTOM_FILE_ICON_BY_FILE_NAME,
  mobileCustomIcons = PIERRE_MOBILE_CUSTOM_ICON_BY_TOKEN,
} = {})
{
  const symbolIds = sortedUnique(symbolIdsFromSprite(customSprite), 'custom symbol ids')
  if (symbolIds.length === 0) fail('The custom Pierre icon sprite has no symbols')

  const knownSymbols = new Set(symbolIds)
  for (const [fileName, symbolId] of Object.entries(byFileName))
  {
    if (fileName !== fileName.toLowerCase() || fileName.trim() !== fileName)
    {
      fail(`Pierre exact filename must be normalized: ${fileName}`)
    }
    if (!knownSymbols.has(symbolId))
    {
      fail(`Pierre filename ${fileName} references missing symbol ${symbolId}`)
    }
  }

  for (const [token, symbolId] of Object.entries(mobileCustomIcons))
  {
    if (!/^[a-z][a-z0-9]*$/.test(token))
    {
      fail(`Pierre mobile token is not a generated-module identifier: ${token}`)
    }
    if (!knownSymbols.has(symbolId))
    {
      fail(`Pierre mobile token ${token} references missing symbol ${symbolId}`)
    }
  }

  return symbolIds
}

function symbolFromSprite(sprite, id)
{
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = sprite.match(new RegExp(`<symbol id="${escapedId}"([^>]*)>([\\s\\S]*?)<\\/symbol>`))
  if (!match) fail(`Missing Pierre icon symbol: ${id}`)
  return {
    body: match[2],
    viewBox: match[1].match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 16 16',
  }
}

export function buildGeneratedSource(tokens)
{
  return `// apps/mobile/modules/code456-markdown-text/src/markdownFileIcons.generated.ts
// maps pierre icon tokens to checked-in native assets

import type { ImageSourcePropType } from 'react-native'

export const MARKDOWN_FILE_ICON_SOURCES = {
${tokens.map((token) => `  ${token}: require('../assets/file-icons/pierre_${token}.png'),`).join('\n')}
} as const satisfies Readonly<Record<string, ImageSourcePropType>>
`
}

export function createGenerationPlan()
{
  validatePierreIconCatalog()

  const builtInSprite = getBuiltInSpriteSheet('complete')
  const builtInTokens = sortedUnique(
    [...builtInSprite.matchAll(/<symbol id="file-tree-builtin-([^"]+)"/g)].map((match) => match[1]),
    'Pierre built-in tokens',
  )
  const customTokens = Object.keys(PIERRE_MOBILE_CUSTOM_ICON_BY_TOKEN).sort()
  const tokens = [...new Set([...builtInTokens, ...customTokens])].sort()

  return {
    builtInSprite,
    builtInTokens,
    customTokens,
    tokens,
    expectedPngFileNames: tokens.map((token) => `pierre_${token}.png`),
    generatedSource: buildGeneratedSource(tokens),
  }
}

function renderIcon(targetDirectory, token, symbol, color)
{
  const svgPath = NodePath.join(targetDirectory, `.pierre-${token}.svg`)
  const pngPath = NodePath.join(targetDirectory, `pierre_${token}.png`)
  NodeFS.writeFileSync(
    svgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="${symbol.viewBox}" style="color:${color}">${symbol.body}</svg>`,
  )
  try
  {
    NodeChildProcess.execFileSync('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], {
      stdio: 'ignore',
    })
  }
  finally
  {
    NodeFS.rmSync(svgPath, { force: true })
  }
}

function renderPngOutput(targetDirectory, plan)
{
  // oxlint-disable-next-line 456code/no-global-process-runtime -- standalone asset generator has no Effect runtime.
  if (NodeOS.platform() !== 'darwin')
  {
    fail('PNG regeneration requires macOS sips; use --check for portable manifest validation')
  }

  NodeFS.mkdirSync(targetDirectory, { recursive: true })
  for (const token of plan.builtInTokens)
  {
    renderIcon(
      targetDirectory,
      token,
      symbolFromSprite(plan.builtInSprite, `file-tree-builtin-${token}`),
      colors[token] ?? colors.default,
    )
  }
  for (const [token, symbolId] of Object.entries(PIERRE_MOBILE_CUSTOM_ICON_BY_TOKEN))
  {
    renderIcon(
      targetDirectory,
      token,
      symbolFromSprite(PIERRE_CUSTOM_FILE_ICON_SPRITE, symbolId),
      colors[token] ?? colors.default,
    )
  }
}

function readExactFileSnapshot(directory, expectedFileNames)
{
  if (!NodeFS.existsSync(directory)) fail(`Missing Pierre icon output directory: ${directory}`)

  const entries = NodeFS.readdirSync(directory, { withFileTypes: true })
  const actualFileNames = entries.map((entry) => entry.name).sort()
  const expectedNames = [...expectedFileNames].sort()
  if (entries.some((entry) => !entry.isFile()))
  {
    fail(`Pierre icon output contains a non-file entry: ${directory}`)
  }
  if (JSON.stringify(actualFileNames) !== JSON.stringify(expectedNames))
  {
    fail(
      `Pierre icon manifest drift: expected ${expectedNames.join(', ')}, found ${actualFileNames.join(', ')}`,
    )
  }

  return new Map(
    expectedNames.map((fileName) => [
      fileName,
      NodeFS.readFileSync(NodePath.join(directory, fileName)),
    ]),
  )
}

function assertSnapshotsEqual(actual, expected, label)
{
  if (actual.size !== expected.size) fail(`${label} has a different file count`)
  for (const [fileName, expectedBytes] of expected)
  {
    const actualBytes = actual.get(fileName)
    if (!actualBytes?.equals(expectedBytes)) fail(`${label} differs at ${fileName}`)
  }
}

export function verifyGeneratedOutputContract({
  targetOutputDirectory,
  targetGeneratedModulePath,
  expectedPngFileNames,
  expectedGeneratedSource,
  expectedPngSnapshot,
})
{
  const actualSnapshot = readExactFileSnapshot(targetOutputDirectory, expectedPngFileNames)
  const actualGeneratedSource = NodeFS.readFileSync(targetGeneratedModulePath, 'utf8')
  if (actualGeneratedSource !== expectedGeneratedSource)
  {
    fail(`Generated Pierre icon module is stale: ${targetGeneratedModulePath}`)
  }
  if (expectedPngSnapshot)
  {
    assertSnapshotsEqual(actualSnapshot, expectedPngSnapshot, 'Generated Pierre PNG bytes')
  }
  return actualSnapshot
}

function outputMatchesPlan(plan, stagedPngSnapshot)
{
  try
  {
    verifyGeneratedOutputContract({
      targetOutputDirectory: outputDirectory,
      targetGeneratedModulePath: generatedModulePath,
      expectedPngFileNames: plan.expectedPngFileNames,
      expectedGeneratedSource: plan.generatedSource,
      expectedPngSnapshot: stagedPngSnapshot,
    })
    return true
  }
  catch
  {
    return false
  }
}

function publicationRecordFor(targetOutputDirectory, targetGeneratedModulePath)
{
  return {
    version: 1,
    outputDirectory: targetOutputDirectory,
    generatedModulePath: targetGeneratedModulePath,
    stagedOutputDirectory: NodePath.join(
      NodePath.dirname(targetOutputDirectory),
      '.pierre-file-icons.stage',
    ),
    stagedGeneratedModulePath: NodePath.join(
      NodePath.dirname(targetGeneratedModulePath),
      '.markdownFileIcons.generated.ts.stage',
    ),
    backupOutputDirectory: NodePath.join(
      NodePath.dirname(targetOutputDirectory),
      '.pierre-file-icons.backup',
    ),
    backupGeneratedModulePath: NodePath.join(
      NodePath.dirname(targetGeneratedModulePath),
      '.markdownFileIcons.generated.ts.backup',
    ),
    phase: 'staging',
  }
}

function assertRecoveryRecord(record, targetOutputDirectory, targetGeneratedModulePath)
{
  const expected = publicationRecordFor(targetOutputDirectory, targetGeneratedModulePath)
  for (const field of [
    'outputDirectory',
    'generatedModulePath',
    'stagedOutputDirectory',
    'stagedGeneratedModulePath',
    'backupOutputDirectory',
    'backupGeneratedModulePath',
  ])
  {
    if (record?.[field] !== expected[field]) fail(`Invalid Pierre recovery marker field: ${field}`)
  }
  if (record?.version !== 1) fail('Unsupported Pierre recovery marker version')
}

function createRecoveryMarker(markerPath, record)
{
  NodeFS.writeFileSync(markerPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
}

function updateRecoveryMarker(markerPath, record, phase)
{
  record.phase = phase
  const temporaryMarkerPath = `${markerPath}.tmp`
  NodeFS.writeFileSync(temporaryMarkerPath, `${JSON.stringify(record, null, 2)}\n`)
  NodeFS.renameSync(temporaryMarkerPath, markerPath)
}

function removePath(targetPath)
{
  NodeFS.rmSync(targetPath, { recursive: true, force: true })
}

function restorePublication(record, markerPath)
{
  if (NodeFS.existsSync(record.backupOutputDirectory))
  {
    removePath(record.outputDirectory)
    NodeFS.renameSync(record.backupOutputDirectory, record.outputDirectory)
  }
  if (NodeFS.existsSync(record.backupGeneratedModulePath))
  {
    removePath(record.generatedModulePath)
    NodeFS.renameSync(record.backupGeneratedModulePath, record.generatedModulePath)
  }

  removePath(record.stagedOutputDirectory)
  removePath(record.stagedGeneratedModulePath)
  removePath(record.backupOutputDirectory)
  removePath(record.backupGeneratedModulePath)
  NodeFS.rmSync(`${markerPath}.tmp`, { force: true })
  NodeFS.rmSync(markerPath, { force: true })
}

function finalizeCommittedPublication(record, markerPath)
{
  removePath(record.stagedOutputDirectory)
  removePath(record.stagedGeneratedModulePath)
  removePath(record.backupOutputDirectory)
  removePath(record.backupGeneratedModulePath)
  NodeFS.rmSync(`${markerPath}.tmp`, { force: true })
  NodeFS.rmSync(markerPath, { force: true })
}

export function recoverInterruptedPublication({
  targetOutputDirectory,
  targetGeneratedModulePath,
  markerPath,
})
{
  if (!NodeFS.existsSync(markerPath)) return false

  const record = JSON.parse(NodeFS.readFileSync(markerPath, 'utf8'))
  assertRecoveryRecord(record, targetOutputDirectory, targetGeneratedModulePath)
  if (record.phase === 'committed')
  {
    finalizeCommittedPublication(record, markerPath)
    return 'committed'
  }
  restorePublication(record, markerPath)
  return 'rolled-back'
}

export function publishStagedOutputs({
  sourceOutputDirectory,
  sourceGeneratedModulePath,
  targetOutputDirectory,
  targetGeneratedModulePath,
  markerPath,
  expectedPngFileNames,
  expectedGeneratedSource,
  failurePoint,
})
{
  const record = publicationRecordFor(targetOutputDirectory, targetGeneratedModulePath)
  for (const artifactPath of [
    markerPath,
    `${markerPath}.tmp`,
    record.stagedOutputDirectory,
    record.stagedGeneratedModulePath,
    record.backupOutputDirectory,
    record.backupGeneratedModulePath,
  ])
  {
    if (NodeFS.existsSync(artifactPath))
    {
      fail(`Pierre publication artifact already exists; recover it first: ${artifactPath}`)
    }
  }

  const sourcePngSnapshot = readExactFileSnapshot(sourceOutputDirectory, expectedPngFileNames)
  const sourceGeneratedBytes = NodeFS.readFileSync(sourceGeneratedModulePath)
  if (sourceGeneratedBytes.toString('utf8') !== expectedGeneratedSource)
  {
    fail(`Staged Pierre generated module is invalid: ${sourceGeneratedModulePath}`)
  }
  const oldPngSnapshot = readExactFileSnapshot(targetOutputDirectory, expectedPngFileNames)
  const oldGeneratedBytes = NodeFS.readFileSync(targetGeneratedModulePath)

  createRecoveryMarker(markerPath, record)
  try
  {
    NodeFS.cpSync(sourceOutputDirectory, record.stagedOutputDirectory, {
      recursive: true,
      errorOnExist: true,
    })
    NodeFS.copyFileSync(sourceGeneratedModulePath, record.stagedGeneratedModulePath)
    verifyGeneratedOutputContract({
      targetOutputDirectory: record.stagedOutputDirectory,
      targetGeneratedModulePath: record.stagedGeneratedModulePath,
      expectedPngFileNames,
      expectedGeneratedSource,
      expectedPngSnapshot: sourcePngSnapshot,
    })
    updateRecoveryMarker(markerPath, record, 'staged')

    NodeFS.renameSync(targetOutputDirectory, record.backupOutputDirectory)
    assertSnapshotsEqual(
      readExactFileSnapshot(record.backupOutputDirectory, expectedPngFileNames),
      oldPngSnapshot,
      'Pierre icon backup',
    )
    updateRecoveryMarker(markerPath, record, 'icons-backed-up')
    NodeFS.renameSync(record.stagedOutputDirectory, targetOutputDirectory)
    updateRecoveryMarker(markerPath, record, 'icons-published')
    if (failurePoint === 'after-icons') fail('Injected failure after Pierre icon publication')

    NodeFS.renameSync(targetGeneratedModulePath, record.backupGeneratedModulePath)
    if (!NodeFS.readFileSync(record.backupGeneratedModulePath).equals(oldGeneratedBytes))
    {
      fail('Pierre generated-module backup verification failed')
    }
    updateRecoveryMarker(markerPath, record, 'module-backed-up')
    NodeFS.renameSync(record.stagedGeneratedModulePath, targetGeneratedModulePath)
    updateRecoveryMarker(markerPath, record, 'module-published')
    if (failurePoint === 'after-module') fail('Injected failure after Pierre module publication')

    verifyGeneratedOutputContract({
      targetOutputDirectory,
      targetGeneratedModulePath,
      expectedPngFileNames,
      expectedGeneratedSource,
      expectedPngSnapshot: sourcePngSnapshot,
    })
    updateRecoveryMarker(markerPath, record, 'committed')
    finalizeCommittedPublication(record, markerPath)
  }
  catch (error)
  {
    if (record.phase === 'committed')
    {
      try
      {
        finalizeCommittedPublication(record, markerPath)
        return
      }
      catch (cleanupError)
      {
        fail(
          `${errorMessage(error)}; committed output cleanup failed: ${errorMessage(cleanupError)}; recovery marker: ${markerPath}`,
        )
      }
    }
    try
    {
      restorePublication(record, markerPath)
    }
    catch (restoreError)
    {
      fail(
        `${errorMessage(error)}; automatic rollback failed: ${errorMessage(restoreError)}; recovery marker: ${markerPath}`,
      )
    }
    throw error
  }
}

function assertTrackedOutputIsClean()
{
  const relativeOutputDirectory = NodePath.relative(repositoryRoot, outputDirectory)
  const relativeGeneratedModulePath = NodePath.relative(repositoryRoot, generatedModulePath)
  const status = NodeChildProcess.execFileSync(
    'git',
    [
      '-C',
      repositoryRoot,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      relativeOutputDirectory,
      relativeGeneratedModulePath,
    ],
    { encoding: 'utf8' },
  ).trim()
  if (status)
  {
    fail(`Refusing to overwrite dirty Pierre generated output:\n${status}`)
  }
}

function makeDisposableStage(plan, includePngBytes)
{
  const temporaryDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), '456code-pierre-icons-'),
  )
  const stagedOutputDirectory = NodePath.join(temporaryDirectory, 'file-icons')
  const stagedGeneratedModulePath = NodePath.join(
    temporaryDirectory,
    'markdownFileIcons.generated.ts',
  )

  if (includePngBytes) renderPngOutput(stagedOutputDirectory, plan)
  NodeFS.writeFileSync(stagedGeneratedModulePath, plan.generatedSource)
  return { temporaryDirectory, stagedOutputDirectory, stagedGeneratedModulePath }
}

function checkGeneratedOutputs(plan)
{
  if (NodeFS.existsSync(recoveryMarkerPath))
  {
    fail(`Interrupted Pierre publication requires recovery: ${recoveryMarkerPath}`)
  }

  // oxlint-disable-next-line 456code/no-global-process-runtime -- standalone asset generator has no Effect runtime.
  if (NodeOS.platform() !== 'darwin')
  {
    verifyGeneratedOutputContract({
      targetOutputDirectory: outputDirectory,
      targetGeneratedModulePath: generatedModulePath,
      expectedPngFileNames: plan.expectedPngFileNames,
      expectedGeneratedSource: plan.generatedSource,
    })
    console.log(
      `Verified Pierre catalog, ${plan.tokens.length}-file manifest, and generated TypeScript; PNG bytes require macOS sips`,
    )
    return
  }

  const stage = makeDisposableStage(plan, true)
  try
  {
    const stagedPngSnapshot = readExactFileSnapshot(
      stage.stagedOutputDirectory,
      plan.expectedPngFileNames,
    )
    verifyGeneratedOutputContract({
      targetOutputDirectory: outputDirectory,
      targetGeneratedModulePath: generatedModulePath,
      expectedPngFileNames: plan.expectedPngFileNames,
      expectedGeneratedSource: plan.generatedSource,
      expectedPngSnapshot: stagedPngSnapshot,
    })
    console.log(
      `Verified Pierre catalog, generated TypeScript, and ${plan.tokens.length} PNG bytes with macOS sips`,
    )
  }
  finally
  {
    removePath(stage.temporaryDirectory)
  }
}

function generateOutputs(plan)
{
  const recoveryResult = recoverInterruptedPublication({
    targetOutputDirectory: outputDirectory,
    targetGeneratedModulePath: generatedModulePath,
    markerPath: recoveryMarkerPath,
  })
  if (recoveryResult === 'rolled-back')
  {
    console.log('Recovered the previous Pierre icon output pair before regeneration')
  }
  else if (recoveryResult === 'committed')
  {
    console.log('Completed cleanup for the previously committed Pierre icon output pair')
  }

  const stage = makeDisposableStage(plan, true)
  try
  {
    const stagedPngSnapshot = readExactFileSnapshot(
      stage.stagedOutputDirectory,
      plan.expectedPngFileNames,
    )
    if (outputMatchesPlan(plan, stagedPngSnapshot))
    {
      console.log(`Pierre icon output is already current (${plan.tokens.length} PNGs)`)
      return
    }

    assertTrackedOutputIsClean()
    publishStagedOutputs({
      sourceOutputDirectory: stage.stagedOutputDirectory,
      sourceGeneratedModulePath: stage.stagedGeneratedModulePath,
      targetOutputDirectory: outputDirectory,
      targetGeneratedModulePath: generatedModulePath,
      markerPath: recoveryMarkerPath,
      expectedPngFileNames: plan.expectedPngFileNames,
      expectedGeneratedSource: plan.generatedSource,
    })
    console.log(`Published ${plan.tokens.length} Pierre PNGs and the generated TypeScript map`)
  }
  finally
  {
    removePath(stage.temporaryDirectory)
  }
}

function main()
{
  const args = process.argv.slice(2)
  if (args.some((argument) => argument !== '--check'))
  {
    fail(`Unknown Pierre icon sync argument: ${args.find((argument) => argument !== '--check')}`)
  }

  const plan = createGenerationPlan()
  if (args.includes('--check')) checkGeneratedOutputs(plan)
  else generateOutputs(plan)
}

const invokedScriptPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined
if (invokedScriptPath === NodeURL.fileURLToPath(import.meta.url))
{
  try
  {
    main()
  }
  catch (error)
  {
    console.error(errorMessage(error))
    process.exitCode = 1
  }
}
