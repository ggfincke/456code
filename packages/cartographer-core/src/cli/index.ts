#!/usr/bin/env node
// packages/cartographer-core/src/cli/index.ts
// cartographer cli entrypoint

import * as NodeUtil from 'node:util'
import { loadGraph } from '../store/index.js'
import { runAnalyzeTrees } from './commands/analyzeTrees.js'
import { runAnnotate } from './commands/annotate.js'
import { runBlastRadius } from './commands/blastRadius.js'
import { runBuild } from './commands/build.js'
import { runCheckPr } from './commands/checkPr.js'
import { runDiff } from './commands/diff.js'
import { runPatches } from './commands/patches.js'
import { runSeedRules } from './commands/seedRules.js'
import { runSnapshots } from './commands/snapshots.js'
import { runWatch } from './commands/watch.js'
import type { CliValues } from './lib/args.js'
import { writeReport } from './lib/artifacts.js'
import { USAGE } from './lib/usage.js'

async function main(): Promise<void>
{
  const { values, positionals } = NodeUtil.parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      scope: { type: 'string' },
      tsconfig: { type: 'string' },
      out: { type: 'string' },
      report: { type: 'boolean' },
      'no-history': { type: 'boolean' },
      save: { type: 'boolean' },
      base: { type: 'string' },
      target: { type: 'string' },
      direction: { type: 'string' },
      'max-depth': { type: 'string' },
      'base-ref': { type: 'string' },
      'proposed-ref': { type: 'string' },
      'analyzer-version': { type: 'string' },
      'from-json': { type: 'string' },
      'from-eslint': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }) as { values: CliValues; positionals: string[] }

  const [command, rootArg, secondRootArg] = positionals
  if (values.help || !command)
  {
    process.stdout.write(USAGE)
    process.exitCode = command ? 0 : 1
    return
  }
  const root = rootArg ?? '.'

  switch (command)
  {
    case 'build':
      if (values['from-eslint'])
      {
        throw new Error('unknown option "--from-eslint" for command "build"')
      }
      await runBuild(root, values)
      return
    case 'report':
    {
      const graph = loadGraph(root, values.out)
      console.log(`report -> ${writeReport(graph, root, values.out)}`)
      return
    }
    case 'diff':
      await runDiff(root, values)
      return
    case 'check-pr':
      await runCheckPr(root, values)
      return
    case 'snapshots':
      runSnapshots(root, values)
      return
    case 'patches':
      runPatches(root, values)
      return
    case 'blast-radius':
      await runBlastRadius(root, values)
      return
    case 'annotate':
      await runAnnotate(root, values)
      return
    case 'seed-rules':
      await runSeedRules(root, values)
      return
    case 'watch':
      await runWatch(root, values)
      return
    case 'analyze-trees':
      if (!rootArg || !secondRootArg || positionals.length !== 3)
      {
        throw new Error('analyze-trees requires exactly <base-root> <proposed-root>')
      }
      await runAnalyzeTrees(rootArg, secondRootArg, values)
      return
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`)
  }
}

main().catch((err) =>
{
  console.error(`cartographer: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
