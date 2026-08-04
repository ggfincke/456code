// oxlint-plugin-456code/rules/comment-utils.ts
// share comment tokens, paths, directives, & safe comment fixers across style rules

// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from 'node:path'
import type { Comment, Context } from '@oxlint/plugins'

export const toolingDirective =
  /^(?:eslint(?:-disable(?:-next-line|-line)?|-enable|-env)\b|eslint\s+\S+\s*:|oxlint-(?:disable(?:-next-line|-line)?|enable)\b|prettier-ignore(?:-start|-end)?\b|@ts-|@effect-|@vite-|@(?:satisfies|template|type|typedef)\b|[@#]__PURE__|istanbul\s+ignore\b|(?:c8|v8)\s+ignore\b)/iu

export const normalizePath = (value: string): string => value.replaceAll('\\', '/')

export const repoRelativePath = (context: Context, explicitRoot?: string): string =>
{
  const root = explicitRoot ? NodePath.resolve(context.cwd, explicitRoot) : context.cwd
  return normalizePath(NodePath.relative(root, context.filename))
}

export const commentLine = (context: Context, comment: Comment): number =>
  context.sourceCode.getLoc(comment).start.line

export const wrapComment = (comment: Comment, value: string): string =>
  comment.type === 'Line' ? `//${value}` : `/*${value}*/`

export const isCodeLikeToken = (token: string): boolean =>
  !/^(?:eslint|oxlint)(?:[.:,;!?])?$/iu.test(token) &&
  (token === 'No.' || /[A-Z]/u.test(token.slice(1)) || /[._\d]/u.test(token))

export const isTestFile = (filename: string): boolean =>
  /(?:^|\/)(?:tests?|e2e)\//u.test(filename) || /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(filename)
