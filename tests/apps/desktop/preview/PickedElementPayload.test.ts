// tests/apps/desktop/preview/PickedElementPayload.test.ts
// verify is picked element payload behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  isPickedElementPayload,
  isPreviewAnnotationPayload,
} from '../../../../apps/desktop/src/preview/PickedElementPayload.ts'

function validPayload(overrides?: Record<string, unknown>): Record<string, unknown>
{
  return {
    pageUrl: 'https://example.com/',
    pageTitle: 'Example',
    tagName: 'button',
    selector: 'button.submit',
    htmlPreview: '<button>Save</button>',
    componentName: 'SubmitButton',
    source: {
      functionName: 'SubmitButton',
      fileName: '/repo/src/Button.tsx',
      lineNumber: 12,
      columnNumber: 5,
    },
    stack: [
      {
        functionName: 'SubmitButton',
        fileName: '/repo/src/Button.tsx',
        lineNumber: 12,
        columnNumber: 5,
      },
    ],
    styles: '.submit { color: white; }',
    pickedAt: '2026-05-03T18:00:00.000Z',
    ...overrides,
  }
}

describe('isPickedElementPayload', () =>
{
  it.each([
    ['complete well-typed payload', validPayload()],
    [
      'nullable string fields when null',
      validPayload({ pageTitle: null, selector: null, componentName: null, source: null }),
    ],
    ['empty stack array', validPayload({ stack: [] })],
    [
      'stack frames with null fields',
      validPayload({
        stack: [
          {
            functionName: null,
            fileName: null,
            lineNumber: null,
            columnNumber: null,
          },
        ],
      }),
    ],
  ])('accepts %s', (_label, value) =>
  {
    expect(isPickedElementPayload(value)).toBe(true)
  })

  it('rejects null and primitive inputs', () =>
  {
    expect(isPickedElementPayload(null)).toBe(false)
    expect(isPickedElementPayload(undefined)).toBe(false)
    expect(isPickedElementPayload('string')).toBe(false)
    expect(isPickedElementPayload(42)).toBe(false)
    expect(isPickedElementPayload([])).toBe(false)
  })

  // representative flat-field rejects; nested/finite/stack cases below cover the rest.
  it.each<[string, Record<string, unknown>]>([
    ['missing required pageUrl', validPayload({ pageUrl: undefined })],
    ['wrong-type required pageUrl', validPayload({ pageUrl: 123 })],
    ['wrong-type nullable pageTitle', validPayload({ pageTitle: 99 })],
  ])('rejects payloads with %s', (_label, value) =>
  {
    expect(isPickedElementPayload(value)).toBe(false)
  })

  it('rejects malformed source frames', () =>
  {
    expect(
      isPickedElementPayload(
        validPayload({
          source: {
            functionName: 0,
            fileName: null,
            lineNumber: null,
            columnNumber: null,
          },
        }),
      ),
    ).toBe(false)
  })

  it('rejects non-finite numeric line/column numbers', () =>
  {
    expect(
      isPickedElementPayload(
        validPayload({
          source: {
            functionName: null,
            fileName: null,
            lineNumber: Number.POSITIVE_INFINITY,
            columnNumber: null,
          },
        }),
      ),
    ).toBe(false)
    expect(
      isPickedElementPayload(
        validPayload({
          source: {
            functionName: null,
            fileName: null,
            lineNumber: Number.NaN,
            columnNumber: null,
          },
        }),
      ),
    ).toBe(false)
  })

  it('rejects malformed stack arrays', () =>
  {
    expect(isPickedElementPayload(validPayload({ stack: 'not-an-array' }))).toBe(false)
    expect(isPickedElementPayload(validPayload({ stack: [{ bogus: true }] }))).toBe(false)
  })
})

function validAnnotation(overrides?: Record<string, unknown>): Record<string, unknown>
{
  return {
    id: 'annotation_1',
    pageUrl: 'https://example.com/',
    pageTitle: 'Example',
    comment: 'Make this clearer',
    elements: [
      {
        id: 'element_1',
        element: validPayload(),
        rect: { x: 10, y: 20, width: 100, height: 40 },
      },
    ],
    regions: [{ id: 'region_1', rect: { x: 5, y: 6, width: 20, height: 30 } }],
    strokes: [
      {
        id: 'stroke_1',
        color: '#7c3aed',
        width: 4,
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 20 },
        ],
        bounds: { x: 6, y: 6, width: 18, height: 18 },
      },
    ],
    styleChanges: [
      {
        targetId: 'element_1',
        selector: 'button.submit',
        property: 'opacity',
        previousValue: '1',
        value: '0.5',
      },
    ],
    screenshot: null,
    createdAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  }
}

describe('isPreviewAnnotationPayload', () =>
{
  it('accepts structured drafts and rejects guest screenshots', () =>
  {
    expect(isPreviewAnnotationPayload(validAnnotation())).toBe(true)
    expect(isPreviewAnnotationPayload(validAnnotation({ screenshot: { dataUrl: 'bad' } }))).toBe(
      false,
    )
  })

  it('rejects malformed geometry and nested element payloads', () =>
  {
    expect(
      isPreviewAnnotationPayload(
        validAnnotation({ regions: [{ id: 'region_1', rect: { x: 0, y: 0, width: 'wide' } }] }),
      ),
    ).toBe(false)
    expect(
      isPreviewAnnotationPayload(
        validAnnotation({ elements: [{ id: 'element_1', element: {}, rect: {} }] }),
      ),
    ).toBe(false)
  })
})
