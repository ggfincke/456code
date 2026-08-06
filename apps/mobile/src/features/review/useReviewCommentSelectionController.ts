// apps/mobile/src/features/review/useReviewCommentSelectionController.ts
// manage review comment selection controller through a React hook

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { NativeSyntheticEvent } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import * as Arr from 'effect/Array'
import { pipe } from 'effect/Function'
import * as Result from 'effect/Result'

import type { EnvironmentId, ThreadId } from '@t3tools/contracts'
import {
  buildReviewCommentTarget,
  clearReviewCommentTarget,
  formatReviewSelectedRangeLabel,
  getSelectedReviewCommentLines,
  setReviewCommentTarget,
  useReviewCommentTarget,
} from './reviewCommentSelection'
import type { NativeReviewDiffData, NativeReviewDiffCommentTarget } from './nativeReviewDiffAdapter'
import type { ReviewSectionItem } from './reviewModel'

interface PendingNativeCommentSelection extends NativeReviewDiffCommentTarget
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly sectionId: string
  readonly sectionTitle: string
  readonly rowId: string
}

export function useReviewCommentSelectionController(input: {
  readonly environmentId?: EnvironmentId
  readonly threadId?: ThreadId
  readonly selectedSection: ReviewSectionItem | null
  readonly nativeReviewDiffData: NativeReviewDiffData
})
{
  const { environmentId, nativeReviewDiffData, selectedSection, threadId } = input
  const navigation = useNavigation()
  const activeCommentTarget = useReviewCommentTarget()
  const [pendingNativeCommentSelection, setPendingNativeCommentSelection] =
    useState<PendingNativeCommentSelection | null>(null)
  const activeRouteCommentTarget =
    activeCommentTarget &&
    activeCommentTarget.environmentId === environmentId &&
    activeCommentTarget.threadId === threadId &&
    activeCommentTarget.sectionId === selectedSection?.id
      ? activeCommentTarget
      : null
  const pendingRouteCommentSelection =
    pendingNativeCommentSelection &&
    pendingNativeCommentSelection.environmentId === environmentId &&
    pendingNativeCommentSelection.threadId === threadId &&
    pendingNativeCommentSelection.sectionId === selectedSection?.id
      ? pendingNativeCommentSelection
      : null

  const openReviewCommentSheet = useCallback(() =>
  {
    if (!environmentId || !threadId)
    {
      return
    }

    navigation.navigate('ThreadReviewComment', {
      environmentId,
      threadId,
    })
  }, [environmentId, navigation, threadId])

  const selectedRowIds = useMemo(() =>
  {
    if (
      activeRouteCommentTarget &&
      activeRouteCommentTarget.startIndex !== activeRouteCommentTarget.endIndex
    )
    {
      return pipe(
        getSelectedReviewCommentLines(activeRouteCommentTarget),
        Arr.filterMap((line) =>
        {
          const rowId = nativeReviewDiffData.rowIdByCommentLineId.get(line.id)
          return rowId ? Result.succeed(rowId) : Result.failVoid
        }),
      )
    }

    return pendingRouteCommentSelection ? [pendingRouteCommentSelection.rowId] : []
  }, [
    activeRouteCommentTarget,
    nativeReviewDiffData.rowIdByCommentLineId,
    pendingRouteCommentSelection,
  ])

  const selectionAction = useMemo(() =>
  {
    if (
      activeRouteCommentTarget &&
      activeRouteCommentTarget.startIndex !== activeRouteCommentTarget.endIndex
    )
    {
      return {
        title: `Comment on ${formatReviewSelectedRangeLabel(activeRouteCommentTarget)}`,
        onOpenComment: openReviewCommentSheet,
      }
    }

    if (pendingRouteCommentSelection)
    {
      return {
        title: 'Select range end',
        onOpenComment: null,
      }
    }

    return null
  }, [activeRouteCommentTarget, openReviewCommentSheet, pendingRouteCommentSelection])

  useEffect(() =>
  {
    clearReviewCommentTarget()
    setPendingNativeCommentSelection(null)
  }, [environmentId, selectedSection?.id, threadId])

  useEffect(() =>
  {
    if (activeCommentTarget === null)
    {
      setPendingNativeCommentSelection(null)
    }
  }, [activeCommentTarget])

  const onPressLine = useCallback(
    (
      event: NativeSyntheticEvent<{
        readonly rowId?: string
        readonly gesture?: 'tap' | 'longPress'
      }>,
    ) =>
    {
      if (!environmentId || !selectedSection || !threadId)
      {
        return
      }

      const { rowId, gesture } = event.nativeEvent
      if (!rowId)
      {
        return
      }

      const target = nativeReviewDiffData.commentTargetsByRowId.get(rowId)
      if (!target)
      {
        return
      }

      if (gesture === 'longPress')
      {
        clearReviewCommentTarget()
        setPendingNativeCommentSelection({
          ...target,
          environmentId,
          threadId,
          sectionId: selectedSection.id,
          sectionTitle: selectedSection.title,
          rowId,
        })
        return
      }

      if (
        pendingRouteCommentSelection &&
        pendingRouteCommentSelection.filePath === target.filePath
      )
      {
        setReviewCommentTarget(
          buildReviewCommentTarget(
            {
              environmentId: pendingRouteCommentSelection.environmentId,
              threadId: pendingRouteCommentSelection.threadId,
              sectionTitle: pendingRouteCommentSelection.sectionTitle,
              sectionId: pendingRouteCommentSelection.sectionId,
              filePath: pendingRouteCommentSelection.filePath,
              lines: pendingRouteCommentSelection.lines,
            },
            pendingRouteCommentSelection.lineIndex,
            target.lineIndex,
          ),
        )
        return
      }

      setPendingNativeCommentSelection(null)
      setReviewCommentTarget({
        environmentId,
        threadId,
        sectionTitle: selectedSection.title,
        sectionId: selectedSection.id,
        filePath: target.filePath,
        lines: target.lines,
        startIndex: target.lineIndex,
        endIndex: target.lineIndex,
      })
      openReviewCommentSheet()
    },
    [
      nativeReviewDiffData.commentTargetsByRowId,
      environmentId,
      openReviewCommentSheet,
      pendingRouteCommentSelection,
      selectedSection,
      threadId,
    ],
  )

  const clearSelection = useCallback(() =>
  {
    clearReviewCommentTarget()
    setPendingNativeCommentSelection(null)
  }, [])

  return {
    selectedRowIds,
    selectionAction,
    onPressLine,
    clearSelection,
  }
}
