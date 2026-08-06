// apps/web/src/components/chat/composer/ComposerPendingReviewComments.tsx
// render composer pending review comments

import { MessageCircle } from 'lucide-react'

import { ComposerRemovableChip, ComposerRemovableChipList } from './ComposerRemovableChip'
import type { ReviewCommentContext } from '~/reviewCommentContext'

interface ComposerPendingReviewCommentsProps
{
  comments: ReadonlyArray<ReviewCommentContext>
  onRemove: (commentId: string) => void
  className?: string
}

export function ComposerPendingReviewComments({
  comments,
  onRemove,
  className,
}: ComposerPendingReviewCommentsProps)
{
  if (comments.length === 0) return null

  return (
    <ComposerRemovableChipList className={className}>
      {comments.map((comment) =>
      {
        const label = `${comment.filePath} ${comment.rangeLabel}`
        return (
          <ComposerRemovableChip
            key={comment.id}
            icon={MessageCircle}
            label={label}
            removeLabel={`Remove comment on ${label}`}
            tooltip={comment.text}
            onRemove={() => onRemove(comment.id)}
          />
        )
      })}
    </ComposerRemovableChipList>
  )
}
