// oxlint-plugin-456code/index.ts
// register repository-specific Oxlint rules

import { definePlugin } from '@oxlint/plugins'

import blockDocComments from './rules/block-doc-comments.ts'
import commentTags from './rules/comment-tags.ts'
import fileHeader from './rules/file-header.ts'
import namespaceNodeImports from './rules/namespace-node-imports.ts'
import noGlobalProcessRuntime from './rules/no-global-process-runtime.ts'
import noInlineProse from './rules/no-inline-prose.ts'
import noInlineSchemaCompile from './rules/no-inline-schema-compile.ts'
import noManualEffectRuntimeInTests from './rules/no-manual-effect-runtime-in-tests.ts'
import noMobileUniwindThemeEscapeHatches from './rules/no-mobile-uniwind-theme-escape-hatches.ts'
import noUnicodeArrow from './rules/no-unicode-arrow.ts'
import plainCommentCase from './rules/plain-comment-case.ts'

export default definePlugin({
  meta: {
    name: '456code',
  },
  rules: {
    'block-doc-comments': blockDocComments,
    'comment-tags': commentTags,
    'file-header': fileHeader,
    'namespace-node-imports': namespaceNodeImports,
    'no-global-process-runtime': noGlobalProcessRuntime,
    'no-inline-prose': noInlineProse,
    'no-inline-schema-compile': noInlineSchemaCompile,
    'no-manual-effect-runtime-in-tests': noManualEffectRuntimeInTests,
    'no-mobile-uniwind-theme-escape-hatches': noMobileUniwindThemeEscapeHatches,
    'no-unicode-arrow': noUnicodeArrow,
    'plain-comment-case': plainCommentCase,
  },
})
