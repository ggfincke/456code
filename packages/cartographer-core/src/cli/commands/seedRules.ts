// packages/cartographer-core/src/cli/commands/seedRules.ts
// opt-in seeder: resolve a target repo's eslint no-restricted-imports config into candidate rules[] on stdout

import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { CONFIG_FILE, loadConfig, MAX_RULES, type AuthoredGraphRule } from '../../analyze/config.js'
import { matchesRule } from '../../analyze/glob.js'
import type { CliValues } from '../lib/args.js'

// walking is bounded so a monorepo can't turn a review aid into a full crawl
const MAX_WALK_FILES = 2000
// how many directory segments a "from" glob may name before a partially
// restricted directory is reported instead of split further
const MAX_FROM_DEPTH = 4
// a partially restricted directory is only spelled out file by file while the
// list stays short enough to read
const MAX_FILE_FROMS = 4
// one restriction spread across more directories than this is reported rather
// than emitted: a long partial list reads like a boundary it does not describe
const MAX_FROMS_PER_CANDIDATE = 8
const MAX_WHY_LENGTH = 1024
const MAX_ID_LENGTH = 64
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git'])
// the ts variant takes the same option shape -> map both identically
const RESTRICTED_RULES = ['no-restricted-imports', '@typescript-eslint/no-restricted-imports']
const GLOB_METACHARS = /[*?[\]{}!]/

interface SkippedNote
{
  reason: string
  detail: string
}

// one restriction as resolved for one file
interface Candidate
{
  ruleName: string
  to: string
  why?: string
}

// a directory of walked files; "from" globs are picked per subtree, so the
// tree keeps the counts a glob has to be proven against
interface DirNode
{
  files: string[]
  children: Map<string, DirNode>
  total: number
}

interface SeedRulesOutput
{
  rules: AuthoredGraphRule[]
  skipped: SkippedNote[]
  sampled: { directories: number; files: number }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// eslint severities that actually restrict -> 'off'/0 configs are inert
const isActiveSeverity = (value: unknown): boolean =>
  value === 'error' || value === 'warn' || value === 2 || value === 1

const isSourceFile = (name: string): boolean => SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))

const toPosix = (value: string): string => value.split(NodePath.sep).join('/')

// whole subtree; '' is the walk root itself
const subtreePattern = (key: string): string => (key === '' ? '**' : `${key}/**`)

// files sitting directly in the directory -> one extra segment only, so sibling
// subtrees are never swallowed by a shallow prefix
const directPattern = (key: string): string => (key === '' ? '*' : `${key}/*`)

const slugify = (value: string): string =>
{
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'any' : slug
}

const trimSlug = (value: string, max: number): string => value.slice(0, max).replace(/-+$/, '')

// strip control chars & bound length so the message survives config validation
const sanitizeWhy = (value: string): string | undefined =>
{
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_WHY_LENGTH)
  return cleaned === '' ? undefined : cleaned
}

// breadth-first walk of the sampling root, skipping vendored/build output
const walkSourceFiles = (root: string, startDir: string): string[] =>
{
  const files: string[] = []
  const queue = [startDir]
  while (queue.length > 0 && files.length < MAX_WALK_FILES)
  {
    const dir = queue.shift()
    if (dir === undefined)
    {
      break
    }
    let entries
    try
    {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true })
    }
    catch
    {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
    {
      if (entry.name.startsWith('.') && entry.name !== '.')
      {
        continue
      }
      const full = NodePath.join(dir, entry.name)
      if (entry.isDirectory())
      {
        if (!SKIP_DIRS.has(entry.name))
        {
          queue.push(full)
        }
        continue
      }
      if (entry.isFile() && isSourceFile(entry.name))
      {
        files.push(toPosix(NodePath.relative(root, full)))
        if (files.length >= MAX_WALK_FILES)
        {
          break
        }
      }
    }
  }
  return files
}

const buildTree = (files: string[]): DirNode =>
{
  const root: DirNode = { files: [], children: new Map(), total: 0 }
  for (const file of files)
  {
    const segments = file.split('/')
    let node = root
    node.total += 1
    for (const segment of segments.slice(0, -1))
    {
      let child = node.children.get(segment)
      if (child === undefined)
      {
        child = { files: [], children: new Map(), total: 0 }
        node.children.set(segment, child)
      }
      child.total += 1
      node = child
    }
    node.files.push(file)
  }
  return root
}

const nodeAt = (root: DirNode, key: string): DirNode | undefined =>
{
  if (key === '')
  {
    return root
  }
  let node: DirNode | undefined = root
  for (const segment of key.split('/'))
  {
    node = node?.children.get(segment)
  }
  return node
}

const sortedChildren = (node: DirNode): Array<[string, DirNode]> =>
  [...node.children].sort(([a], [b]) => a.localeCompare(b))

const countDirectories = (node: DirNode): number =>
{
  let count = node.files.length > 0 ? 1 : 0
  for (const child of node.children.values())
  {
    count += countDirectories(child)
  }
  return count
}

type Carries = (file: string) => boolean

const countCarriers = (node: DirNode, carries: Carries): number =>
{
  let count = 0
  for (const file of node.files)
  {
    if (carries(file))
    {
      count += 1
    }
  }
  for (const child of node.children.values())
  {
    count += countCarriers(child, carries)
  }
  return count
}

// notes are per (reason, detail) so repeated groups don't spam the review block
const noteSink = () =>
{
  const seen = new Set<string>()
  const notes: SkippedNote[] = []
  return {
    notes,
    add: (reason: string, detail: string): void =>
    {
      const key = `${reason}\u0000${detail}`
      if (seen.has(key))
      {
        return
      }
      seen.add(key)
      notes.push({ reason, detail })
    },
  }
}

type AddNote = (reason: string, detail: string) => void

// nuances the rules schema has no axis for -> reported, never silently dropped
const noteNuances = (entry: Record<string, unknown>, name: string, add: AddNote): void =>
{
  if (
    Array.isArray(entry.importNames) ||
    Array.isArray(entry.allowImportNames) ||
    typeof entry.importNamePattern === 'string' ||
    typeof entry.allowImportNamePattern === 'string'
  )
  {
    add(
      'import-names',
      `"${name}" restricts specific import names; rules[] has no symbol axis, so the candidate is broader than the lint rule`,
    )
  }
  if (entry.allowTypeImports === true)
  {
    add(
      'type-imports',
      `"${name}" allows type-only imports; rules[] has no modality axis, so the candidate is broader than the lint rule`,
    )
  }
}

// paths[] entries name exact modules -> flag any that are really globs, since
// they land in "to" verbatim & will be matched as patterns
const noteGlobMetachars = (name: string, add: AddNote): void =>
{
  if (GLOB_METACHARS.test(name))
  {
    add(
      'glob-metachars',
      `"${name}" is a paths[] module name containing glob metacharacters; it is emitted verbatim as a rules[] "to" pattern`,
    )
  }
}

const collectPathEntry = (
  entry: unknown,
  ruleName: string,
  add: AddNote,
  out: Candidate[],
): void =>
{
  if (typeof entry === 'string')
  {
    noteGlobMetachars(entry, add)
    out.push({ ruleName, to: entry })
    return
  }
  if (!isRecord(entry) || typeof entry.name !== 'string')
  {
    add(
      'unrecognized-option',
      `${ruleName}: path entry ${JSON.stringify(entry)} has no string "name"`,
    )
    return
  }
  const name = entry.name
  noteNuances(entry, name, add)
  noteGlobMetachars(name, add)
  const why = typeof entry.message === 'string' ? sanitizeWhy(entry.message) : undefined
  out.push({ ruleName, to: name, ...(why !== undefined ? { why } : {}) })
}

const collectPatternEntry = (
  entry: unknown,
  ruleName: string,
  add: AddNote,
  out: Candidate[],
): void =>
{
  if (typeof entry === 'string')
  {
    out.push({ ruleName, to: entry })
    return
  }
  if (!isRecord(entry))
  {
    add(
      'unrecognized-option',
      `${ruleName}: pattern entry ${JSON.stringify(entry)} is neither a string nor an object`,
    )
    return
  }
  const why = typeof entry.message === 'string' ? sanitizeWhy(entry.message) : undefined
  if (typeof entry.regex === 'string')
  {
    add('regex-pattern', `${ruleName}: regex restriction /${entry.regex}/ has no glob equivalent`)
    return
  }
  // group is documented as an array, but a lone string is accepted too
  const group =
    typeof entry.group === 'string'
      ? [entry.group]
      : Array.isArray(entry.group)
        ? entry.group
        : undefined
  if (group === undefined)
  {
    add('unrecognized-option', `${ruleName}: pattern entry has neither "group" nor "regex"`)
    return
  }
  for (const glob of group)
  {
    if (typeof glob !== 'string')
    {
      continue
    }
    noteNuances(entry, glob, add)
    out.push({ ruleName, to: glob, ...(why !== undefined ? { why } : {}) })
  }
}

// no-restricted-imports options are variadic: bare strings, path options, or a
// { paths, patterns } wrapper
const collectFromOptions = (options: unknown[], ruleName: string, add: AddNote): Candidate[] =>
{
  const out: Candidate[] = []
  for (const option of options)
  {
    if (typeof option === 'string')
    {
      collectPathEntry(option, ruleName, add, out)
      continue
    }
    if (!isRecord(option))
    {
      add(
        'unrecognized-option',
        `${ruleName}: option ${JSON.stringify(option)} is neither a string nor an object`,
      )
      continue
    }
    if (Array.isArray(option.paths) || Array.isArray(option.patterns))
    {
      for (const entry of Array.isArray(option.paths) ? option.paths : [])
      {
        collectPathEntry(entry, ruleName, add, out)
      }
      for (const entry of Array.isArray(option.patterns) ? option.patterns : [])
      {
        collectPatternEntry(entry, ruleName, add, out)
      }
      continue
    }
    collectPathEntry(option, ruleName, add, out)
  }
  return out
}

const candidatesForConfig = (resolved: unknown, add: AddNote): Candidate[] =>
{
  if (!isRecord(resolved) || !isRecord(resolved.rules))
  {
    return []
  }
  const rules = resolved.rules
  const candidates: Candidate[] = []
  for (const ruleName of RESTRICTED_RULES)
  {
    const entry = rules[ruleName]
    const severity = Array.isArray(entry) ? entry[0] : entry
    if (!isActiveSeverity(severity))
    {
      continue
    }
    const options = Array.isArray(entry) ? entry.slice(1) : []
    candidates.push(...collectFromOptions(options, ruleName, add))
  }
  return candidates
}

const candidateKey = (candidate: Candidate): string =>
  `${candidate.ruleName}\u0000${candidate.to}\u0000${candidate.why ?? ''}`

const candidateLabel = (candidate: Candidate): string => `${candidate.ruleName} "${candidate.to}"`

// eslint restricts module specifiers, rules[] "to" matches repo-relative file
// ids -> name the mismatch so the note explains why nothing was emitted
const targetKind = (to: string): string =>
{
  const first = to.split('/')[0] ?? ''
  if (first === '.' || first === '..')
  {
    return 'relative'
  }
  if (/^[~#@]/.test(first))
  {
    return 'alias/scoped-package'
  }
  if (!to.includes('/') && !GLOB_METACHARS.test(to))
  {
    return 'bare package'
  }
  return 'path'
}

// smallest set of globs covering the restricted files & nothing else: a subtree
// glob when the whole directory is restricted, otherwise a split into direct
// files & children so an unrestricted sibling can never be swallowed
const coverFroms = (
  key: string,
  node: DirNode,
  carries: Carries,
  label: string,
  add: AddNote,
  out: string[],
): void =>
{
  const carriers = countCarriers(node, carries)
  if (carriers === 0)
  {
    return
  }
  if (carriers === node.total)
  {
    out.push(subtreePattern(key))
    return
  }
  const where = key === '' ? '.' : key
  const depth = key === '' ? 0 : key.split('/').length
  if (depth >= MAX_FROM_DEPTH)
  {
    add(
      'unexpressible-scope',
      `${label}: ${carriers} of ${node.total} file(s) under "${where}" are restricted; splitting deeper than ${MAX_FROM_DEPTH} segments is refused, so nothing is emitted for it`,
    )
    return
  }
  const direct = node.files.filter(carries)
  if (direct.length > 0 && direct.length === node.files.length)
  {
    out.push(directPattern(key))
  }
  else if (direct.length > 0 && direct.length <= MAX_FILE_FROMS)
  {
    // few enough restricted files to name outright -> siblings stay untouched
    out.push(...direct)
  }
  else if (direct.length > 0)
  {
    add(
      'unexpressible-scope',
      `${label}: ${direct.length} of ${node.files.length} file(s) directly in "${where}" are restricted; naming them individually would take more than ${MAX_FILE_FROMS} rules`,
    )
  }
  for (const [name, child] of sortedChildren(node))
  {
    coverFroms(key === '' ? name : `${key}/${name}`, child, carries, label, add, out)
  }
}

// self-check through the real parser: written to an OS temp dir & removed
// immediately -> the target repo's .cartographer.json is never touched
const assertRulesParse = (rules: AuthoredGraphRule[]): void =>
{
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'cartographer-seed-'))
  try
  {
    NodeFS.writeFileSync(
      NodePath.join(dir, CONFIG_FILE),
      JSON.stringify({ groups: [], systems: [], rules }),
    )
    loadConfig(dir)
  }
  catch (err)
  {
    throw new Error(
      `seed-rules produced rules[] that fail config validation: ${err instanceof Error ? err.message : err}`,
      { cause: err },
    )
  }
  finally
  {
    NodeFS.rmSync(dir, { recursive: true, force: true })
  }
}

const loadEslint = async (): Promise<typeof import('eslint')> =>
{
  try
  {
    return await import('eslint')
  }
  catch (err)
  {
    throw new Error(
      'seed-rules needs eslint installed -> run it from a checkout with eslint available (e.g. `npm i --no-save eslint`)',
      { cause: err },
    )
  }
}

const isDirectory = (path: string): boolean =>
{
  try
  {
    return NodeFS.statSync(path).isDirectory()
  }
  catch
  {
    return false
  }
}

export const runSeedRules = async (root: string, values: CliValues): Promise<void> =>
{
  if (values['from-eslint'] !== true)
  {
    throw new Error(
      "seed-rules requires --from-eslint -> seeding executes the target repo's eslint.config.(mjs|js|cjs) in-process to resolve per-file restrictions, which is a different trust posture than reading .cartographer.json; pass --from-eslint to opt in",
    )
  }
  const resolvedRoot = NodePath.resolve(root)
  const { ESLint } = await loadEslint()
  const eslint = new ESLint({ cwd: resolvedRoot })
  const configPath = await eslint.findConfigFile()
  if (configPath === undefined)
  {
    throw new Error(`no eslint config found for ${resolvedRoot}`)
  }
  const configRelative = toPosix(NodePath.relative(resolvedRoot, configPath))
  console.error(`seed-rules: executing eslint config ${configPath}`)

  const srcDir = NodePath.join(resolvedRoot, 'src')
  const startDir = isDirectory(srcDir) ? srcDir : resolvedRoot
  const walkRootKey = toPosix(NodePath.relative(resolvedRoot, startDir))
  const { notes, add } = noteSink()
  const walked = walkSourceFiles(resolvedRoot, startDir)
  if (walked.length >= MAX_WALK_FILES)
  {
    add(
      'walk-cap',
      `the walk stopped at ${MAX_WALK_FILES} file(s); restrictions on files past the cap are invisible here`,
    )
  }

  // every walked file is resolved, not a per-directory sample: a "from" glob is
  // only emitted once no unrestricted file matches it, which needs the real
  // eslint config of each file the glob covers
  const files: string[] = []
  const byCandidate = new Map<string, { candidate: Candidate; files: Set<string> }>()
  for (const file of walked)
  {
    let config: unknown
    try
    {
      config = await eslint.calculateConfigForFile(NodePath.join(resolvedRoot, file))
    }
    catch (err)
    {
      add('config-error', `${file}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    files.push(file)
    for (const candidate of candidatesForConfig(config, add))
    {
      const id = candidateKey(candidate)
      const existing = byCandidate.get(id)
      if (existing === undefined)
      {
        byCandidate.set(id, { candidate, files: new Set([file]) })
      }
      else
      {
        existing.files.add(file)
      }
    }
  }
  const tree = buildTree(files)
  const walkRootNode = nodeAt(tree, walkRootKey)
  console.error(
    `seed-rules: resolved ${files.length} file(s) across ${walkRootNode === undefined ? 0 : countDirectories(walkRootNode)} directory(ies)`,
  )

  const pending: Array<{ from: string; candidate: Candidate }> = []
  for (const { candidate, files: carrierFiles } of [...byCandidate.values()].sort((a, b) =>
    candidateKey(a.candidate).localeCompare(candidateKey(b.candidate)),
  ))
  {
    if (walkRootNode === undefined)
    {
      break
    }
    const label = candidateLabel(candidate)
    const carries: Carries = (file) => carrierFiles.has(file)
    const kind = targetKind(candidate.to)
    // a package name is never a repo-relative file id, & config validation
    // rejects one as a rule target -> report it instead of emitting it
    if (kind === 'bare package')
    {
      add(
        'package-target',
        `${label}: the target is a package name, not a repo path; rules[] "to" matches repo-relative file ids, so no equivalent rule can be emitted`,
      )
      continue
    }
    // a target matching no walked file is an alias or a relative specifier ->
    // emitting it would be an inert rule that looks like an enforced boundary
    if (!files.some((file) => matchesRule(file, candidate.to)))
    {
      add(
        'unmatched-target',
        `${label}: the ${kind} target matches no walked file; rules[] "to" matches repo-relative file ids, so no equivalent rule can be emitted`,
      )
      continue
    }
    const froms: string[] = []
    coverFroms(walkRootKey, walkRootNode, carries, label, add, froms)
    if (froms.length > MAX_FROMS_PER_CANDIDATE)
    {
      add(
        'fragmented-scope',
        `${label}: the restriction is spread across ${froms.length} directories; more than ${MAX_FROMS_PER_CANDIDATE} rules would be needed, so it is left for a human to scope`,
      )
      continue
    }
    for (const from of froms)
    {
      // last line of defence: the emitted glob is replayed through the real
      // matcher against every walked file before it reaches the output
      const overreach = files.find((file) => matchesRule(file, from) && !carries(file))
      if (overreach !== undefined)
      {
        add(
          'unsafe-glob',
          `${label}: "${from}" also matches ${overreach}, which eslint does not restrict; the candidate is dropped instead of widened`,
        )
        continue
      }
      const selfImport = files.find(
        (file) => matchesRule(file, from) && matchesRule(file, candidate.to),
      )
      if (selfImport !== undefined)
      {
        add(
          'self-import',
          `${label}: "${from}" and the target both match ${selfImport}, so the rule would forbid that directory from importing itself; eslint reports no such violation`,
        )
        continue
      }
      pending.push({ from, candidate })
    }
  }
  if (pending.length > MAX_RULES)
  {
    add(
      'rule-cap',
      `${pending.length} candidates exceed the ${MAX_RULES}-rule config cap; the block is truncated`,
    )
  }

  const usedIds = new Set<string>()
  const rules: AuthoredGraphRule[] = pending.slice(0, MAX_RULES).map(({ from, candidate }) =>
  {
    const base = trimSlug(`${slugify(from)}-to-${slugify(candidate.to)}`, MAX_ID_LENGTH)
    let id = base
    let suffix = 2
    while (usedIds.has(id))
    {
      const tail = `-${suffix}`
      id = `${trimSlug(base, MAX_ID_LENGTH - tail.length)}${tail}`
      suffix += 1
    }
    usedIds.add(id)
    return {
      id,
      from,
      to: candidate.to,
      verdict: 'forbid' as const,
      ...(candidate.why !== undefined ? { why: candidate.why } : {}),
      enforcedBy: {
        mechanism: 'eslint',
        ...(configRelative !== '' ? { file: configRelative } : {}),
        rule: candidate.ruleName,
      },
    }
  })

  assertRulesParse(rules)
  const output: SeedRulesOutput = {
    rules,
    skipped: notes,
    sampled: {
      directories: walkRootNode === undefined ? 0 : countDirectories(walkRootNode),
      files: files.length,
    },
  }
  console.error(
    'seed-rules: candidates only -> review & paste into .cartographer.json yourself; nothing was written',
  )
  console.error(`seed-rules: ${rules.length} candidate rule(s), ${notes.length} skipped note(s)`)
  console.log(JSON.stringify(output, null, 2))
}
