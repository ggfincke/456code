// apps/web/src/components/chat/composer/composerMenuHighlight.ts
// resolve composer menu active item id

export function resolveComposerMenuActiveItemId(input: {
  items: ReadonlyArray<{ id: string }>
  highlightedItemId: string | null
  currentSearchKey: string | null
  highlightedSearchKey: string | null
}): string | null
{
  if (input.items.length === 0)
  {
    return null
  }

  if (
    input.currentSearchKey === input.highlightedSearchKey &&
    input.highlightedItemId &&
    input.items.some((item) => item.id === input.highlightedItemId)
  )
  {
    return input.highlightedItemId
  }

  return input.items[0]?.id ?? null
}
