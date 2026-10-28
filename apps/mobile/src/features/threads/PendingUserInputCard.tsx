import { Button } from "../../components/ui/Button";
import { QuestionAttachments } from "./QuestionAttachments";
import type { RuntimeRequestId } from "@t3tools/contracts";
import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import { useCallback, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  FadeInUp,
  FadeOutDown,
  useAnimatedStyle,
  useSharedValue,
  type DerivedValue,
  type SharedValue,
} from "react-native-reanimated";

import { USER_INPUT_TOGGLE_DURATION_MS } from "./pendingUserInputLayout";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { cn } from "../../lib/cn";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import {
  isPendingUserInputOptionSelected,
  isPendingUserInputQuestionAnswered,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly canOperateThread: boolean;
  readonly pendingUserInput: PendingUserInput;
  readonly maxHeight: DerivedValue<number>;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onStopThread?: () => void;
  readonly cardProgress?: SharedValue<number>;
  readonly cardCoverage?: SharedValue<number>;
  readonly onInputFocusChange?: (focused: boolean) => void;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly onSelectOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: RuntimeRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<unknown>;
  readonly onDismiss: () => Promise<unknown>;
}

/** Android cannot hit-test overlays beyond their parent's bounds; render its expanded card in-flow. */
const EXPANDED_CARD_IS_OVERLAY = Platform.OS === "ios";

// Long enough for the selection and the next step chip to visibly change before the question does.
const SINGLE_SELECT_ADVANCE_DELAY_MS = 300;

function QuestionText(props: { readonly markdown: string }) {
  const styles = useMarkdownPreviewStyles();
  const openLink = useOpenPullRequest();
  return (
    <SelectableMarkdownText
      markdown={props.markdown}
      textStyle={styles.nativeTextStyle}
      onLinkPress={(href) => void openLink(href)}
    />
  );
}

/** Callers key this card by request, so its step starts over for each new request. */
export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const questions = props.pendingUserInput.questions;
  const questionCount = questions.length;
  const canRespond = props.pendingUserInput.responseCapability !== "not_resumable";
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;
  const responseDisabled = !canRespond || isResponding;
  const isAnswered = (index: number) => {
    const question = questions[index];
    return (
      question !== undefined &&
      isPendingUserInputQuestionAnswered(question, props.drafts[question.id])
    );
  };
  const [questionIndex, setQuestionIndex] = useState(() => {
    const unanswered = questions.findIndex((_, index) => !isAnswered(index));
    return unanswered === -1 ? Math.max(questionCount - 1, 0) : unanswered;
  });
  // The step that a single-select tap is about to advance to.
  const [advancingTo, setAdvancingTo] = useState<number | null>(null);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeIndex = Math.min(questionIndex, Math.max(questionCount - 1, 0));
  const activeQuestion = questions[activeIndex];
  const isLastQuestion = activeIndex >= questionCount - 1;
  const canGoNext =
    props.canOperateThread &&
    !responseDisabled &&
    (isLastQuestion ? props.answers !== null : isAnswered(activeIndex));
  const goToQuestion = (index: number) => {
    if (advanceTimerRef.current !== null) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    setAdvancingTo(null);
    setQuestionIndex(index);
  };
  const goNext = () => {
    if (!canGoNext) return;
    if (isLastQuestion) {
      void props.onSubmit();
      return;
    }
    goToQuestion(activeIndex + 1);
  };
  const selectOption = (question: ThreadUserInputQuestion, value: string) => {
    props.onSelectOption(props.pendingUserInput.requestId, question, value);
    if (question.multiSelect || isLastQuestion) return;
    if (advanceTimerRef.current !== null) clearTimeout(advanceTimerRef.current);
    const nextIndex = activeIndex + 1;
    setAdvancingTo(nextIndex);
    advanceTimerRef.current = setTimeout(() => {
      advanceTimerRef.current = null;
      setAdvancingTo(null);
      setQuestionIndex(nextIndex);
    }, SINGLE_SELECT_ADVANCE_DELAY_MS);
  };
  const highlightedStep = advancingTo ?? activeIndex;

  const cardCoverage = props.cardCoverage;
  const barHeightRef = useRef(0);
  const cardHeightRef = useRef(0);
  const cardHeight = useSharedValue(0);
  const notifyCoverage = useCallback(() => {
    if (!cardCoverage) {
      return;
    }
    // The card resizes with the keyboard every frame, so easing each sample would leave the
    // feed inset and floating controls trailing it.
    cardCoverage.set(Math.max(0, cardHeightRef.current - barHeightRef.current));
  }, [cardCoverage]);
  const handleBarLayout = useCallback(
    (event: LayoutChangeEvent) => {
      barHeightRef.current = event.nativeEvent.layout.height;
      notifyCoverage();
    },
    [notifyCoverage],
  );
  const handleCardLayout = useCallback(
    (event: LayoutChangeEvent) => {
      cardHeightRef.current = event.nativeEvent.layout.height;
      cardHeight.set(event.nativeEvent.layout.height);
      notifyCoverage();
    },
    [cardHeight, notifyCoverage],
  );
  const cardProgress = props.cardProgress;
  const maxHeight = props.maxHeight;
  const cardAnimatedStyle = useAnimatedStyle(() => {
    const progress = cardProgress === undefined ? 1 : cardProgress.value;
    return {
      maxHeight: maxHeight.value,
      transform: [{ translateY: (1 - progress) * cardHeight.value }],
    };
  });
  const cardMaxHeightStyle = useAnimatedStyle(() => ({ maxHeight: maxHeight.value }));
  const overlayHeightStyle = useAnimatedStyle(() => ({ height: maxHeight.value }));

  // Keep the iOS card mounted so expansion starts on the UI thread without waiting for React layout.
  const renderCard = EXPANDED_CARD_IS_OVERLAY || !props.collapsed;
  const showBar = props.collapsed || EXPANDED_CARD_IS_OVERLAY;
  const bar = showBar ? (
    <View
      onLayout={handleBarLayout}
      pointerEvents={props.collapsed ? "auto" : "none"}
      accessibilityElementsHidden={!props.collapsed}
      importantForAccessibility={props.collapsed ? "auto" : "no-hide-descendants"}
      className="flex-row items-center gap-2 rounded-full border border-border bg-card-alt py-1.5 pl-4 pr-1.5"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Expand user input, ${questionCount} question${
          questionCount === 1 ? "" : "s"
        }`}
        onPress={props.onToggleCollapsed}
        className="min-h-10 flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          User input needed
        </Text>
        <Text className="font-sans text-xs text-foreground-muted">
          {questionCount} question{questionCount === 1 ? "" : "s"}
        </Text>
        <View className="flex-1" />
        <SymbolView
          name="chevron.up"
          size={12}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
        />
      </Pressable>
      {props.onStopThread ? (
        <ControlPill
          accessibilityLabel="Stop"
          icon="stop.fill"
          variant="danger"
          className="h-9 w-9"
          disabled={!props.canOperateThread}
          onPress={props.onStopThread}
        />
      ) : null}
    </View>
  ) : null;
  const card = renderCard ? (
    <Animated.View
      onLayout={handleCardLayout}
      pointerEvents={props.collapsed ? "none" : "auto"}
      accessibilityElementsHidden={props.collapsed}
      importantForAccessibility={props.collapsed ? "no-hide-descendants" : "auto"}
      entering={
        EXPANDED_CARD_IS_OVERLAY
          ? undefined
          : FadeInUp.duration(USER_INPUT_TOGGLE_DURATION_MS).easing(Easing.out(Easing.cubic))
      }
      exiting={
        EXPANDED_CARD_IS_OVERLAY
          ? undefined
          : FadeOutDown.duration(USER_INPUT_TOGGLE_DURATION_MS).easing(Easing.out(Easing.cubic))
      }
      className="overflow-hidden gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
      style={EXPANDED_CARD_IS_OVERLAY ? cardAnimatedStyle : cardMaxHeightStyle}
    >
      <View className="flex-row items-center gap-2">
        {questionCount > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="flex-1"
            contentContainerClassName="gap-1.5"
          >
            {questions.map((question, index) => {
              const answered = isAnswered(index);
              const current = index === highlightedStep;
              return (
                <Pressable
                  key={question.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${question.header}${answered ? ", answered" : ""}`}
                  accessibilityState={{ selected: current, disabled: isResponding }}
                  disabled={isResponding}
                  onPress={() => goToQuestion(index)}
                  className={cn(
                    "min-h-8 flex-row items-center gap-1 rounded-full border px-3",
                    current ? "border-primary bg-primary/10" : "border-border bg-input",
                  )}
                >
                  {answered ? (
                    <SymbolView
                      name="checkmark"
                      size={11}
                      tintColorClassName="accent-icon"
                      type="monochrome"
                    />
                  ) : null}
                  <Text
                    className={cn(
                      "font-t3-bold text-xs",
                      current ? "text-foreground" : "text-foreground-secondary",
                    )}
                  >
                    {question.header}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : (
          <Text className="flex-1 font-t3-bold text-xs uppercase tracking-[1px] text-foreground-muted">
            {activeQuestion?.header ?? "User input needed"}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Collapse user input"
          onPress={props.onToggleCollapsed}
          className="h-8 w-8 items-center justify-center rounded-full bg-subtle-strong active:opacity-70"
        >
          <SymbolView
            name="chevron.down"
            size={13}
            tintColorClassName={"accent-icon-subtle"}
            type="monochrome"
          />
        </Pressable>
      </View>
      <ScrollView
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-2.5 pb-1"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
        style={{ flexShrink: 1 }}
      >
        {!canRespond ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            The provider process for this request is no longer available. Interrupt or restart the
            run to continue.
          </Text>
        ) : null}
        {activeQuestion ? (
          <View key={activeQuestion.id} className="gap-2">
            <QuestionText markdown={activeQuestion.question} />
            <View className="gap-2">
              {activeQuestion.options.map((option) => {
                const draft = props.drafts[activeQuestion.id];
                const optionValue = option.value ?? option.label.trim();
                const selected = isPendingUserInputOptionSelected(
                  activeQuestion,
                  draft,
                  optionValue,
                );
                const description =
                  option.description !== option.label ? option.description : undefined;
                return (
                  <Pressable
                    key={optionValue}
                    accessibilityRole={activeQuestion.multiSelect ? "checkbox" : "radio"}
                    accessibilityState={{ checked: selected, disabled: responseDisabled }}
                    disabled={responseDisabled}
                    className={cn(
                      "min-h-12 w-full rounded-2xl border px-3.5 py-3",
                      selected ? "border-primary bg-primary/10" : "border-border bg-input",
                    )}
                    onPress={() => selectOption(activeQuestion, optionValue)}
                  >
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text
                        className={cn(
                          "font-t3-bold text-sm",
                          selected ? "text-foreground" : "text-foreground-secondary",
                        )}
                      >
                        {option.label}
                      </Text>
                      {description ? (
                        <Text className="font-sans text-sm leading-5 text-foreground-muted">
                          {description}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {activeQuestion.allowCustomAnswer !== false ? (
              <QuestionAttachments
                key={`${props.pendingUserInput.requestId}:${activeQuestion.id}`}
                requestId={props.pendingUserInput.requestId}
                question={activeQuestion}
                questions={questions}
                disabled={responseDisabled}
                value={props.drafts[activeQuestion.id]?.customAnswer ?? ""}
                onChangeText={(value) =>
                  props.onChangeCustomAnswer(
                    props.pendingUserInput.requestId,
                    activeQuestion.id,
                    value,
                  )
                }
                onSubmitEditing={goNext}
                onInputFocusChange={props.onInputFocusChange}
              />
            ) : null}
          </View>
        ) : null}
      </ScrollView>
      <View className="flex-row gap-2">
        {activeIndex > 0 ? (
          <View className="flex-1">
            <Button
              label="Back"
              fullWidth
              disabled={isResponding}
              onPress={() => goToQuestion(activeIndex - 1)}
            />
          </View>
        ) : null}
        <View className="flex-1">
          <Button
            label={
              isLastQuestion ? (questionCount > 1 ? "Submit answers" : "Submit answer") : "Next"
            }
            fullWidth
            loading={isResponding}
            tone={canGoNext ? "primary" : "secondary"}
            disabled={!canGoNext}
            onPress={goNext}
          />
        </View>
      </View>
      {props.pendingUserInput.dismissible ? (
        <Button
          label="Dismiss without answering"
          tone="text"
          disabled={isResponding}
          onPress={() => void props.onDismiss()}
        />
      ) : null}
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-tertiary">
          This connection cannot submit answers.
        </Text>
      ) : null}
    </Animated.View>
  ) : null;
  return (
    <View className="relative">
      {bar}
      {EXPANDED_CARD_IS_OVERLAY ? (
        <Animated.View
          pointerEvents={props.collapsed ? "none" : "box-none"}
          className="absolute inset-x-0 bottom-0 justify-end overflow-hidden"
          style={overlayHeightStyle}
        >
          {card}
        </Animated.View>
      ) : (
        card
      )}
    </View>
  );
}
