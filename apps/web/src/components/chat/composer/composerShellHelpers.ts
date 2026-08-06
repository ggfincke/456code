// apps/web/src/components/chat/composer/composerShellHelpers.ts
// pure helpers for composer prompt replacement and floating-layer focus

import type { TerminalContextDraft } from '../../../lib/terminalContext'

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(',')

export const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number =>
{
  if (!replacement.endsWith(' '))
  {
    return rangeEnd
  }
  return text[rangeEnd] === ' ' ? rangeEnd + 1 : rangeEnd
}

export const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] =>
{
  const contextsById = new Map(contexts.map((context) => [context.id, context]))
  return ids.flatMap((id) =>
  {
    const context = contextsById.get(id)
    return context ? [context] : []
  })
}

export const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index])

export function isInsideComposerFloatingLayer(element: Element): boolean
{
  return element.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null
}
