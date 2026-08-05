// apps/mobile/src/lib/composer-image-schema.ts
// define composer image schema and decoders

import * as Schema from 'effect/Schema'

export const DraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal('image'),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
})
