// tests/apps/web/components/chat/composer/ComposerStashMenu.test.tsx
// verifies configured stash shortcuts in the provider-scoped empty state

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'

import { ComposerStashMenu } from '../../../../../../apps/web/src/components/chat/composer/ComposerStashMenu'
import { EnvironmentId, ProviderInstanceId } from '@t3tools/contracts'

describe('ComposerStashMenu', () =>
{
  it('keeps mixed stash rows image-safe with a configured shortcut', () =>
  {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        stashShortcutLabel="Ctrl+Shift+S"
        providerLabel="Custom OpenCode"
        otherScopesCount={0}
        entries={[
          {
            id: 'mixed',
            createdAt: '2026-08-30T12:00:00.000Z',
            prompt: '',
            providerInstanceId: ProviderInstanceId.make('custom-opencode'),
            modelSelection: null,
            attachments: [
              {
                id: 'photo',
                name: 'photo.png',
                mimeType: 'image/png',
                sizeBytes: 3,
                dataUrl: 'data:image/png;base64,AQID',
              },
            ],
            files: [
              {
                id: 'pdf',
                name: 'notes.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 4,
                attachmentId: 'opaque-upload',
                environmentId: EnvironmentId.make('stash-environment'),
              },
            ],
            droppedImageNames: [],
          },
        ]}
        onRestore={() =>
        {}}
        onDelete={() =>
        {}}
        onClose={() =>
        {}}
      />,
    )
    expect(markup).toContain('(1 image, 1 file)')
    expect(markup).toContain('Custom OpenCode')
    expect(markup.match(/<img /g)).toHaveLength(1)
    expect(markup).not.toContain('opaque-upload')
    expect(markup).not.toContain('⌘S')
  })

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
