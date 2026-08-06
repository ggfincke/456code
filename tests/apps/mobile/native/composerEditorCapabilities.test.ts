// tests/apps/mobile/native/composerEditorCapabilities.test.ts
// verifies platform composer submit capabilities

import { describe, expect, it } from 'vite-plus/test'

import { resolveComposerSubmitHandler } from '../../../../apps/mobile/src/features/threads/threadComposerSubmit'
import { resolveComposerEditorCapabilities } from '../../../../apps/mobile/src/native/composerEditorCapabilities'

describe('composer editor capabilities', () =>
{
  it('supports hardware submit only on iOS', () =>
  {
    expect(resolveComposerEditorCapabilities('ios')).toEqual({ supportsHardwareSubmit: true })
    expect(resolveComposerEditorCapabilities('android')).toEqual({ supportsHardwareSubmit: false })
    expect(resolveComposerEditorCapabilities('fallback')).toEqual({
      supportsHardwareSubmit: false,
    })
  })

  it('preserves the handler only when hardware submit is supported', () =>
  {
    const handler = () => undefined

    expect(resolveComposerSubmitHandler(resolveComposerEditorCapabilities('ios'), handler)).toBe(
      handler,
    )
    expect(
      resolveComposerSubmitHandler(resolveComposerEditorCapabilities('android'), handler),
    ).toBeUndefined()
  })
})
