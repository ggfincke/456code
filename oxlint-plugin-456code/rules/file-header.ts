// oxlint-plugin-456code/rules/file-header.ts
// validate exact two-line repo-relative file headers

import { defineRule } from '@oxlint/plugins'

import { commentLine, repoRelativePath } from './comment-utils.ts'

type HeaderOptions = {
  readonly prefixes?: ReadonlyArray<string>
  readonly root?: string
}

const taggedDescription = /^(?:[*!?](?:\s|$)|todo(?:\([^)]*\))?:?\s)/iu

export default defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Enforce exact path and purpose file headers.' },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: {
          prefixes: { type: 'array', items: { type: 'string' } },
          root: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context)
  {
    return {
      Program(node)
      {
        const options = (context.options[0] ?? {}) as HeaderOptions
        const relativePath = repoRelativePath(context, options.root)
        if (
          options.prefixes &&
          !options.prefixes.some((prefix) => relativePath.startsWith(prefix))
        )
        {
          return
        }

        const comments = context.sourceCode.getAllComments()
        const hasShebang = comments[0]?.type === 'Shebang'
        const index = hasShebang ? 1 : 0
        const headerLine = hasShebang ? 2 : 1
        const header = comments[index]
        if (header?.type !== 'Line' || commentLine(context, header) !== headerLine)
        {
          context.report({ node, message: 'File is missing a header comment with the file path.' })
          return
        }
        if (header.value.trim() !== relativePath)
        {
          context.report({
            node: header,
            message: `File header path must be ${relativePath}.`,
            fix: (fixer) => fixer.replaceText(header, `// ${relativePath}`),
          })
        }

        const description = comments[index + 1]
        if (
          description?.type !== 'Line' ||
          commentLine(context, description) !== headerLine + 1 ||
          !description.value.trim()
        )
        {
          context.report({ node: header, message: 'File header needs a purpose phrase on line 2.' })
          return
        }
        const purpose = description.value.trim()
        if (!/^[a-z0-9]/u.test(purpose))
        {
          if (/^[A-Z]/u.test(purpose))
          {
            context.report({
              node: description,
              message: 'File header purpose must begin with a lowercase letter or number.',
              fix: (fixer) =>
                fixer.replaceText(
                  description,
                  `// ${purpose[0]?.toLowerCase()}${purpose.slice(1)}`,
                ),
            })
          }
          else
          {
            context.report({
              node: description,
              message: 'File header purpose must begin with a lowercase letter or number.',
            })
          }
        }
        if (purpose.endsWith('.'))
        {
          context.report({
            node: description,
            message: 'File header purpose must not end with a period.',
            fix: (fixer) => fixer.replaceText(description, `// ${purpose.slice(0, -1)}`),
          })
        }
        if (taggedDescription.test(purpose))
        {
          context.report({
            node: description,
            message: 'File header purpose must be an untagged phrase.',
          })
        }

        const third = comments[index + 2]
        if (third?.type === 'Line' && commentLine(context, third) === headerLine + 2)
        {
          context.report({
            node: third,
            message: 'File headers contain exactly two consecutive comment lines.',
            fix: (fixer) => fixer.insertTextBefore(third, '\n'),
          })
        }
      },
    }
  },
})
