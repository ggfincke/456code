// apps/web/src/components/command-palette/uiState.ts
// reduce command palette open/intent UI state

export interface CommandPaletteOpenIntent
{
  readonly kind: 'add-project' | 'new-thread-in'
}

export interface CommandPaletteUiState
{
  readonly open: boolean
  readonly openIntent: CommandPaletteOpenIntent | null
}

export type CommandPaletteUiAction =
  | { readonly _tag: 'SetOpen'; readonly open: boolean }
  | { readonly _tag: 'Toggle' }
  | { readonly _tag: 'OpenAddProject' }
  | { readonly _tag: 'OpenNewThreadIn' }
  | { readonly _tag: 'ClearOpenIntent' }

export function reduceCommandPaletteUiState(
  state: CommandPaletteUiState,
  action: CommandPaletteUiAction,
): CommandPaletteUiState
{
  switch (action._tag)
  {
    case 'SetOpen':
      return {
        open: action.open,
        openIntent: action.open ? state.openIntent : null,
      }
    case 'Toggle':
      return { open: !state.open, openIntent: null }
    case 'OpenAddProject':
      return { open: true, openIntent: { kind: 'add-project' } }
    case 'OpenNewThreadIn':
      return { open: true, openIntent: { kind: 'new-thread-in' } }
    case 'ClearOpenIntent':
      return state.openIntent ? { ...state, openIntent: null } : state
  }
}
