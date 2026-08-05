// oxlint-plugin-456code/rules/no-unicode-arrow.ts
// replace Unicode arrows in comments with ASCII ->

import { defineRule } from '@oxlint/plugins'

import { wrapComment } from './comment-utils.ts'

const unicodeArrow = /[→⇒]/u

export default defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow Unicode arrows in comments.' },
    fixable: 'code',
  },
  create(context)
  {
    return {
      Program()
      {
        for (const comment of context.sourceCode.getAllComments())
        {
          if (comment.type === 'Shebang' || !unicodeArrow.test(comment.value)) continue
          context.report({
            node: comment,
            message: 'Use ASCII `->` instead of Unicode arrows in comments.',
            fix: (fixer) =>
              fixer.replaceText(
                comment,
                wrapComment(comment, comment.value.replaceAll('→', '->').replaceAll('⇒', '->')),
              ),
          })
        }
      },
    }
  },
})
