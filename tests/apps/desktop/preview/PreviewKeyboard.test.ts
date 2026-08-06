// tests/apps/desktop/preview/PreviewKeyboard.test.ts
// verify preview keyboard packets behavior

import { describe, expect, it } from 'vite-plus/test'

import { makePreviewAutomationKeySequence } from '../../../../apps/desktop/src/preview/PreviewKeyboard.ts'

describe('preview keyboard packets', () =>
{
  it('includes the Chromium virtual key code and Enter text', () =>
  {
    expect(makePreviewAutomationKeySequence({ key: 'Enter' })).toEqual({
      keyDown: {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        modifiers: 0,
        windowsVirtualKeyCode: 13,
        location: 0,
        isKeypad: false,
        text: '\r',
        unmodifiedText: '\r',
      },
      keyUp: {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        modifiers: 0,
        windowsVirtualKeyCode: 13,
        location: 0,
        isKeypad: false,
      },
      signal: { kind: 'key', key: 'Enter', code: 'Enter' },
    })
  })

  it('dispatches printable keys as text key-down events', () =>
  {
    const sequence = makePreviewAutomationKeySequence({ key: 'z' })
    expect(sequence.keyDown).toMatchObject({
      type: 'keyDown',
      key: 'z',
      code: 'KeyZ',
      windowsVirtualKeyCode: 90,
      text: 'z',
    })
    expect(sequence.keyUp).not.toHaveProperty('text')
  })

  it('suppresses text and uses raw key-down for shortcuts', () =>
  {
    expect(
      makePreviewAutomationKeySequence({ key: 'a', modifiers: ['Meta'] }, { isMac: true }).keyDown,
    ).toEqual({
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      location: 0,
      isKeypad: false,
      commands: ['selectAll'],
    })
  })

  it('maps common macOS editing shortcuts without changing other platforms', () =>
  {
    expect(
      makePreviewAutomationKeySequence({ key: 'z', modifiers: ['Shift', 'Meta'] }, { isMac: true })
        .keyDown.commands,
    ).toEqual(['redo'])
    expect(
      makePreviewAutomationKeySequence({ key: 'a', modifiers: ['Meta'] }).keyDown,
    ).not.toHaveProperty('commands')
  })

  it('resolves shifted printable keys and suppresses text on modified chords', () =>
  {
    const shifted = makePreviewAutomationKeySequence({ key: '1', modifiers: ['Shift'] })
    expect(shifted.keyDown).toMatchObject({
      key: '!',
      code: 'Digit1',
      modifiers: 8,
      windowsVirtualKeyCode: 49,
      text: '!',
    })
    expect(shifted.signal).toEqual({ kind: 'key', key: '!', code: 'Digit1' })

    const chord = makePreviewAutomationKeySequence({
      key: '1',
      modifiers: ['Control', 'Shift'],
    })
    expect(chord.keyDown).toEqual({
      type: 'rawKeyDown',
      key: '!',
      code: 'Digit1',
      modifiers: 10,
      windowsVirtualKeyCode: 49,
      location: 0,
      isKeypad: false,
    })
    expect(chord.signal).toEqual({ kind: 'key', key: '!', code: 'Digit1' })
  })
})
