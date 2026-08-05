// apps/web/src/components/preview/errorCodeMessages.ts
// define describe preview error

import { PREVIEW_ERROR_CODE_MESSAGES } from './previewConstants'

// resolve a friendly description for a Chromium / network error. Falls back
// to the description string passed in when it isn't in our table.
export function describePreviewError(description: string): string
{
  const friendly = PREVIEW_ERROR_CODE_MESSAGES[description]
  if (friendly) return friendly
  if (description.length > 0) return description
  return 'Network error'
}
