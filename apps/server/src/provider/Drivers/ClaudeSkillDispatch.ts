// apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts
// translate known Claude skill mentions into native slash invocations

// keep this aligned with the composer token grammar so every rendered skill
// chip is eligible for the same server-side dispatch decision.
const SKILL_MENTION_PATTERN =
  /(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g

export interface ClaudeSkillDispatch
{
  readonly leadingText: string | undefined
  readonly commandText: string
  readonly skillName: string
}

// claude expands only the final text block when it begins with `/name`. Move
// the last known mention there and preserve earlier mentions as inline slashes.
export function planClaudeSkillDispatch(
  prompt: string,
  skillNames: ReadonlySet<string>,
): ClaudeSkillDispatch | undefined
{
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) =>
  {
    const name = match[2] ?? ''
    if (!skillNames.has(name)) return []
    const start = (match.index ?? 0) + (match[1]?.length ?? 0)
    return [{ name, start, end: start + name.length + 1 }]
  })
  const last = mentions.at(-1)
  if (!last) return undefined

  const leading = prompt.slice(0, last.start)
  const trailing = prompt.slice(last.end)
  const leadingWithInlineSlashes = mentions
    .slice(0, -1)
    .reduceRight(
      (text, mention) => `${text.slice(0, mention.start)}/${text.slice(mention.start + 1)}`,
      leading,
    )
    .trimEnd()

  return {
    leadingText: leadingWithInlineSlashes.length > 0 ? leadingWithInlineSlashes : undefined,
    commandText: `/${last.name}${trailing}`.trimEnd(),
    skillName: last.name,
  }
}
