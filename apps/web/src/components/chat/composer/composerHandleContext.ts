// apps/web/src/components/chat/composer/composerHandleContext.ts
// define composer handle ref

import { createContext, use } from 'react'
import type { ChatComposerHandle } from './chatComposerHandle'

export type ComposerHandleRef = React.RefObject<ChatComposerHandle | null>

export const ComposerHandleContext = createContext<ComposerHandleRef | null>(null)

export function useComposerHandleContext(): ComposerHandleRef | null
{
  return use(ComposerHandleContext)
}
