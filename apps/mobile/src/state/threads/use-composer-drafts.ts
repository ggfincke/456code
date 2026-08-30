// apps/mobile/src/state/threads/use-composer-drafts.ts
// hydrates and serializes environment-scoped mobile composer drafts

import { useAtomValue } from '@effect/atom-react'
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ModelSelection as ModelSelectionSchema,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInteractionMode as ProviderInteractionModeSchema,
  RuntimeMode as RuntimeModeSchema,
  normalizeCollaborationMode,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import { useEffect } from 'react'
import { Atom } from 'effect/unstable/reactivity'

import { DraftComposerImageAttachmentSchema } from '../../lib/composer-image-schema'
import type { DraftComposerImageAttachment } from '../../lib/composerImages'
import { SerializedAsyncQueue } from '../../lib/serialized-async-queue'
import { appAtomRegistry } from '../atom-registry'

const COMPOSER_DRAFTS_SCHEMA_VERSION = 1
const COMPOSER_DRAFTS_DIRECTORY = 'composer-drafts'
const COMPOSER_DRAFTS_FILE = 'drafts.json'
const PERSIST_DEBOUNCE_MS = 200

export class ComposerDraftPersistenceError extends Schema.TaggedErrorClass<ComposerDraftPersistenceError>()(
  'ComposerDraftPersistenceError',
  {
    operation: Schema.Literals(['open', 'read', 'decode', 'encode', 'write', 'hydrate']),
    directory: Schema.String,
    fileName: Schema.String,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Composer draft persistence operation ${this.operation} failed for ${this.directory}/${this.fileName}.`
  }
}

export interface ComposerDraft
{
  readonly text: string
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>
  readonly importedShareIds?: ReadonlyArray<string>
  readonly modelSelection?: ModelSelection
  readonly runtimeMode?: RuntimeMode
  readonly interactionMode?: ProviderInteractionMode
  readonly orchestrate?: boolean
  readonly workspaceSelection?: ComposerDraftWorkspaceSelection
}

export interface ComposerDraftContent
{
  readonly text: string
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>
  readonly sourceShareId?: string
}

export interface ComposerDraftWorkspaceSelection
{
  readonly mode: 'local' | 'worktree'
  readonly branch: string | null
  readonly worktreePath: string | null
  readonly startFromOrigin?: boolean
}

export type ComposerDraftSettingsUpdate = Pick<
  ComposerDraft,
  'modelSelection' | 'runtimeMode' | 'interactionMode' | 'orchestrate' | 'workspaceSelection'
>

const ComposerDraftWorkspaceSelectionSchema = Schema.Struct({
  mode: Schema.Literals(['local', 'worktree']),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
})

const ComposerDraftSchema = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  importedShareIds: Schema.optional(Schema.Array(Schema.String)),
  modelSelection: Schema.optional(ModelSelectionSchema),
  runtimeMode: Schema.optional(RuntimeModeSchema),
  interactionMode: Schema.optional(ProviderInteractionModeSchema),
  orchestrate: Schema.optional(Schema.Boolean),
  workspaceSelection: Schema.optional(ComposerDraftWorkspaceSelectionSchema),
})

const PersistedComposerDraftsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSER_DRAFTS_SCHEMA_VERSION),
  drafts: Schema.Record(Schema.String, ComposerDraftSchema),
  stickyModelSelection: Schema.optional(ModelSelectionSchema),
})

const decodePersistedComposerDraftsDocument = Schema.decodeUnknownSync(
  PersistedComposerDraftsSchema,
)

const EMPTY_DRAFT: ComposerDraft = {
  text: '',
  attachments: [],
}

export const composerDraftsAtom = Atom.make<Record<string, ComposerDraft>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel('mobile:composer-drafts'),
)

export const stickyComposerModelSelectionAtom = Atom.make<ModelSelection | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel('mobile:sticky-composer-model-selection'),
)

type PersistedComposerState = {
  readonly drafts: Record<string, ComposerDraft>
  readonly stickyModelSelection: ModelSelection | null
}

let loadPromise: Promise<void> | null = null
let hydrated = false
let stickySelectionChangedBeforeHydration = false
let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistRequestedBeforeHydration = false
const persistenceQueue = new SerializedAsyncQueue()

interface PendingComposerDraftMutation
{
  readonly draftKey: string
  readonly apply: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>
}

// synchronous mutations issued before hydration resolves. They publish to the
// atom immediately and are replayed, in invocation order, over the persisted
// document once it lands: a key they deleted stays deleted instead of being
// resurrected by the merge, and an append is never applied twice.
let pendingMutations: Array<PendingComposerDraftMutation> = []

function normalizeDraft(draft: ComposerDraft | undefined): ComposerDraft
{
  if (!draft)
  {
    return EMPTY_DRAFT
  }
  return {
    ...draft,
    text: draft.text,
    attachments: draft.attachments,
  }
}

function normalizeStoredDraft(draft: ComposerDraft): ComposerDraft
{
  const collaborationMode = normalizeCollaborationMode(
    draft.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    draft.orchestrate,
  )
  return {
    ...draft,
    ...(draft.interactionMode !== undefined || draft.orchestrate === true
      ? { interactionMode: collaborationMode.baseMode }
      : {}),
    orchestrate: collaborationMode.orchestrate,
  }
}

function normalizeDraftForWrite(draft: ComposerDraft): ComposerDraft
{
  if (draft.interactionMode === undefined && draft.orchestrate === undefined)
  {
    return draft
  }
  return normalizeStoredDraft(draft)
}

export function getComposerDraftSnapshot(draftKey: string): ComposerDraft
{
  return normalizeDraft(appAtomRegistry.get(composerDraftsAtom)[draftKey])
}

export function isComposerDraftEmpty(draft: ComposerDraft): boolean
{
  return isEmptyDraft(draft)
}

function isEmptyDraft(draft: ComposerDraft): boolean
{
  return (
    draft.text.length === 0 &&
    draft.attachments.length === 0 &&
    (draft.importedShareIds?.length ?? 0) === 0 &&
    draft.modelSelection === undefined &&
    draft.runtimeMode === undefined &&
    draft.interactionMode === undefined &&
    draft.orchestrate !== true &&
    draft.workspaceSelection === undefined
  )
}

export function decodePersistedComposerState(value: unknown): PersistedComposerState
{
  const parsed = decodePersistedComposerDraftsDocument(value)
  return {
    drafts: Object.fromEntries(
      Object.entries(parsed.drafts)
        .map(([draftKey, draft]) => [draftKey, normalizeStoredDraft(draft)] as const)
        .filter(([, draft]) => !isEmptyDraft(draft)),
    ),
    stickyModelSelection: parsed.stickyModelSelection ?? null,
  }
}

export function decodePersistedComposerDrafts(value: unknown): Record<string, ComposerDraft>
{
  return decodePersistedComposerState(value).drafts
}

async function getComposerDraftsFile()
{
  const { Directory, File, Paths } = await import('expo-file-system')
  const directory = new Directory(Paths.document, COMPOSER_DRAFTS_DIRECTORY)
  directory.create({ idempotent: true, intermediates: true })
  return new File(directory, COMPOSER_DRAFTS_FILE)
}

async function loadPersistedComposerState(): Promise<PersistedComposerState>
{
  let operation: ComposerDraftPersistenceError['operation'] = 'open'
  try
  {
    const file = await getComposerDraftsFile()
    if (!file.exists)
    {
      return { drafts: {}, stickyModelSelection: null }
    }
    operation = 'read'
    const raw = await file.text()
    operation = 'decode'
    return decodePersistedComposerState(JSON.parse(raw) as unknown)
  }
  catch (cause)
  {
    console.warn(
      '[composer-drafts] ignored persisted draft failure',
      new ComposerDraftPersistenceError({
        operation,
        directory: COMPOSER_DRAFTS_DIRECTORY,
        fileName: COMPOSER_DRAFTS_FILE,
        cause,
      }),
    )
    return { drafts: {}, stickyModelSelection: null }
  }
}

async function writePersistedComposerState(state: PersistedComposerState): Promise<void>
{
  let operation: ComposerDraftPersistenceError['operation'] = 'open'
  try
  {
    const file = await getComposerDraftsFile()
    operation = 'encode'
    const nonEmptyDrafts = Object.fromEntries(
      Object.entries(state.drafts)
        .map(([draftKey, draft]) => [draftKey, normalizeDraftForWrite(draft)] as const)
        .filter(([, draft]) => !isEmptyDraft(draft)),
    )
    const document = {
      schemaVersion: COMPOSER_DRAFTS_SCHEMA_VERSION,
      drafts: nonEmptyDrafts,
      ...(state.stickyModelSelection ? { stickyModelSelection: state.stickyModelSelection } : {}),
    } as const
    const encoded = JSON.stringify(document)
    operation = 'write'
    if (!file.exists)
    {
      file.create({ intermediates: true, overwrite: true })
    }
    file.write(encoded)
  }
  catch (cause)
  {
    throw new ComposerDraftPersistenceError({
      operation,
      directory: COMPOSER_DRAFTS_DIRECTORY,
      fileName: COMPOSER_DRAFTS_FILE,
      cause,
    })
  }
}

function persistComposerDraftsSnapshot(drafts: Record<string, ComposerDraft>): Promise<void>
{
  const state = {
    drafts,
    stickyModelSelection: appAtomRegistry.get(stickyComposerModelSelectionAtom),
  }
  return persistenceQueue.run(() => writePersistedComposerState(state))
}

async function savePersistedComposerDrafts(drafts: Record<string, ComposerDraft>): Promise<void>
{
  try
  {
    await persistComposerDraftsSnapshot(drafts)
  }
  catch (error)
  {
    console.warn('[composer-drafts] failed to persist drafts', error)
    // draft persistence is best-effort; in-memory drafts still keep working.
  }
}

function schedulePersistComposerDrafts(drafts: Record<string, ComposerDraft>): void
{
  // writing before hydration would replace the persisted document with a
  // partial one; the hydration flush persists the reconciled state instead.
  if (!hydrated)
  {
    persistRequestedBeforeHydration = true
    return
  }
  if (persistTimer !== null)
  {
    clearTimeout(persistTimer)
  }
  persistTimer = setTimeout(() =>
  {
    persistTimer = null
    void savePersistedComposerDrafts(drafts)
  }, PERSIST_DEBOUNCE_MS)
}

function completeComposerDraftsHydration(persisted: PersistedComposerState): void
{
  if (!stickySelectionChangedBeforeHydration)
  {
    appAtomRegistry.set(stickyComposerModelSelectionAtom, persisted.stickyModelSelection)
  }
  stickySelectionChangedBeforeHydration = false
  const persistedDrafts = persisted.drafts
  if (pendingMutations.length === 0)
  {
    hydrated = true
    const current = appAtomRegistry.get(composerDraftsAtom)
    const next = { ...persistedDrafts, ...current }
    if (Object.keys(persistedDrafts).length > 0)
    {
      appAtomRegistry.set(composerDraftsAtom, next)
    }
    if (persistRequestedBeforeHydration)
    {
      persistRequestedBeforeHydration = false
      schedulePersistComposerDrafts(next)
    }
    return
  }

  const replayedKeys = new Set(pendingMutations.map((mutation) => mutation.draftKey))
  // a key nobody touched before hydration keeps whatever the atom holds; a key
  // the pending mutations own replays from the persisted draft, so the result
  // matches what a hydration that had already finished would have produced.
  const base: Record<string, ComposerDraft> = { ...persistedDrafts }
  for (const [draftKey, draft] of Object.entries(appAtomRegistry.get(composerDraftsAtom)))
  {
    if (!replayedKeys.has(draftKey))
    {
      base[draftKey] = draft
    }
  }
  const next = pendingMutations.reduce((current, mutation) => mutation.apply(current), base)
  pendingMutations = []
  hydrated = true
  appAtomRegistry.set(composerDraftsAtom, next)
  if (persistRequestedBeforeHydration)
  {
    persistRequestedBeforeHydration = false
    schedulePersistComposerDrafts(next)
  }
}

export function ensureComposerDraftsLoaded(): void
{
  if (loadPromise !== null)
  {
    return
  }
  loadPromise = loadPersistedComposerState()
    .then((persisted) =>
    {
      completeComposerDraftsHydration(persisted)
    })
    .catch((cause) =>
    {
      console.warn(
        '[composer-drafts] failed to hydrate drafts',
        new ComposerDraftPersistenceError({
          operation: 'hydrate',
          directory: COMPOSER_DRAFTS_DIRECTORY,
          fileName: COMPOSER_DRAFTS_FILE,
          cause,
        }),
      )
      // draft loading is best-effort; in-memory drafts still keep working.
      completeComposerDraftsHydration({ drafts: {}, stickyModelSelection: null })
    })
}

// the single funnel for synchronous draft mutations: it publishes immediately
// and, while hydration is still in flight, records the mutation so hydration
// can replay it in order.
function updateComposerDrafts(
  draftKey: string,
  update: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
): void
{
  ensureComposerDraftsLoaded()
  if (!hydrated)
  {
    pendingMutations.push({ draftKey, apply: update })
  }
  const next = update(appAtomRegistry.get(composerDraftsAtom))
  appAtomRegistry.set(composerDraftsAtom, next)
  schedulePersistComposerDrafts(next)
}

export function setStickyComposerModelSelection(modelSelection: ModelSelection): void
{
  ensureComposerDraftsLoaded()
  if (!hydrated)
  {
    stickySelectionChangedBeforeHydration = true
  }
  appAtomRegistry.set(stickyComposerModelSelectionAtom, modelSelection)
  schedulePersistComposerDrafts(appAtomRegistry.get(composerDraftsAtom))
}

export function setComposerDraftText(draftKey: string, value: string): void
{
  updateComposerDrafts(draftKey, (current) =>
  {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      text: value,
    }
    if (isEmptyDraft(draft))
    {
      const next = { ...current }
      delete next[draftKey]
      return next
    }
    return {
      ...current,
      [draftKey]: draft,
    }
  })
}

export function appendComposerDraftText(draftKey: string, value: string): void
{
  updateComposerDrafts(draftKey, (current) =>
  {
    const existing = normalizeDraft(current[draftKey])
    return {
      ...current,
      [draftKey]: {
        ...existing,
        text: `${existing.text}${value}`,
      },
    }
  })
}

export function appendComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void
{
  if (attachments.length === 0)
  {
    return
  }
  updateComposerDrafts(draftKey, (current) =>
  {
    const existing = normalizeDraft(current[draftKey])
    return {
      ...current,
      [draftKey]: {
        ...existing,
        attachments: [...existing.attachments, ...attachments],
      },
    }
  })
}

export function replaceComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void
{
  updateComposerDrafts(draftKey, (current) =>
  {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      attachments,
    }
    if (isEmptyDraft(draft))
    {
      const next = { ...current }
      delete next[draftKey]
      return next
    }
    return {
      ...current,
      [draftKey]: draft,
    }
  })
}

export function removeComposerDraftAttachment(draftKey: string, imageId: string): void
{
  updateComposerDrafts(draftKey, (current) =>
  {
    const existing = normalizeDraft(current[draftKey])
    const draft = {
      ...existing,
      attachments: existing.attachments.filter((image) => image.id !== imageId),
    }
    if (isEmptyDraft(draft))
    {
      const next = { ...current }
      delete next[draftKey]
      return next
    }
    return {
      ...current,
      [draftKey]: draft,
    }
  })
}

export function updateComposerDraftSettings(
  draftKey: string,
  settings: Partial<ComposerDraftSettingsUpdate>,
): void
{
  updateComposerDrafts(draftKey, (current) =>
  {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      ...settings,
    }
    if (isEmptyDraft(draft))
    {
      const next = { ...current }
      delete next[draftKey]
      return next
    }
    return {
      ...current,
      [draftKey]: draft,
    }
  })
}

export function clearComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  options?: {
    readonly clearModelSelection?: boolean
    readonly clearWorkspaceSelection?: boolean
  },
): Record<string, ComposerDraft>
{
  const existing = current[draftKey]
  if (!existing)
  {
    return current
  }
  const {
    importedShareIds: _importedShareIds,
    modelSelection,
    workspaceSelection,
    ...retained
  } = existing
  const draft = {
    ...retained,
    ...(options?.clearModelSelection || modelSelection === undefined ? {} : { modelSelection }),
    ...(options?.clearWorkspaceSelection || workspaceSelection === undefined
      ? {}
      : { workspaceSelection }),
    text: '',
    attachments: [],
  }
  if (isEmptyDraft(draft))
  {
    const next = { ...current }
    delete next[draftKey]
    return next
  }
  return {
    ...current,
    [draftKey]: draft,
  }
}

export function restoreComposerDraftSnapshotState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  snapshot: ComposerDraft,
): Record<string, ComposerDraft>
{
  const next = { ...current }
  if (isEmptyDraft(snapshot))
  {
    delete next[draftKey]
  }
  else
  {
    next[draftKey] = snapshot
  }
  return next
}

function mergeComposerDraftText(existing: string, incoming: string): string
{
  if (incoming.length === 0)
  {
    return existing
  }
  if (existing.length === 0)
  {
    return incoming
  }
  // import retries are possible after an interrupted native handoff. Keep the
  // operation idempotent when the same shared text is already present.
  if (existing === incoming || existing.endsWith(`\n\n${incoming}`))
  {
    return existing
  }
  return `${existing}\n\n${incoming}`
}

export function mergeComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  content: ComposerDraftContent,
): Record<string, ComposerDraft>
{
  const existing = normalizeDraft(current[draftKey])
  if (content.sourceShareId && existing.importedShareIds?.includes(content.sourceShareId))
  {
    return current
  }
  const attachmentIds = new Set(existing.attachments.map((attachment) => attachment.id))
  const incomingAttachments = content.attachments.filter((attachment) =>
  {
    if (attachmentIds.has(attachment.id))
    {
      return false
    }
    attachmentIds.add(attachment.id)
    return true
  })
  const attachments = [...existing.attachments, ...incomingAttachments].slice(
    0,
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  )
  const text = mergeComposerDraftText(existing.text, content.text)
  const importedShareIds = content.sourceShareId
    ? [...(existing.importedShareIds ?? []), content.sourceShareId]
    : existing.importedShareIds
  if (
    text === existing.text &&
    attachments.length === existing.attachments.length &&
    importedShareIds === existing.importedShareIds
  )
  {
    return current
  }
  return {
    ...current,
    [draftKey]: {
      ...existing,
      text,
      attachments,
      ...(importedShareIds ? { importedShareIds } : {}),
    },
  }
}

// atomically moves an incoming share into a project-scoped composer draft.
// the durable write happens before the share inbox item can be acknowledged.
export async function mergeComposerDraftContent(
  draftKey: string,
  content: ComposerDraftContent,
): Promise<{ readonly skippedAttachmentCount: number }>
{
  ensureComposerDraftsLoaded()
  if (loadPromise !== null)
  {
    await loadPromise
  }
  if (persistTimer !== null)
  {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  const current = appAtomRegistry.get(composerDraftsAtom)
  const next = mergeComposerDraftContentState(current, draftKey, content)
  const currentAttachmentIds = new Set(
    normalizeDraft(current[draftKey]).attachments.map((attachment) => attachment.id),
  )
  const nextAttachmentIds = new Set(
    normalizeDraft(next[draftKey]).attachments.map((attachment) => attachment.id),
  )
  const skippedAttachmentCount = content.attachments.filter(
    (attachment) =>
      !currentAttachmentIds.has(attachment.id) && !nextAttachmentIds.has(attachment.id),
  ).length
  // publish the content and its import receipt together before the filesystem
  // await. Typing during persistence then builds on the receipt-bearing state,
  // and its debounced write is serialized after this transaction.
  if (next !== current)
  {
    appAtomRegistry.set(composerDraftsAtom, next)
  }
  await persistComposerDraftsSnapshot(next)
  return { skippedAttachmentCount }
}

// restores the exact content/settings captured before an interrupted import.
export async function restoreComposerDraftSnapshot(
  draftKey: string,
  snapshot: ComposerDraft,
): Promise<void>
{
  ensureComposerDraftsLoaded()
  if (loadPromise !== null)
  {
    await loadPromise
  }
  if (persistTimer !== null)
  {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  const next = restoreComposerDraftSnapshotState(
    appAtomRegistry.get(composerDraftsAtom),
    draftKey,
    snapshot,
  )
  appAtomRegistry.set(composerDraftsAtom, next)
  await persistComposerDraftsSnapshot(next)
}

export function clearComposerDraftContent(
  draftKey: string,
  options?: {
    readonly clearModelSelection?: boolean
    readonly clearWorkspaceSelection?: boolean
  },
): void
{
  updateComposerDrafts(draftKey, (current) =>
    clearComposerDraftContentState(current, draftKey, options),
  )
}

export function clearComposerDraft(draftKey: string): void
{
  updateComposerDrafts(draftKey, (current) =>
  {
    if (!current[draftKey])
    {
      return current
    }
    const next = { ...current }
    delete next[draftKey]
    return next
  })
}

export function removeComposerDraftsForEnvironment(
  drafts: Record<string, ComposerDraft>,
  environmentId: EnvironmentId,
): Record<string, ComposerDraft>
{
  const environmentPrefix = `${environmentId}:`
  const newTaskPrefix = `new-task:${environmentId}:`
  return Object.fromEntries(
    Object.entries(drafts).filter(
      ([draftKey]) =>
        !draftKey.startsWith(environmentPrefix) && !draftKey.startsWith(newTaskPrefix),
    ),
  )
}

export async function clearComposerDraftsEnvironment(environmentId: EnvironmentId): Promise<void>
{
  ensureComposerDraftsLoaded()
  if (loadPromise !== null)
  {
    await loadPromise
  }

  const next = removeComposerDraftsForEnvironment(
    appAtomRegistry.get(composerDraftsAtom),
    environmentId,
  )

  if (persistTimer !== null)
  {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  appAtomRegistry.set(composerDraftsAtom, next)
  await persistComposerDraftsSnapshot(next)
}

export function useComposerDraft(draftKey: string | null): ComposerDraft
{
  const drafts = useAtomValue(composerDraftsAtom)
  useEffect(() =>
  {
    ensureComposerDraftsLoaded()
  }, [])
  return draftKey ? normalizeDraft(drafts[draftKey]) : EMPTY_DRAFT
}

export function useStickyComposerModelSelection(): ModelSelection | null
{
  const selection = useAtomValue(stickyComposerModelSelectionAtom)
  useEffect(() =>
  {
    ensureComposerDraftsLoaded()
  }, [])
  return selection
}
