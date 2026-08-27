// apps/mobile/src/features/threads/sidebar/thread-search-match.tsx
// renders literal conversation matches with accessible source labels

import type { EnvironmentThreadSearchMatch } from '@t3tools/client-runtime/state/thread-search'
import { AppText as Text } from '../../../components/AppText'
import { cn } from '../../../lib/cn'
import { splitThreadSearchHighlight } from './threadSearchHighlight'

export function ThreadSearchMatchExcerpt(props: {
  readonly match: EnvironmentThreadSearchMatch
  readonly query: string
  readonly selected?: boolean
  readonly compact?: boolean
})
{
  return (
    <Text
      numberOfLines={2}
      className={cn(
        props.compact ? 'text-sm' : 'text-xs',
        props.selected ? 'text-user-bubble-foreground-muted' : 'text-foreground-muted',
      )}
    >
      <Text className="font-sans-medium">
        {props.match.source === 'user' ? 'You: ' : 'Agent: '}
      </Text>
      {splitThreadSearchHighlight(props.match.snippet, props.query).map((part) => (
        <Text key={part.start} className={part.highlighted ? 'font-sans-bold' : undefined}>
          {part.text}
        </Text>
      ))}
    </Text>
  )
}
