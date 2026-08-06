// apps/mobile/src/features/layout/workspace-inspector-pane.tsx
// render workspace inspector pane

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Gesture } from 'react-native-gesture-handler'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'

import {
  AUXILIARY_PANE_MAX_WIDTH,
  AUXILIARY_PANE_MIN_WIDTH,
  constrainAuxiliaryPaneWidth,
  type WorkspacePaneLayout,
} from '../../lib/layout'
import { WORKSPACE_PANE_TIMING } from './workspace-pane-animation'
import { WorkspacePaneDivider } from './workspace-pane-divider'

// the trailing inspector column: resize divider + animated reveal.
//
// rendered by AdaptiveWorkspaceLayout as a SIBLING of the navigator so the
// native stack header (and its trailing toolbar items) spans only the content
// pane — the inspector owns its own full-height column, mirroring how each
// column of a UISplitViewController has its own chrome.
//
// receives the pane layout via props (not the workspace context hook) so this
// module stays import-cycle-free with AdaptiveWorkspaceLayout.
export function WorkspaceInspectorPane(props: {
  // when false the pane animates closed but keeps its content mounted for the
  // exit transition (a route that lost focus). `onClosed` fires once the
  // close animation settles so the owner can drop the stale content.
  readonly active?: boolean
  readonly onClosed?: () => void
  readonly panes: WorkspacePaneLayout
  readonly renderInspector?: () => ReactNode
  readonly setAuxiliaryPaneWidth: (width: number) => void
})
{
  const { panes, setAuxiliaryPaneWidth } = props
  const inspectorWidth = panes.auxiliaryPaneWidth
  const inspectorSupported = props.renderInspector !== undefined && inspectorWidth !== null
  const inspectorVisible =
    inspectorSupported && panes.auxiliaryPaneVisible && (props.active ?? true)
  const [resizing, setResizing] = useState(false)

  // a file-to-file replace remounts the route. Initialize an already-visible
  // inspector at its final position so route replacement never replays an
  // entering transition. Only visibility and explicit resizing change it.
  const inspectorProgress = useSharedValue(inspectorVisible ? 1 : 0)
  const renderedInspectorWidth = useSharedValue(inspectorVisible ? (inspectorWidth ?? 0) : 0)
  // the content keeps its own width so the reveal (outer width) clips a
  // fully-laid-out pane instead of reflowing text every frame. When the OPEN
  // pane's target width changes (e.g. the sidebar toggles and reserves
  // space), animate the content width in lockstep rather than snapping.
  const renderedContentWidth = useSharedValue(inspectorWidth ?? 0)

  const onClosed = props.onClosed
  useEffect(() =>
  {
    inspectorProgress.value = withTiming(
      inspectorVisible ? 1 : 0,
      WORKSPACE_PANE_TIMING,
      (finished) =>
      {
        if (finished === true && !inspectorVisible && onClosed !== undefined)
        {
          runOnJS(onClosed)()
        }
      },
    )
    const targetWidth = inspectorVisible ? (inspectorWidth ?? 0) : 0
    if (!resizing)
    {
      renderedInspectorWidth.value = withTiming(targetWidth, WORKSPACE_PANE_TIMING)
    }
  }, [
    inspectorProgress,
    inspectorVisible,
    inspectorWidth,
    onClosed,
    renderedInspectorWidth,
    resizing,
  ])

  useEffect(() =>
  {
    const targetWidth = inspectorWidth ?? 0
    if (resizing)
    {
      return
    }
    if (!inspectorVisible)
    {
      // hidden panes re-measure silently.
      renderedContentWidth.value = targetWidth
      return
    }
    renderedContentWidth.value = withTiming(targetWidth, WORKSPACE_PANE_TIMING)
  }, [inspectorVisible, inspectorWidth, renderedContentWidth, resizing])

  const inspectorStyle = useAnimatedStyle(
    () => ({
      opacity: inspectorProgress.value,
      transform: [{ translateX: (1 - inspectorProgress.value) * 24 }],
      width: renderedInspectorWidth.value,
    }),
    [],
  )
  const inspectorContentStyle = useAnimatedStyle(() => ({ width: renderedContentWidth.value }), [])
  const beginResize = useCallback(() =>
  {
    setResizing(true)
  }, [])
  const resizeBy = useCallback(
    (delta: number) =>
    {
      setAuxiliaryPaneWidth(
        constrainAuxiliaryPaneWidth({
          preferredWidth: (inspectorWidth ?? 0) + delta,
          availableWidth: panes.contentPaneWidth,
        }),
      )
    },
    [inspectorWidth, panes.contentPaneWidth, setAuxiliaryPaneWidth],
  )
  const commitResize = useCallback(
    (width: number) =>
    {
      setAuxiliaryPaneWidth(width)
      setResizing(false)
    },
    [setAuxiliaryPaneWidth],
  )
  const resizeStartWidth = useSharedValue(inspectorWidth ?? 0)
  const maxResizeWidth = constrainAuxiliaryPaneWidth({
    preferredWidth: AUXILIARY_PANE_MAX_WIDTH,
    availableWidth: panes.contentPaneWidth,
  })
  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-4, 4])
        .failOffsetY([-24, 24])
        .onStart(() =>
        {
          resizeStartWidth.value = renderedInspectorWidth.value
          runOnJS(beginResize)()
        })
        .onUpdate((event) =>
        {
          const width = Math.min(
            maxResizeWidth,
            Math.max(
              AUXILIARY_PANE_MIN_WIDTH,
              Math.round(resizeStartWidth.value - event.translationX),
            ),
          )
          renderedInspectorWidth.value = width
          renderedContentWidth.value = width
        })
        .onFinalize(() =>
        {
          runOnJS(commitResize)(renderedInspectorWidth.value)
        }),
    [
      beginResize,
      commitResize,
      maxResizeWidth,
      renderedContentWidth,
      renderedInspectorWidth,
      resizeStartWidth,
    ],
  )

  return (
    <>
      {inspectorVisible ? (
        <WorkspacePaneDivider
          accessibilityLabel="Resize detail pane"
          active={resizing}
          currentWidth={inspectorWidth ?? 0}
          gesture={resizeGesture}
          onResizeBy={resizeBy}
        />
      ) : null}
      {inspectorSupported ? (
        <Animated.View
          className="shrink-0 overflow-hidden"
          accessibilityElementsHidden={!inspectorVisible}
          collapsable={false}
          importantForAccessibility={inspectorVisible ? 'auto' : 'no-hide-descendants'}
          pointerEvents={inspectorVisible ? 'auto' : 'none'}
          style={inspectorStyle}
        >
          <Animated.View className="flex-1" style={inspectorContentStyle}>
            {props.renderInspector?.()}
          </Animated.View>
        </Animated.View>
      ) : null}
    </>
  )
}
