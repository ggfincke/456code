// apps/mobile/src/features/review/ReviewHighlighterProvider.tsx
// initialize review highlighting for descendant review surfaces

import type { ReactNode } from 'react'

import { useReviewHighlighterState } from './reviewHighlighterState'

export function ReviewHighlighterProvider(props: { readonly children: ReactNode })
{
  useReviewHighlighterState()
  return props.children
}
