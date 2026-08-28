// apps/mobile/src/features/threads/activity/PendingUserInputCard.tsx
// render pending user input card

import type { ApprovalRequestId, ProviderUserInputAnswers } from '@t3tools/contracts'
import { Pressable, View } from 'react-native'

import { AppText as Text, AppTextInput as TextInput } from '../../../components/AppText'
import { cn } from '../../../lib/cn'
import type { PendingUserInput } from '../../../lib/threadActivity'
import type { MobilePendingUserInputDraftAnswer } from '../use-thread-requests'

export interface PendingUserInputCardProps
{
  readonly pendingUserInput: PendingUserInput
  readonly drafts: Record<string, MobilePendingUserInputDraftAnswer>
  readonly answers: ProviderUserInputAnswers | null
  readonly respondingUserInputId: ApprovalRequestId | null
  readonly onSelectOption: (requestId: ApprovalRequestId, questionId: string, label: string) => void
  readonly onChangeCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void
  readonly onSubmit: () => Promise<unknown>
}

export function PendingUserInputCard(props: PendingUserInputCardProps)
{
  return (
    <View className="gap-2.5 rounded-[20px] border border-adaptive-neutral-200-white-a6 bg-adaptive-neutral-100-a80-900-a80 p-4">
      <Text className="font-sans-bold text-2xs uppercase tracking-[1.1px] text-adaptive-sky-700-300">
        User input needed
      </Text>
      <Text className="font-sans-bold text-lg text-adaptive-neutral-950-50">
        Fill in the pending answers
      </Text>
      {props.pendingUserInput.questions.map((question) =>
      {
        const draft = props.drafts[question.id]
        return (
          <View key={question.id} className="gap-2 pt-1">
            <Text className="font-sans-bold text-xs uppercase tracking-[1px] text-adaptive-neutral-500-500">
              {question.header}
            </Text>
            <Text className="font-sans text-base leading-snug text-adaptive-neutral-950-50">
              {question.question}
            </Text>
            <View className="flex-row flex-wrap gap-2.5">
              {question.options.map((option) =>
              {
                const selected =
                  draft?.selectedOptionLabels?.includes(option.label) === true &&
                  !draft.customAnswer?.trim().length
                return (
                  <Pressable
                    key={option.label}
                    className={cn(
                      'rounded-full border px-3 py-2.5 ',
                      selected
                        ? 'border-adaptive-blue-300-a50-blue-400-a28 bg-adaptive-blue-50-blue-400-a14'
                        : 'border-adaptive-neutral-200-white-a6 bg-adaptive-white-neutral-950-a70',
                    )}
                    onPress={() =>
                      props.onSelectOption(
                        props.pendingUserInput.requestId,
                        question.id,
                        option.label,
                      )
                    }
                  >
                    <Text
                      className={cn(
                        'font-sans-bold text-sm',
                        selected ? 'text-adaptive-sky-700-300' : 'text-adaptive-neutral-600-300',
                      )}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
            <TextInput
              value={draft?.customAnswer ?? ''}
              onChangeText={(value) =>
                props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
              }
              placeholder="Or type a custom answer"
              className="min-h-[54px] rounded-2xl border border-adaptive-neutral-200-white-a8 bg-adaptive-white-neutral-950-a70 px-3.5 py-3 font-sans text-base text-adaptive-neutral-950-50"
            />
          </View>
        )
      })}
      <Pressable
        className={cn(
          'items-center justify-center rounded-2xl px-4 py-3.5',
          props.answers ? 'bg-blue-500' : 'bg-adaptive-neutral-200-700-a60',
        )}
        disabled={
          props.answers === null || props.respondingUserInputId === props.pendingUserInput.requestId
        }
        onPress={() => void props.onSubmit()}
      >
        <Text className="font-sans-extrabold text-sm text-white">Submit answers</Text>
      </Pressable>
    </View>
  )
}
