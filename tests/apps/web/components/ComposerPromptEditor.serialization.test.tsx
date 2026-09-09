// tests/apps/web/components/ComposerPromptEditor.serialization.test.tsx
// verify controlled mention source survives lexical clone and persistence

// @vitest-environment happy-dom

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $copyNode, $getRoot, $isElementNode, type LexicalEditor } from 'lexical'
import { act, createRef, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vite-plus/test'
import { serializeComposerFileLink } from '@t3tools/shared/composerTrigger'
import { collapseExpandedComposerCursor } from '../../../../apps/web/src/composer-logic'

let lexicalEditor: LexicalEditor
vi.mock('@lexical/react/LexicalPlainTextPlugin', () => ({
  PlainTextPlugin: function HeadlessEditor()
  {
    const [editor] = useLexicalComposerContext()
    useLayoutEffect(() =>
    {
      lexicalEditor = editor
    }, [editor])
    return null
  },
}))
vi.mock('../../../../apps/web/src/components/chat/FileTagChip', () => ({
  FILE_TAG_CHIP_CLASS_NAME: '',
  FileTagChipContent: () => null,
}))
vi.mock(
  '../../../../apps/web/src/components/chat/composer/ComposerPendingTerminalContexts',
  () => ({ ComposerPendingTerminalContextChip: () => null }),
)

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from '../../../../apps/web/src/components/ComposerPromptEditor'

it('preserves original mention syntax through controlled replacement, cloning, and JSON reload with legacy fallback', async () =>
{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const editorRef = createRef<ComposerPromptEditorHandle>()
  const root = createRoot(document.createElement('div'))
  const prompt = '@"docs/雪 👋.md" remains a chip'
  const render = (value: string) =>
    act(async () =>
      root.render(
        <ComposerPromptEditor
          value={value}
          cursor={collapseExpandedComposerCursor(value, value.length)}
          terminalContexts={[]}
          skills={[]}
          disabled={false}
          placeholder="Prompt"
          onRemoveTerminalContext={() => undefined}
          onChange={() => undefined}
          onPaste={() => undefined}
          editorRef={editorRef}
        />,
      ),
    )
  try
  {
    await render('Plain prompt')
    await render(prompt)
    expect(editorRef.current?.readSnapshot().value).toBe(prompt)
    await act(async () =>
      lexicalEditor.update(
        () =>
        {
          const paragraph = $getRoot().getFirstChildOrThrow()
          if (!$isElementNode(paragraph)) throw new Error('Expected paragraph')
          const mention = paragraph.getFirstChildOrThrow()
          expect(mention.getType()).toBe('composer-mention')
          mention.replace($copyNode(mention))
        },
        { discrete: true },
      ),
    )
    expect(editorRef.current?.readSnapshot().value).toBe(prompt)
    const exported = lexicalEditor.getEditorState().toJSON()
    await render('')
    await act(async () => lexicalEditor.setEditorState(lexicalEditor.parseEditorState(exported)))
    expect(editorRef.current?.readSnapshot().value).toBe(prompt)
    const legacy = JSON.stringify(exported, (key, value) => (key === 'source' ? undefined : value))
    await act(async () => lexicalEditor.setEditorState(lexicalEditor.parseEditorState(legacy)))
    expect(editorRef.current?.readSnapshot().value).toBe(
      `${serializeComposerFileLink('docs/雪 👋.md')} remains a chip`,
    )
  }
  finally
  {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
