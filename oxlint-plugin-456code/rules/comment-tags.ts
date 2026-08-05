// oxlint-plugin-456code/rules/comment-tags.ts
// require canonical structured comment tags

import { defineRule } from '@oxlint/plugins'

const todoPrefix = /^\s*todo\b/iu
const validTodo = /^ TODO(?:\([a-z][a-z0-9._/-]*\):)?\s+\S/u
const tagPrefix = /^\s*([*!?])/u
const validTag = /^ [*!?] \S/u
// colon form flags any casing; the bare form must be an ALL-CAPS tag so
// ordinary sentences starting with "note ..." or "warning ..." stay legal
const legacyTagColon = /^\s*(?:FOOTGUN|HACK|NOTE|WARN(?:ING)?|FIXME|XXX)\s*:\s*/iu
const legacyTagBare = /^\s*(?:FOOTGUN|HACK|NOTE|WARN(?:ING)?|FIXME|XXX)(?=\s|$)/u

export default defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Enforce canonical structured comment tags.' },
  },
  create(context)
  {
    return {
      Program()
      {
        for (const comment of context.sourceCode.getAllComments())
        {
          if (comment.type !== 'Line') continue
          if (legacyTagColon.test(comment.value) || legacyTagBare.test(comment.value))
          {
            context.report({
              node: comment,
              message: 'Use a canonical `*`, `!`, `?`, or `TODO` annotation.',
            })
          }
          else if (todoPrefix.test(comment.value) && !validTodo.test(comment.value))
          {
            context.report({
              node: comment,
              message: 'Use `TODO action` or `TODO(scope): action` with a lowercase scope.',
            })
          }
          else if (tagPrefix.test(comment.value) && !validTag.test(comment.value))
          {
            context.report({
              node: comment,
              message: 'Use one space around the structured comment tag.',
            })
          }
        }
      },
    }
  },
})
