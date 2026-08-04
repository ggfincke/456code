// oxlint-plugin-456code/rules/block-doc-comments.ts
// reserve sentence-style block docs for classes, interfaces, & enums

import type { Comment } from '@oxlint/plugins'
import { defineRule } from '@oxlint/plugins'

import { isTestFile, repoRelativePath, toolingDirective } from './comment-utils.ts'

const largeUnitTypes = new Set([
  'ClassDeclaration',
  'ClassExpression',
  'TSInterfaceDeclaration',
  'TSEnumDeclaration',
])
const blockTodo = /(?:^|\n)\s*\*?\s*TODO(?:\b|\()/iu

const isJsxComment = (text: string, range: readonly [number, number]): boolean =>
  text.slice(0, range[0]).trimEnd().endsWith('{') &&
  text.slice(range[1]).trimStart().startsWith('}')

const summaryParagraph = (comment: Comment): string =>
{
  const lines = comment.value
    .replace(/^\*/u, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/u, '').trim())
  const paragraph: Array<string> = []
  for (const line of lines)
  {
    if (!line)
    {
      if (paragraph.length > 0) break
      continue
    }
    if (line.startsWith('@')) break
    paragraph.push(line)
  }
  return paragraph.join(' ')
}

const nodeType = (value: unknown): string | undefined =>
{
  let current = value
  while (typeof current === 'object' && current !== null && 'type' in current)
  {
    if (current.type === 'Decorator' && 'parent' in current)
    {
      current = current.parent
      continue
    }
    if (
      (current.type === 'ExportDefaultDeclaration' || current.type === 'ExportNamedDeclaration') &&
      'declaration' in current
    )
    {
      current = current.declaration
      continue
    }
    return typeof current.type === 'string' ? current.type : undefined
  }
  return undefined
}

export default defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Allow sentence-style block docs only on large declarations.' },
  },
  create(context)
  {
    return {
      Program()
      {
        const source = context.sourceCode
        const testFile = isTestFile(repoRelativePath(context))
        for (const comment of source.getAllComments())
        {
          if (comment.type !== 'Block') continue
          const range = source.getRange(comment)
          if (isJsxComment(source.text, range)) continue
          const directive = comment.value.replace(/^\*\s?/u, '').trim()
          if (toolingDirective.test(directive)) continue

          if (!comment.value.startsWith('*'))
          {
            if (!toolingDirective.test(comment.value.trim()))
            {
              context.report({
                node: comment,
                message: 'Use line comments for implementation rationale.',
              })
            }
            continue
          }
          if (blockTodo.test(comment.value))
          {
            context.report({
              node: comment,
              message: 'TODO annotations use line comments outside block documentation.',
            })
            continue
          }
          if (testFile)
          {
            context.report({
              node: comment,
              message: 'Tests use plain comments, not block documentation.',
            })
            continue
          }

          const token = source.getTokenAfter(comment)
          if (token === null)
          {
            context.report({
              node: comment,
              message: 'Attach block documentation directly to its declaration.',
            })
            continue
          }
          const tokenStart = source.getRange(token)[0]
          const gap = source.text.slice(range[1], tokenStart)
          if (!/^\s*$/u.test(gap) || (gap.match(/\n/gu)?.length ?? 0) > 1)
          {
            context.report({
              node: comment,
              message: 'Attach block documentation directly to its declaration.',
            })
            continue
          }
          const targetType = nodeType(source.getNodeByRangeIndex(tokenStart))
          if (targetType === undefined || !largeUnitTypes.has(targetType))
          {
            context.report({
              node: comment,
              message: 'Block documentation belongs on classes, interfaces, and enums.',
            })
            continue
          }

          const summary = summaryParagraph(comment)
          if (
            !summary ||
            !(
              /^[A-Z0-9]/u.test(summary) ||
              ['`', "'", '"', '(', '['].includes(summary[0] ?? '') ||
              /^[a-z][A-Z]/u.test(summary)
            )
          )
          {
            context.report({
              node: comment,
              message: 'Block documentation must begin with a capitalized summary sentence.',
            })
          }
          if (summary && !/[.!?](?:[`'"\])}]*)$/u.test(summary))
          {
            context.report({
              node: comment,
              message: 'Block documentation summary must end with punctuation.',
            })
          }
        }
      },
    }
  },
})
