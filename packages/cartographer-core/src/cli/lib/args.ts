// packages/cartographer-core/src/cli/lib/args.ts
// shared cli flag types & parsers

import type { BlastDirection, BuildGraphOptions } from '../../analyze/index.js'
import { hasGraph, loadGraph } from '../../store/index.js'
import type { CartographerGraph } from '../../contracts/types.js'

export interface CliValues
{
  scope?: string
  tsconfig?: string
  out?: string
  report?: boolean
  'no-history'?: boolean
  save?: boolean
  base?: string
  target?: string
  direction?: string
  'max-depth'?: string
  'base-ref'?: string
  'proposed-ref'?: string
  'analyzer-version'?: string
  'from-json'?: string
  // explicit opt-in for seed-rules -> executes the target repo's eslint config
  'from-eslint'?: boolean
  help?: boolean
}

export const graphBuildOptions = (
  root: string,
  values: CliValues,
  fallbackScope?: string,
): BuildGraphOptions =>
{
  const scope = values.scope ?? fallbackScope
  return {
    root,
    ...(scope === undefined ? {} : { scope }),
    ...(values.tsconfig === undefined ? {} : { tsconfig: values.tsconfig }),
  }
}

export const parseDirection = (value: string | undefined): BlastDirection =>
{
  const direction = value ?? 'both'
  if (direction !== 'both' && direction !== 'upstream' && direction !== 'downstream')
  {
    throw new Error(`invalid --direction "${direction}" -> use both, upstream, or downstream`)
  }
  return direction
}

// reject "1junk"/"1.5"/"1e3" outright instead of parseInt's partial parse (F19)
export const parsePositiveInt = (value: string, flag: string, max?: number): number =>
{
  if (!/^[1-9]\d*$/.test(value))
  {
    throw new Error(`invalid ${flag} "${value}" -> use a positive integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || (max !== undefined && parsed > max))
  {
    throw new Error(
      `invalid ${flag} "${value}" -> out of range${max !== undefined ? ` (1..${max})` : ''}`,
    )
  }
  return parsed
}

export const loadBaseline = (root: string, outDir?: string): CartographerGraph =>
{
  if (!hasGraph(root, outDir))
  {
    throw new Error(
      `no baseline graph -> run \`cartographer build\` first, then diff after changes`,
    )
  }
  return loadGraph(root, outDir)
}
