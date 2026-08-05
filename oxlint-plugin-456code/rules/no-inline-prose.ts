// oxlint-plugin-456code/rules/no-inline-prose.ts
// keep prose comments above the code they explain

import { defineRule } from '@oxlint/plugins'

import { toolingDirective } from './comment-utils.ts'

export default defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow prose comments beside code.' },
  },
  create(context)
  {
    return {
      Program()
      {
        for (const comment of context.sourceCode.getAllComments())
        {
          if (comment.type !== 'Line' || toolingDirective.test(comment.value.trim())) continue
          const location = context.sourceCode.getLoc(comment)
          const lineStart = context.sourceCode.lineStartIndices[location.start.line - 1]
          if (lineStart === undefined) continue
          const [start] = context.sourceCode.getRange(comment)
          if (!context.sourceCode.text.slice(lineStart, start).trim()) continue
          context.report({ node: comment, message: 'Move prose comments above the code.' })
        }
      },
    }
  },
})
