// apps/web/src/components/chat/composer/chatComposerHandle.ts
// define the imperative chat composer handle contract

import type {
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderDriverKind,
  ServerProvider,
} from '@t3tools/contracts'

import type { ComposerImageAttachment } from '../../../composerDraftStore'
import type { ElementContextDraft } from '../../../lib/elementContext'
import type { TerminalContextDraft, TerminalContextSelection } from '../../../lib/terminalContext'
import type { ReviewCommentContext } from '../../../lib/reviewCommentContext'

export interface ChatComposerHandle
{
  focusAtEnd: () => void
  focusAt: (cursor: number) => void
  insertTextAtEnd: (text: string, options?: { ensureLeadingBoundary?: boolean }) => boolean
  openModelPicker: () => void
  toggleModelPicker: () => void
  isModelPickerOpen: () => boolean
  readSnapshot: () => {
    value: string
    cursor: number
    expandedCursor: number
    terminalContextIds: string[]
  }
  // reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend).
  resetCursorState: (options?: {
    cursor?: number
    prompt?: string
    detectTrigger?: boolean
  }) => void
  // insert a terminal context from the terminal drawer.
  addTerminalContext: (selection: TerminalContextSelection) => void
  // get the current prompt/effort/model state for use in send.
  getSendContext: () => {
    prompt: string
    images: ComposerImageAttachment[]
    terminalContexts: TerminalContextDraft[]
    elementContexts: ElementContextDraft[]
    previewAnnotations: PreviewAnnotationPayload[]
    reviewComments: ReviewCommentContext[]
    selectedPromptEffort: string | null
    selectedModelOptionsForDispatch: unknown
    selectedModelSelection: ModelSelection
    providerAvailable: boolean
    selectedProvider: ProviderDriverKind
    selectedModel: string
    selectedProviderModels: ReadonlyArray<ServerProvider['models'][number]>
    selectedProviderSlashCommands: ReadonlyArray<ServerProvider['slashCommands'][number]>
  }
}
