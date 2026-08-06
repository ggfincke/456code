// apps/web/src/lib/markdown/inline-code-paths.ts
// promotes inline code that reads as a workspace file path into a file link node

import { looksLikeInlineCodeFilePath } from './links'

type InlineCodePathAstNode = {
  type?: string
  value?: unknown
  data?: {
    hName?: string
    hProperties?: Record<string, unknown>
  }
  children?: InlineCodePathAstNode[]
}

const LINK_NODE_TYPES = new Set(['link', 'linkReference', 'image', 'imageReference'])

// rewrites `path/to/file.md` spans into anchors carrying `dataFilePathChip`, so
// the chat markdown `a` renderer can render them as file chips that open the
// preview. Code inside a link keeps the link's own destination and is skipped.
export function remarkLinkInlineCodePaths()
{
  return (tree: InlineCodePathAstNode) =>
  {
    const visit = (node: InlineCodePathAstNode, insideLink: boolean) =>
    {
      const withinLink = insideLink || LINK_NODE_TYPES.has(node.type ?? '')
      if (
        !withinLink &&
        node.type === 'inlineCode' &&
        typeof node.value === 'string' &&
        looksLikeInlineCodeFilePath(node.value)
      )
      {
        node.data = {
          ...node.data,
          hName: 'a',
          hProperties: {
            ...node.data?.hProperties,
            href: node.value.trim(),
            dataFilePathChip: 'true',
          },
        }
      }
      node.children?.forEach((child) => visit(child, withinLink))
    }

    visit(tree, false)
  }
}
