// tests/packages/shared/chatList.test.ts
// verify resolve chat list anchored end space behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  CHAT_LIST_ANCHOR_OFFSET,
  resolveChatListAnchoredEndSpace,
} from '../../../packages/shared/src/chatList.js'

interface Row
{
  readonly id: string
  readonly anchorable: boolean
}

const rows: ReadonlyArray<Row> = [
  { id: 'first', anchorable: true },
  { id: 'ignored', anchorable: false },
  { id: 'latest', anchorable: true },
]

const getAnchorId = (row: Row) => (row.anchorable ? row.id : null)

describe('resolveChatListAnchoredEndSpace', () =>
{
  it('anchors the first eligible row', () =>
  {
    expect(resolveChatListAnchoredEndSpace(rows, 'first', getAnchorId)).toEqual({
      anchorIndex: 0,
      anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
    })
  })

  it('allows a surface to keep the anchor below its own header', () =>
  {
    expect(
      resolveChatListAnchoredEndSpace(rows, 'first', getAnchorId, {
        anchorOffset: 132,
      }),
    ).toEqual({
      anchorIndex: 0,
      anchorOffset: 132,
    })
  })

  it('does not anchor a later eligible row until earlier rows leave the list', () =>
  {
    expect(resolveChatListAnchoredEndSpace(rows, 'latest', getAnchorId)).toBeUndefined()
    expect(resolveChatListAnchoredEndSpace(rows.slice(1), 'latest', getAnchorId)).toEqual({
      anchorIndex: 1,
      anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
    })
  })

  it('ignores ineligible rows and missing anchors', () =>
  {
    expect(resolveChatListAnchoredEndSpace(rows, 'ignored', getAnchorId)).toBeUndefined()
    expect(resolveChatListAnchoredEndSpace(rows, 'missing', getAnchorId)).toBeUndefined()
    expect(resolveChatListAnchoredEndSpace(rows, null, getAnchorId)).toBeUndefined()
  })
})
