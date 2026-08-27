// apps/mobile/src/features/threads/activity/PendingApprovalCard.tsx
// render pending approval card

import type { ApprovalRequestId, ProviderApprovalDecision } from '@t3tools/contracts'
import { Pressable, View } from 'react-native'

import { AppText as Text } from '../../../components/AppText'
import type { PendingApproval } from '../../../lib/threadActivity'
import { derivePendingApprovalPresentation } from './pendingApprovalPresentation'

export interface PendingApprovalCardProps
{
  readonly approval: PendingApproval
  readonly respondingApprovalId: ApprovalRequestId | null
  readonly onRespond: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>
}

export function PendingApprovalCard(props: PendingApprovalCardProps)
{
  const presentation = derivePendingApprovalPresentation(props.approval)
  const isResponding = props.respondingApprovalId === props.approval.requestId

  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100/80 p-4 dark:border-white/6 dark:bg-neutral-900/80">
      <Text className="font-sans-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
        Approval needed
      </Text>
      <Text className="font-sans-bold text-lg text-neutral-950 dark:text-neutral-50">
        {presentation.title}
      </Text>
      {presentation.contextLabel ? (
        <Text className="font-sans-medium text-xs text-neutral-500 dark:text-neutral-400">
          {presentation.contextLabel}
        </Text>
      ) : null}
      {props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-neutral-600 dark:text-neutral-400">
          {props.approval.detail}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {presentation.options.map((option) =>
        {
          const isAccept = option.decision === 'accept'
          const isDecline = option.decision === 'decline' || option.decision === 'cancel'
          const buttonClassName = isAccept
            ? 'items-center justify-center rounded-[14px] bg-blue-500 px-3.5 py-3'
            : isDecline
              ? 'items-center justify-center rounded-[14px] bg-rose-100 px-3.5 py-3 dark:bg-rose-500/18'
              : 'items-center justify-center rounded-[14px] bg-neutral-200 px-3.5 py-3 dark:bg-neutral-800'
          const labelClassName = isAccept
            ? 'font-sans-extrabold text-sm text-white'
            : isDecline
              ? 'font-sans-bold text-sm text-rose-700 dark:text-rose-300'
              : 'font-sans-bold text-sm text-neutral-950 dark:text-neutral-50'

          return (
            <Pressable
              key={`${option.decision}:${option.label}`}
              className={buttonClassName}
              disabled={isResponding}
              onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
            >
              <Text className={labelClassName}>{option.label}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}
