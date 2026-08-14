// packages/cartographer-core/src/analyze/citations.ts
// verifies authored rule enforcement citations against the files they name

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import type { GraphRule } from '../contracts/types.js'
import { contentHash } from './annotations.js'

// a multi-MiB config citation is pathological; reading one per build is not
// worth it, so oversized files stay unverified
const MAX_CITATION_BYTES = 2 * 1024 * 1024

type RuleEnforcement = NonNullable<GraphRule['enforcedBy']>
type CitationStatus = NonNullable<RuleEnforcement['status']>

// stamps every authored rule's enforcedBy w/ a citation status (& a content
// hash when verified) so the UI can go amber once the cited config drifts
export function verifyCitations(root: string, rules: GraphRule[]): GraphRule[]
{
  const cache = new Map<string, string | undefined>()
  return rules.map((rule) =>
  {
    const enforcedBy = rule.enforcedBy
    // a rule that claims no enforcement has nothing to verify
    if (!enforcedBy || enforcedBy.mechanism === 'none')
    {
      return rule
    }
    if (!enforcedBy.file)
    {
      return stamp(rule, enforcedBy, 'citation-missing')
    }
    const text = readCited(root, enforcedBy.file, cache)
    if (text === undefined)
    {
      return stamp(rule, enforcedBy, 'citation-not-found')
    }
    // the cited file must actually name the rule it claims to enforce
    const needle = enforcedBy.rule ?? rule.id
    if (!text.includes(needle))
    {
      return stamp(rule, enforcedBy, 'citation-not-found')
    }
    return {
      ...rule,
      enforcedBy: {
        ...enforcedBy,
        status: 'verified' as const,
        fileHash: contentHash(text),
      },
    }
  })
}

function stamp(rule: GraphRule, enforcedBy: RuleEnforcement, status: CitationStatus): GraphRule
{
  return { ...rule, enforcedBy: { ...enforcedBy, status } }
}

// reads each cited path at most once per build; undefined -> unverifiable
function readCited(
  root: string,
  file: string,
  cache: Map<string, string | undefined>,
): string | undefined
{
  const full = NodePath.resolve(root, file)
  const cached = cache.get(full)
  if (cached !== undefined || cache.has(full))
  {
    return cached
  }
  const text = loadCited(root, full)
  cache.set(full, text)
  return text
}

function loadCited(root: string, full: string): string | undefined
{
  // a citation escaping the repo root cannot belong to this graph & would hash
  // a host file the snapshot never sees -> treat it as not found
  const rel = NodePath.relative(root, full)
  if (rel === '' || rel.startsWith('..') || NodePath.isAbsolute(rel))
  {
    return undefined
  }
  try
  {
    if (NodeFS.statSync(full).size > MAX_CITATION_BYTES)
    {
      return undefined
    }
    return NodeFS.readFileSync(full, 'utf-8')
  }
  catch
  {
    return undefined
  }
}
