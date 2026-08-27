// tests/apps/mobile/features/threads/sidebar/threadSearchHighlight.test.ts
// verifies literal native snippet highlights preserve text and sqlite case rules

import { expect, it } from 'vite-plus/test'
import { splitThreadSearchHighlight } from '../../../../../../apps/mobile/src/features/threads/sidebar/threadSearchHighlight'

it('highlights literal matches without treating punctuation as regex or folding unicode', () =>
{
  const text = 'Before [A_B%] and [a_b%] after'
  const parts = splitThreadSearchHighlight(text, ' [a_b%] ')
  expect(parts.filter((part) => part.highlighted).map((part) => part.text)).toEqual([
    '[A_B%]',
    '[a_b%]',
  ])
  expect(parts.map((part) => part.text).join('')).toBe(text)
  expect(
    splitThreadSearchHighlight('Écho écho', 'écho')
      .filter((part) => part.highlighted)
      .map((part) => part.text),
  ).toEqual(['écho'])
  expect(splitThreadSearchHighlight(text, ' ')).toEqual([{ text, highlighted: false, start: 0 }])
})
