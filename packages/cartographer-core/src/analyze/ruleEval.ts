// packages/cartographer-core/src/analyze/ruleEval.ts
// fs-free dependency-rule evaluation for a single (from,to) file pair

import type { GraphRule } from '../contracts/types.js'
import { matchesRule } from './glob.js'

// sorted ids of the rules one edge violates; undefined -> clean edge
export type EdgeViolationEvaluator = (from: string, to: string) => string[] | undefined

// per-rule predicates bound once per rule set; glob.ts memoizes the compiled
// patterns, so pattern compilation happens on the first edge, not every edge
interface PreparedRule
{
  id: string
  generated: boolean
  matchesFrom: (fileId: string) => boolean
  matchesTo: (fileId: string) => boolean
  // allow-only rules exempt sources that route through the sanctioned path
  matchesAllowVia?: (fileId: string) => boolean
}

function prepareRule(
  rule: GraphRule,
  consumeWork: ((amount: number) => void) | undefined,
): PreparedRule
{
  // graph.ts compiles allowVia as the `from` clause's pathNot, so it is read
  // against the source file id & only for allow-only verdicts
  const allowVia = rule.verdict === 'allow-only' ? rule.allowVia : undefined
  let matchesAllowVia: ((fileId: string) => boolean) | undefined
  if (allowVia !== undefined)
  {
    matchesAllowVia = (fileId): boolean =>
    {
      for (const pattern of allowVia)
      {
        consumeWork?.(1)
        if (matchesRule(fileId, pattern))
        {
          return true
        }
      }
      return false
    }
  }
  return {
    id: rule.id,
    generated: rule.generated === true,
    matchesFrom: (fileId) => matchesRule(fileId, rule.from),
    matchesTo: (fileId) => matchesRule(fileId, rule.to),
    ...(matchesAllowVia !== undefined ? { matchesAllowVia } : {}),
  }
}

// mirrors the ruleSet graph.ts hands dependency-cruiser: `to` targets are
// repo-relative path globs only, so no package-name resolution happens here
export function compileRuleEvaluator(
  rules: readonly GraphRule[],
  consumeWork?: (amount: number) => void,
): EdgeViolationEvaluator
{
  if (rules.length === 0)
  {
    return () => undefined
  }
  const prepared: PreparedRule[] = []
  for (const rule of rules)
  {
    consumeWork?.(1)
    prepared.push(prepareRule(rule, consumeWork))
  }
  return (from, to) =>
  {
    const authored: string[] = []
    const generated: string[] = []
    for (const rule of prepared)
    {
      consumeWork?.(1)
      if (!rule.matchesFrom(from))
      {
        continue
      }
      consumeWork?.(1)
      if (!rule.matchesTo(to))
      {
        continue
      }
      if (rule.matchesAllowVia?.(from))
      {
        continue
      }
      ;(rule.generated ? generated : authored).push(rule.id)
    }
    // authored ids win when both kinds fire on one edge, exactly like the
    // foldedViolationIds pass in graph.ts
    const violated =
      authored.length > 0 && generated.length > 0 ? authored : authored.concat(generated)
    return violated.length > 0 ? violated.sort() : undefined
  }
}
