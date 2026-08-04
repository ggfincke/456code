// apps/mobile/src/features/layout/workspace-pane-animation.ts
// expose workspace pane timing

import { Easing, ReduceMotion } from 'react-native-reanimated'

// one timing curve for every workspace pane (primary sidebar + inspector).
//
// panes frequently animate together — opening the sidebar can auto-close the
// inspector when both no longer fit — so identical duration and easing on
// every pane keeps the center content pane from wobbling while both edges
// move. Asymmetric open/close timings (the previous 220ms out-cubic open vs
// 160ms in-cubic close) read as jank during those simultaneous swaps.
export const WORKSPACE_PANE_TIMING = {
  duration: 260,
  easing: Easing.inOut(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const
