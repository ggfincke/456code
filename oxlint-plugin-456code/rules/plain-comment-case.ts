// oxlint-plugin-456code/rules/plain-comment-case.ts
// require lowercase starts for plain natural-language comments

import { defineRule } from '@oxlint/plugins'

import { isCodeLikeToken, toolingDirective, wrapComment } from './comment-utils.ts'

const structuredPrefix = /^(?:[*!?]\s|TODO(?:\([^)]*\):)?\s)/u
const decorativeBanner = /^(?:={3,}|-{3,})$/u

export default defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Require lowercase starts for plain comments.' },
    fixable: 'code',
  },
  create(context)
  {
    return {
      Program()
      {
        for (const comment of context.sourceCode.getAllComments())
        {
          if (comment.type !== 'Line') continue
          const text = comment.value.trim()
          if (decorativeBanner.test(text))
          {
            context.report({
              node: comment,
              message: 'Use a short plain comment instead of a decorative banner.',
            })
            continue
          }
          if (toolingDirective.test(text) || structuredPrefix.test(text))
          {
            continue
          }
          const token = text.match(/^([A-Z][^\s]*)/u)?.[1]
          if (token === undefined || isCodeLikeToken(token)) continue

          context.report({
            node: comment,
            message:
              'Plain comments start lowercase; preserve uppercase only for exact code symbols.',
            fix(fixer)
            {
              const lowered = /^(?:eslint|oxlint)(?=[\s.:,;!?]|$)/iu.test(text)
                ? text.replace(/^(?:eslint|oxlint)/iu, (tool) => tool.toLowerCase())
                : `${text[0]?.toLowerCase()}${text.slice(1)}`
              const value = comment.value.replace(text, lowered)
              return fixer.replaceText(comment, wrapComment(comment, value))
            },
          })
        }
      },
    }
  },
})
