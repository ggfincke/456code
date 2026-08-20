// apps/web/src/components/command-palette/uiState.ts
// reduce command palette open/intent UI state

export interface CommandPaletteOpenIntent
{
  readonly kind: 'add-project' | 'new-thread-in'
}

export interface CommandPaletteUiState
{
  readonly open: boolean
  readonly openGeneration: number
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
      return action.open
        ? {
            open: true,
            openGeneration: state.open ? state.openGeneration : state.openGeneration + 1,
            openIntent: state.openIntent,
          }
        : { ...state, open: false, openIntent: null }
    case 'Toggle':
      return state.open
        ? { ...state, open: false, openIntent: null }
        : { open: true, openGeneration: state.openGeneration + 1, openIntent: null }
    case 'OpenAddProject':
      return {
        open: true,
        openGeneration: state.open ? state.openGeneration : state.openGeneration + 1,
        openIntent: { kind: 'add-project' },
      }
    case 'OpenNewThreadIn':
      return {
        open: true,
        openGeneration: state.open ? state.openGeneration : state.openGeneration + 1,
        openIntent: { kind: 'new-thread-in' },
      }
    case 'ClearOpenIntent':
      return state.openIntent ? { ...state, openIntent: null } : state
  }
}
