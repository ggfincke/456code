// tests/apps/web/components/chat/composer/ComposerStashMenu.test.tsx
// verifies configured stash shortcuts in the provider-scoped empty state

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'

import { ComposerStashMenu } from '../../../../../../apps/web/src/components/chat/composer/ComposerStashMenu'

describe('ComposerStashMenu', () =>
{
  it('shows the configured shortcut without losing provider scope details', () =>
  {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[]}
        stashShortcutLabel="Ctrl+Shift+S"
        providerLabel="Codex"
        otherScopesCount={2}
        onRestore={() =>
        {}}
        onDelete={() =>
        {}}
        onClose={() =>
        {}}
      />,
    )

    expect(markup).toContain('Press Ctrl+Shift+S with a prompt in the composer to stash it.')
    expect(markup).toContain('Codex')
    expect(markup).toContain('2 more stashed under other connection methods')
    expect(markup).not.toContain('⌘S')
  })

  it('omits shortcut instructions when stash is unbound', () =>
  {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[]}
        stashShortcutLabel={null}
        providerLabel="Codex"
        otherScopesCount={0}
        onRestore={() =>
        {}}
        onDelete={() =>
        {}}
        onClose={() =>
        {}}
      />,
    )

    expect(markup).toContain('Nothing stashed for this method yet.')
    expect(markup).not.toContain('Press')
    expect(markup).not.toContain('⌘S')
  })
})
