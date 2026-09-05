// tests/apps/web/components/chat/SkillInlineText.test.tsx
// verify skill chip token recognition

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'

import { SkillInlineText } from '../../../../../apps/web/src/components/chat/SkillInlineText'

describe('SkillInlineText', () =>
{
  it('renders digit-leading skills but leaves currency expressions as text', () =>
  {
    const skills = [{ name: '2spec', displayName: '2Spec' }]
    const markup = renderToStaticMarkup(
      <SkillInlineText text="Use $2spec after paying $20k" skills={skills} />,
    )

    expect(markup).toContain('data-markdown-copy="$2spec"')
    expect(markup).toContain('2Spec')
    expect(markup).toContain('after paying $20k')
    expect(markup).not.toContain('data-markdown-copy="$20k"')
  })
})
