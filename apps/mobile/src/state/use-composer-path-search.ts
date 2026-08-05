// apps/mobile/src/state/use-composer-path-search.ts
// manage composer path search through a React hook

import { type ComposerPathSearchTarget } from '@t3tools/client-runtime/state/threads'

import { useComposerPathSearch as useComposerPathSearchQuery } from '../state/queries'

export function useComposerPathSearch(target: ComposerPathSearchTarget)
{
  return useComposerPathSearchQuery(target)
}
