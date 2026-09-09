// apps/mobile/src/features/threads/sidebar/ThreadArrangementSheet.tsx
// arrange active tasks with native drag handles and accessible move actions

import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Modal, PanResponder, Pressable, ScrollView, View } from 'react-native'

import { AppText as Text } from '../../../components/AppText'
import { resolveThreadDragDestination } from './threadDragGap'

const ROW_HEIGHT = 56

function ArrangementRow(props: {
  readonly thread: EnvironmentThreadShell
  readonly index: number
  readonly count: number
  readonly disabled: boolean
  readonly onDragActive: (active: boolean) => void
  readonly onMove: (from: number, to: number) => void
})
{
  const [offset, setOffset] = useState(0)
  const currentProps = useRef(props)
  currentProps.current = props
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !currentProps.current.disabled,
        onPanResponderGrant: () => currentProps.current.onDragActive(true),
        onPanResponderMove: (_event, gesture) => setOffset(gesture.dy),
        onPanResponderRelease: (_event, gesture) =>
        {
          setOffset(0)
          const current = currentProps.current
          current.onDragActive(false)
          if (!current.disabled)
          {
            current.onMove(
              current.index,
              resolveThreadDragDestination(current.index, gesture.dy, ROW_HEIGHT, current.count),
            )
          }
        },
        onPanResponderTerminate: () =>
        {
          setOffset(0)
          currentProps.current.onDragActive(false)
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  )

  return (
    <View
      className="flex-row items-center gap-3 border-b border-border bg-surface px-4"
      style={{
        height: ROW_HEIGHT,
        zIndex: offset === 0 ? 0 : 1,
        transform: [{ translateY: offset }],
      }}
    >
      <Text className="flex-1 text-foreground" numberOfLines={1}>
        {props.thread.title}
      </Text>
      <View
        {...responder.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Arrange ${props.thread.title}`}
        accessibilityHint="Drag vertically to move, or use the adjustment actions."
        accessibilityState={{ disabled: props.disabled }}
        accessibilityActions={[
          { name: 'increment', label: 'Move down' },
          { name: 'decrement', label: 'Move up' },
        ]}
        onAccessibilityAction={(event) =>
        {
          if (props.disabled) return
          const next = props.index + (event.nativeEvent.actionName === 'increment' ? 1 : -1)
          if (next >= 0 && next < props.count) props.onMove(props.index, next)
        }}
        className="items-center justify-center p-3"
      >
        <Text className="text-xl text-foreground-muted">≡</Text>
      </View>
    </View>
  )
}

export function ThreadArrangementSheet(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>
  readonly onClose: () => void
  readonly onReorder: (
    ordered: ReadonlyArray<EnvironmentThreadShell>,
    movedId: string,
  ) => Promise<void>
})
{
  const [dragging, setDragging] = useState(false)
  const [saving, setSaving] = useState(false)
  const move = useCallback(
    (from: number, to: number) =>
    {
      if (saving || from === to) return
      const ordered = [...props.threads]
      const moved = ordered.splice(from, 1)[0]
      if (!moved) return
      ordered.splice(to, 0, moved)
      setSaving(true)
      void props.onReorder(ordered, moved.id).finally(() => setSaving(false))
    },
    [props.threads, props.onReorder, saving],
  )
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-screen pt-6">
        <View className="flex-row items-center justify-between px-4 pb-4">
          <Text className="text-lg font-sans-bold text-foreground">Arrange active tasks</Text>
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            disabled={saving}
            className="p-2"
          >
            <Text className="text-accent">Done</Text>
          </Pressable>
        </View>
        <Text className="px-4 pb-4 text-sm text-foreground-muted" accessibilityLiveRegion="polite">
          {saving
            ? 'Saving order…'
            : 'Drag a handle to move a task. Pinned, snoozed, and settled tasks keep their separate sections.'}
        </Text>
        <ScrollView scrollEnabled={!dragging && !saving}>
          {props.threads.map((thread, index) => (
            <ArrangementRow
              key={thread.id}
              thread={thread}
              index={index}
              count={props.threads.length}
              disabled={saving}
              onDragActive={setDragging}
              onMove={move}
            />
          ))}
        </ScrollView>
      </View>
    </Modal>
  )
}
