// apps/web/src/composerDraftStore.ts
// exposes stable composer draft state and persistence contracts

export {
  COMPOSER_DRAFT_STORAGE_KEY,
  DraftId,
  PersistedComposerImageAttachment,
  PersistedComposerFileAttachment,
  PersistedComposerDraftFileAttachment,
  composerFileNeedsReattach,
  createEmptyThreadDraft,
  hydrateImagesFromPersisted,
  type ComposerImageAttachment,
  type ComposerFileAttachment,
  type ComposerThreadTarget,
  type ComposerThreadDraftState,
  type DraftSessionState,
  type DraftThreadEnvMode,
  type DraftThreadState,
} from './composer-drafts/persistence'
export {
  createArchitectureConcernContext,
  formatArchitectureConcernAuthority,
  formatArchitectureConcernLabel,
  formatArchitectureConcernTooltip,
  type ArchitectureConcernAddResult,
  type ArchitectureConcernContext,
  type ArchitectureConcernGraphSelection,
} from './composer-drafts/architectureContext'
export {
  deriveEffectiveComposerModelState,
  type EffectiveComposerModelState,
} from './composer-drafts/model-selection'
export {
  clearComposerDraftsEnvironment,
  finalizePromotedDraftThreadByRef,
  finalizePromotedDraftThreadsByRef,
  markPromotedDraftThread,
  markPromotedDraftThreadByRef,
  markPromotedDraftThreads,
  markPromotedDraftThreadsByRef,
  useComposerDraftModelState,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from './composer-drafts/runtime'
