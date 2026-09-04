// apps/mobile/src/features/threads/activity/PendingApprovalCard.tsx
// render pending approval card

import type { ApprovalRequestId, ProviderApprovalDecision } from '@t3tools/contracts'
import { Pressable, View } from 'react-native'

import { AppText as Text } from '../../../components/AppText'
import type { PendingApproval } from '../../../lib/threadActivity'
import {
  derivePendingApprovalPresentation,
  isApprovalResponseLocked,
} from './pendingApprovalPresentation'

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
  const isResponseLocked = isApprovalResponseLocked(props.approval, props.respondingApprovalId)

  return (
    <View className="gap-2.5 rounded-[20px] border border-adaptive-neutral-200-white-a6 bg-adaptive-neutral-100-a80-900-a80 p-4">
      <Text className="font-sans-bold text-2xs uppercase tracking-[1.1px] text-adaptive-sky-700-300">
        Approval needed
      </Text>
      <Text className="font-sans-bold text-lg text-adaptive-neutral-950-50">
        {presentation.title}
      </Text>
      {presentation.contextLabel ? (
        <Text className="font-sans-medium text-xs text-adaptive-neutral-500-400">
          {presentation.contextLabel}
        </Text>
      ) : null}
      {presentation.lifecycleLabel ? (
        <Text
          accessibilityLiveRegion="polite"
          className="font-sans-medium text-sm leading-normal text-adaptive-neutral-500-400"
        >
          {presentation.lifecycleLabel}
        </Text>
      ) : null}
      {props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-adaptive-neutral-600-400">
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
              ? 'items-center justify-center rounded-[14px] bg-adaptive-rose-100-500-a18 px-3.5 py-3'
              : 'items-center justify-center rounded-[14px] bg-adaptive-neutral-200-800 px-3.5 py-3'
          const labelClassName = isAccept
            ? 'font-sans-extrabold text-sm text-white'
            : isDecline
              ? 'font-sans-bold text-sm text-adaptive-rose-700-300'
              : 'font-sans-bold text-sm text-adaptive-neutral-950-50'

          return (
            <Pressable
              key={`${option.decision}:${option.label}`}
              className={buttonClassName}
              disabled={isResponseLocked}
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
