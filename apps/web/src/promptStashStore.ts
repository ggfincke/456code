// apps/web/src/promptStashStore.ts
// persists provider-scoped prompt queues
import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { PersistedComposerImageAttachment } from "./composerDraftStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";

export const PROMPT_STASH_STORAGE_KEY = "456code:prompt-stash:v1";
const PROMPT_STASH_STORAGE_VERSION = 1;

// holds prompts saved before a provider instance is selected
export const PROMPT_STASH_UNSCOPED_KEY = "__none__";
// separates provider ids from the unscoped sentinel
const PROVIDER_SCOPE_PREFIX = "provider:";

export const MAX_STASH_ENTRIES_PER_QUEUE = 20;
// fits a typical before-and-after pair within the shared local storage quota
export const MAX_STASH_ENTRY_ATTACHMENT_CHARS = 2_700_000;

const StashEntrySchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  modelSelection: Schema.NullOr(ModelSelection),
  // images that exceeded the attachment budget
  droppedImageNames: Schema.Array(Schema.String),
  // images that could not be decoded or re-encoded
  unreadableImageNames: Schema.optionalKey(Schema.Array(Schema.String)),
  // tracks asynchronous encoding without risking loss of the prompt
  pendingImageCount: Schema.optionalKey(Schema.Number),
});
export type PromptStashEntry = typeof StashEntrySchema.Type;

const PersistedPromptStashState = Schema.Struct({
  queuesByScopeKey: Schema.Record(Schema.String, Schema.Array(StashEntrySchema)),
});
type PersistedPromptStashState = typeof PersistedPromptStashState.Type;

const decodePersistedPromptStashState = Schema.decodeUnknownSync(PersistedPromptStashState);

// settles image encodes orphaned by reload while keeping the prompt restorable
function clearOrphanedPendingImages(
  queues: Record<string, ReadonlyArray<PromptStashEntry>>,
): Record<string, ReadonlyArray<PromptStashEntry>> {
  const next: Record<string, ReadonlyArray<PromptStashEntry>> = {};
  for (const [scopeKey, queue] of Object.entries(queues)) {
    next[scopeKey] = queue.map((entry) => {
      if (!entry.pendingImageCount) return entry;
      const lostCount = entry.pendingImageCount;
      return {
        ...entry,
        pendingImageCount: 0,
        unreadableImageNames: [
          ...(entry.unreadableImageNames ?? []),
          ...Array.from(
            { length: lostCount },
            (_, index) => `image ${index + 1} (not saved before reload)`,
          ),
        ],
      };
    });
  }
  return next;
}

// maps the active provider to its stash bucket
export function promptStashScopeKey(instanceId: ProviderInstanceId | null | undefined): string {
  return instanceId ? `${PROVIDER_SCOPE_PREFIX}${instanceId}` : PROMPT_STASH_UNSCOPED_KEY;
}

// reads user-derived keys without falling through to the object prototype
function readQueue(
  queues: Record<string, ReadonlyArray<PromptStashEntry>>,
  scopeKey: string,
): ReadonlyArray<PromptStashEntry> {
  return Object.hasOwn(queues, scopeKey) ? (queues[scopeKey] ?? []) : [];
}

// admits attachments in order until the per-entry storage budget is full
export function partitionStashAttachments(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): {
  kept: PersistedComposerImageAttachment[];
  droppedNames: string[];
} {
  const kept: PersistedComposerImageAttachment[] = [];
  const droppedNames: string[] = [];
  let usedChars = 0;
  for (const attachment of attachments) {
    if (usedChars + attachment.dataUrl.length > MAX_STASH_ENTRY_ATTACHMENT_CHARS) {
      droppedNames.push(attachment.name);
      continue;
    }
    usedChars += attachment.dataUrl.length;
    kept.push(attachment);
  }
  return { kept, droppedNames };
}

// guards blocked storage and marks the in-memory fallback as non-durable
function resolveBaseStorage(): { storage: StateStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {
    // fall through to the in-memory store
  }
  return { storage: createMemoryStorage(), durable: false };
}

const { storage: baseStashStorage, durable: storageIsDurable } = resolveBaseStorage();

// writes immediately so the composer only clears after a durable stash
function persistQueues(queues: Record<string, ReadonlyArray<PromptStashEntry>>): {
  // the write succeeded in durable or fallback storage
  written: boolean;
  // the write will survive a reload
  durable: boolean;
} {
  try {
    baseStashStorage.setItem(
      PROMPT_STASH_STORAGE_KEY,
      JSON.stringify({
        version: PROMPT_STASH_STORAGE_VERSION,
        state: { queuesByScopeKey: queues },
      }),
    );
    return { written: true, durable: storageIsDurable };
  } catch (error) {
    console.error("[PROMPT-STASH] Could not persist stash (storage quota?).", error);
    return { written: false, durable: false };
  }
}

// reads persisted queues and settles stale image encoding counts
function readPersistedQueues(): Record<string, ReadonlyArray<PromptStashEntry>> | null {
  try {
    const raw = baseStashStorage.getItem(PROMPT_STASH_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown } | null)?.state;
    if (!state) return null;
    return clearOrphanedPendingImages(decodePersistedPromptStashState(state).queuesByScopeKey);
  } catch {
    return null;
  }
}

interface PromptStashStoreState {
  queuesByScopeKey: Record<string, ReadonlyArray<PromptStashEntry>>;
  // prepends an entry and evicts the oldest item past the queue cap
  stashEntry: (entry: PromptStashEntry) => {
    evicted: PromptStashEntry | null;
    // false when the write did not reach durable storage
    durable: boolean;
  };
  // removes and returns an entry for restore or delete
  takeEntry: (
    scopeKey: string,
    entryId: string,
  ) => { entry: PromptStashEntry | null; durable: boolean };
  // attaches encoded images when the original stash entry still exists
  finalizeEntryImages: (
    scopeKey: string,
    entryId: string,
    images: {
      attachments: ReadonlyArray<PersistedComposerImageAttachment>;
      droppedImageNames: ReadonlyArray<string>;
      unreadableImageNames: ReadonlyArray<string>;
    },
  ) => { attached: boolean; durable: boolean };
}

export const usePromptStashStore = create<PromptStashStoreState>()((set, get) => ({
  queuesByScopeKey: {},
  stashEntry: (entry) => {
    const scopeKey = promptStashScopeKey(entry.providerInstanceId);
    const queues = get().queuesByScopeKey;
    const nextQueue = [entry, ...readQueue(queues, scopeKey)];
    const evicted =
      nextQueue.length > MAX_STASH_ENTRIES_PER_QUEUE ? (nextQueue.pop() ?? null) : null;
    const next = { ...queues, [scopeKey]: nextQueue };
    const { written, durable } = persistQueues(next);
    // a rejected write must not leave the entry visible either: the caller
    // keeps the composer intact on failure, so a stashed copy would
    // duplicate the prompt. Eviction likewise only sticks on success.
    if (!written) {
      return { evicted: null, durable: false };
    }
    set(() => ({ queuesByScopeKey: next }));
    return { evicted, durable };
  },
  takeEntry: (scopeKey, entryId) => {
    const queues = get().queuesByScopeKey;
    const queue = readQueue(queues, scopeKey);
    const entry = queue.find((candidate) => candidate.id === entryId) ?? null;
    if (!entry) return { entry: null, durable: true };
    const nextQueue = queue.filter((candidate) => candidate.id !== entryId);
    const next = { ...queues };
    if (nextQueue.length === 0) {
      delete next[scopeKey];
    } else {
      next[scopeKey] = nextQueue;
    }
    const { durable } = persistQueues(next);
    set(() => ({ queuesByScopeKey: next }));
    return { entry, durable };
  },
  finalizeEntryImages: (scopeKey, entryId, images) => {
    const queues = get().queuesByScopeKey;
    const queue = readQueue(queues, scopeKey);
    const index = queue.findIndex((candidate) => candidate.id === entryId);
    const existing = index === -1 ? undefined : queue[index];
    // restored or deleted mid-encode leaves nothing to attach to
    if (!existing) return { attached: false, durable: true };
    const nextQueue = [...queue];
    nextQueue[index] = {
      ...existing,
      attachments: images.attachments,
      droppedImageNames: images.droppedImageNames,
      unreadableImageNames: images.unreadableImageNames,
      pendingImageCount: 0,
    };
    const next = { ...queues, [scopeKey]: nextQueue };
    const { durable } = persistQueues(next);
    set(() => ({ queuesByScopeKey: next }));
    return { attached: true, durable };
  },
}));

// hydrate once at startup; like the other persisted stores, tabs are
// last-write-wins: no cross-tab merging or storage-event syncing.
{
  const persisted = readPersistedQueues();
  if (persisted) {
    usePromptStashStore.setState({ queuesByScopeKey: persisted });
  }
}

export const EMPTY_PROMPT_STASH_QUEUE: ReadonlyArray<PromptStashEntry> = [];

// seeds the persisted payload for tests without a real localstorage global
export function writePromptStashStorageForTest(raw: string): void {
  baseStashStorage.setItem(PROMPT_STASH_STORAGE_KEY, raw);
  usePromptStashStore.setState({ queuesByScopeKey: readPersistedQueues() ?? {} });
}
