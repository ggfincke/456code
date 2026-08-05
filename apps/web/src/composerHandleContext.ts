// apps/web/src/composerHandleContext.ts
// define composer handle ref

import { createContext, use } from 'react'
import type { ChatComposerHandle } from './components/chat/ChatComposer'

export type ComposerHandleRef = React.RefObject<ChatComposerHandle | null>

export const ComposerHandleContext = createContext<ComposerHandleRef | null>(null)

export function useComposerHandleContext(): ComposerHandleRef | null
{
  return use(ComposerHandleContext)
}
