// tests/packages/client-runtime/codexMarkdownDirectives.test.ts
// verifies strict Codex directive parsing across web, native, and clipboard adapters

import {
  remarkCodexDirectives,
  renderCodexDirectivesForCopy,
  renderCodexFileCitationsAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from '@t3tools/client-runtime/codex-markdown-directives'
import { describe, expect, it } from 'vite-plus/test'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

interface TestNode
{
  readonly type: string
  readonly value?: string
  readonly url?: string
  readonly data?: { readonly hProperties?: Readonly<Record<string, unknown>> }
  readonly children?: readonly TestNode[]
}

const FILE_CITATION = ':codex-file-citation{path="outputs/report.xlsx" purpose="output"}'
const ARTIFACT_TEMPLATE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}'

function parse(markdown: string): TestNode
{
  const processor = unified().use(remarkParse).use(remarkCodexDirectives)
  return processor.runSync(processor.parse(markdown), { value: markdown }) as TestNode
}

describe('Codex Markdown directives', () =>
{
  it('renders valid citations and templates as semantic nodes', () =>
  {
    expect(parse(`Created ${FILE_CITATION}.`).children?.[0]?.children?.[1]).toMatchObject({
      type: 'link',
      url: 'outputs/report.xlsx',
      children: [{ type: 'text', value: 'report.xlsx' }],
    })
    expect(parse(ARTIFACT_TEMPLATE).children?.[0]).toMatchObject({
      type: 'paragraph',
      data: {
        hProperties: {
          dataCodexArtifactTemplate: 'true',
          dataDisplayName: 'Hello World',
        },
      },
    })
  })

  it('keeps malformed, escaped, code, and nested-link directives literal', () =>
  {
    for (const markdown of [
      ':codex-file-citation{purpose="output"}',
      `\\${FILE_CITATION}`,
      `\`${FILE_CITATION}\``,
      `[See ${FILE_CITATION}](https://example.com)`,
    ])
    {
      expect(renderCodexFileCitationsAsMarkdown(markdown)).toBe(markdown)
    }
  })

  it('shares rendered copy and native template segmentation', () =>
  {
    const markdown = `Created ${FILE_CITATION}.\n\n${ARTIFACT_TEMPLATE}`
    expect(renderCodexDirectivesForCopy(markdown)).toBe(
      'Created [report.xlsx](<outputs/report.xlsx>).\n\nHello World (Document template)',
    )
    expect(splitCodexArtifactTemplateMarkdown(markdown)).toEqual([
      {
        kind: 'markdown',
        markdown: `Created ${FILE_CITATION}.\n\n`,
        sourceOffset: 0,
      },
      {
        kind: 'artifact-template',
        sourceOffset: markdown.indexOf(ARTIFACT_TEMPLATE),
        template: {
          artifactKind: 'document',
          displayName: 'Hello World',
          skillDirectory: '/Users/test/.codex/skills/artifact-template-hello-world',
          skillName: 'artifact-template-hello-world',
        },
      },
    ])
  })
})
