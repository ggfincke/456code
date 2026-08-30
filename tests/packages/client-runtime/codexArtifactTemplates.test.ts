// tests/packages/client-runtime/codexArtifactTemplates.test.ts
// verifies strict artifact metadata and idempotent follow-up prompt construction

import {
  appendCodexArtifactTemplateUsePrompt,
  resolveCodexArtifactTemplate,
  type CodexArtifactTemplate,
} from '@t3tools/client-runtime/codex-artifact-templates'
import { describe, expect, it } from 'vite-plus/test'

const TEMPLATE: CodexArtifactTemplate = {
  artifactKind: 'document',
  displayName: 'Hello World',
  skillDirectory: '/Users/test/.codex/skills/artifact-template-hello-world',
  skillName: 'artifact-template-hello-world',
}

describe('resolveCodexArtifactTemplate', () =>
{
  it('accepts valid Unix and Windows absolute template metadata', () =>
  {
    expect(
      resolveCodexArtifactTemplate({
        artifact_kind: 'document',
        display_name: '  Hello World  ',
        skill_directory: TEMPLATE.skillDirectory,
        skill_name: TEMPLATE.skillName,
      }),
    ).toEqual(TEMPLATE)
    expect(
      resolveCodexArtifactTemplate({
        artifact_kind: 'image',
        display_name: 'Reference image',
        gallery_kind: 'product-design',
        skill_directory: String.raw`C:\Users\test\.codex\skills\artifact-template-reference-image`,
        skill_name: 'artifact-template-reference-image',
      }),
    ).toMatchObject({ artifactKind: 'image', galleryKind: 'product-design' })
  })

  it('rejects relative directories, unsupported kinds, and unrelated skills', () =>
  {
    for (const override of [
      { artifact_kind: 'unknown' },
      { skill_directory: 'relative/template' },
      { skill_name: 'hello-world' },
      { gallery_kind: 'unknown' },
    ])
    {
      expect(
        resolveCodexArtifactTemplate({
          artifact_kind: 'document',
          display_name: 'Hello World',
          skill_directory: TEMPLATE.skillDirectory,
          skill_name: TEMPLATE.skillName,
          ...override,
        }),
      ).toBeNull()
    }
  })
})

describe('appendCodexArtifactTemplateUsePrompt', () =>
{
  it('preserves a draft and appends the same final prompt only once', () =>
  {
    const appended = appendCodexArtifactTemplateUsePrompt('Write about otters', TEMPLATE)
    expect(appended).toBe(
      'Write about otters Create a document using this $artifact-template-hello-world about…',
    )
    expect(appendCodexArtifactTemplateUsePrompt(appended, TEMPLATE)).toBe(appended)
  })
})
