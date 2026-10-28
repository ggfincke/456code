import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import {
  memo,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  resolvePendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { Button } from "../ui/button";
import { CheckboxMark } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Textarea } from "../ui/textarea";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import ChatMarkdown from "../ChatMarkdown";

// Long enough for the radio and the next step chip to visibly change before the question does.
const SINGLE_SELECT_ADVANCE_DELAY_MS = 300;

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  attachmentBlockReason: string | null;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onChangeCustomAnswer: (questionId: string, value: string) => void;
  onPasteFiles: (files: File[]) => void;
  onSelectQuestion: (questionIndex: number) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  ...props
}: PendingUserInputPanelProps) {
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      {...props}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  cwd,
  threadRef,
  disabled = false,
  isResponding,
  answers,
  questionIndex,
  attachmentBlockReason,
  onToggleOption,
  onChangeCustomAnswer,
  onPasteFiles,
  onSelectQuestion,
  onAdvance,
  onDismiss,
}: Omit<PendingUserInputPanelProps, "pendingUserInputs" | "respondingRequestIds"> & {
  prompt: PendingUserInput;
  isResponding: boolean;
}) {
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const customAnswerInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const advance = useStableCallback(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  // The question whose single-select click is about to advance, so the next step lights up first.
  const [advancingQuestionId, setAdvancingQuestionId] = useState<string | null>(null);
  // Picking an option clears the custom answer; keep the typed text in the field so it isn't lost.
  const [keptCustomAnswers, setKeptCustomAnswers] = useState<Record<string, string>>({});
  // Keep question identity stable for its shortcut listener.
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const customAnswerActive = progress.usingCustomAnswer;
  // Read before later hooks to preserve the question's compiler cache.
  const draftSelectedOptions = activeQuestion?.options.map(
    (option) =>
      !customAnswerActive && progress.selectedOptionValues.includes(option.value ?? option.label),
  );
  const allowsCustomAnswer = activeQuestion?.allowCustomAnswer !== false;
  const canGoNext =
    !responseDisabled &&
    attachmentBlockReason === null &&
    (progress.isLastQuestion ? progress.isComplete : progress.canAdvance);

  if (
    optimisticSingleSelect &&
    activeQuestion &&
    !activeQuestion.multiSelect &&
    (optimisticSingleSelect.questionId !== activeQuestion.id ||
      (!customAnswerActive &&
        progress.selectedOptionValues.includes(optimisticSingleSelect.optionValue)))
  ) {
    setOptimisticSingleSelect(null);
  }
  if (advancingQuestionId !== null && advancingQuestionId !== activeQuestion?.id) {
    setAdvancingQuestionId(null);
  }

  const clearAutoAdvance = () => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
    setAdvancingQuestionId(null);
  };

  useEffect(() => {
    const cancel = () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
    };
    if (disabled || activeQuestion?.id === undefined) cancel();
    return cancel;
  }, [activeQuestion?.id, disabled]);

  const handleOptionSelection = (questionId: string, optionValue: string) => {
    if (responseDisabled) return;
    const typed = progress.customAnswer;
    if (typed.trim().length > 0) {
      setKeptCustomAnswers((existing) => ({ ...existing, [questionId]: typed }));
    }
    if (activeQuestion?.multiSelect) {
      onToggleOption(questionId, optionValue);
      return;
    }
    setOptimisticSingleSelect({ questionId, optionValue });
    onToggleOption(questionId, optionValue);
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
    // The last question waits for Submit so every answer can be reviewed first.
    if (progress.isLastQuestion) return;
    setAdvancingQuestionId(questionId);
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      advance();
    }, SINGLE_SELECT_ADVANCE_DELAY_MS);
  };

  const changeCustomAnswer = (value: string) => {
    if (!activeQuestion || responseDisabled) return;
    clearAutoAdvance();
    setKeptCustomAnswers((existing) => {
      if (!(activeQuestion.id in existing)) return existing;
      const next = { ...existing };
      delete next[activeQuestion.id];
      return next;
    });
    onChangeCustomAnswer(activeQuestion.id, value);
  };

  const goNext = () => {
    if (!canGoNext) return;
    clearAutoAdvance();
    onAdvance();
  };

  const selectQuestion = (index: number) => {
    if (index === progress.questionIndex) return;
    clearAutoAdvance();
    onSelectQuestion(index);
  };

  // Enter on an option or the custom answer moves on; buttons keep their own Enter.
  const handleCardKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest("[data-pending-user-input-enter]")) {
      return;
    }
    const multiline = target instanceof HTMLTextAreaElement;
    if (multiline !== (event.metaKey || event.ctrlKey)) return;
    // The card sits inside the composer form, so an unhandled Enter would send the message.
    event.preventDefault();
    goNext();
  };

  const selectOptionFromShortcut = useEffectEvent(handleOptionSelection);
  const focusCustomAnswerFromShortcut = useEffectEvent(() => {
    customAnswerInputRef.current?.focus();
  });
  const backgroundThread = use(BackgroundThreadContext);

  useEffect(() => {
    if (!activeQuestion || responseDisabled || backgroundThread) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex === activeQuestion.options.length && allowsCustomAnswer) {
        event.preventDefault();
        focusCustomAnswerFromShortcut();
        return;
      }
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOptionFromShortcut(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, allowsCustomAnswer, backgroundThread, responseDisabled]);

  if (!activeQuestion) {
    return null;
  }

  const highlightedStepIndex =
    advancingQuestionId === activeQuestion.id ? progress.questionIndex + 1 : progress.questionIndex;
  const optionRowClassName = (selected: boolean) =>
    cn(
      "group flex w-full items-start gap-2.5 rounded-md bg-transparent py-1.5 ps-2 text-left sm:ps-1.5 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
      selected ? "text-foreground" : "text-foreground/70 hover:bg-muted/30",
      responseDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
    );
  const customAnswerValue = customAnswerActive
    ? progress.customAnswer
    : (keptCustomAnswers[activeQuestion.id] ?? progress.customAnswer);
  const customAnswerIndex = activeQuestion.options.length;
  const customAnswerField = {
    ref: (node: HTMLInputElement | HTMLTextAreaElement | null) => {
      customAnswerInputRef.current = node;
    },
    value: customAnswerValue,
    disabled: responseDisabled,
    placeholder: "Something else…",
    "aria-label": "Something else",
    "data-pending-user-input-enter": true,
    onFocus: () => {
      const kept = keptCustomAnswers[activeQuestion.id];
      if (!customAnswerActive && kept) changeCustomAnswer(kept);
    },
    // Pasted files join the question's attachments, like the attach button.
    onPaste: (event: ReactClipboardEvent<HTMLElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) return;
      event.preventDefault();
      onPasteFiles(files);
    },
  };

  return (
    <div data-pending-user-input-card onKeyDown={handleCardKeyDown}>
      <ComposerBanner.Row className="px-4 pt-1.5">
        <ComposerBanner.Content>
          {prompt.questions.length > 1 ? (
            <span role="list" aria-label="Questions" className="flex min-w-0 flex-wrap gap-1">
              {prompt.questions.map((question, index) => {
                const answered =
                  resolvePendingUserInputAnswer(question, answers[question.id]) !== null;
                const current = index === highlightedStepIndex;
                return (
                  <span role="listitem" key={question.id}>
                    <Button
                      size="xs"
                      variant={current ? "secondary" : "ghost-muted"}
                      aria-current={current ? "step" : undefined}
                      aria-label={`${question.header}${answered ? ", answered" : ""}`}
                      disabled={isResponding}
                      data-pending-user-input-step={answered ? "answered" : "unanswered"}
                      onClick={() => selectQuestion(index)}
                    >
                      {answered ? <CheckIcon /> : null}
                      {question.header}
                    </Button>
                  </span>
                );
              })}
            </span>
          ) : (
            <span className="shrink-0 text-muted-foreground">{activeQuestion.header}</span>
          )}
        </ComposerBanner.Content>
        {prompt.dismissible ? (
          <ComposerBanner.Actions>
            <ComposerBanner.Dismiss
              aria-label="Dismiss question without answering"
              title="Dismiss question without answering"
              disabled={isResponding}
              data-pending-user-input-dismiss
              onClick={() => onDismiss(prompt.requestId)}
            />
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      <ComposerBanner.Scroll>
        <ComposerBanner.Body className="ps-6 pe-4 pb-1 wrap-anywhere sm:ps-5.5">
          <ChatMarkdown
            text={activeQuestion.question}
            cwd={cwd}
            threadRef={threadRef}
            className="pt-2 text-foreground/85"
          />
          {/* Rows span the header row's width so the radios align with the question text and the shortcut column sits under the dismiss button. */}
          <div className="-ms-2 mt-1.5 sm:-ms-1.5">
            {activeQuestion.options.map((option, index) => {
              const optionValue = option.value ?? option.label;
              const isOptimisticallySelected =
                optimisticSingleSelect?.questionId === activeQuestion.id &&
                optimisticSingleSelect.optionValue === optionValue;
              const isSelected = isOptimisticallySelected || draftSelectedOptions?.[index] === true;
              // The h-5 slots match the label's line box, so the indicator and shortcut stay on its first line.
              return (
                <button
                  key={`${activeQuestion.id}:${optionValue}`}
                  type="button"
                  aria-pressed={isSelected}
                  disabled={responseDisabled}
                  data-pending-user-input-enter
                  onClick={() => {
                    handleOptionSelection(activeQuestion.id, optionValue);
                  }}
                  className={optionRowClassName(isSelected)}
                >
                  <span className="pointer-events-none flex h-5 shrink-0 items-center">
                    {activeQuestion.multiSelect ? (
                      <CheckboxMark checked={isSelected} />
                    ) : (
                      <OptionRadio checked={isSelected} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{option.label}</span>
                    {option.description && option.description !== option.label ? (
                      <span className="text-secondary-label text-2xs">{option.description}</span>
                    ) : null}
                  </div>
                  {index < 9 ? (
                    <span className="flex h-5 w-7 shrink-0 items-center justify-center sm:w-6">
                      <Kbd>{index + 1}</Kbd>
                    </span>
                  ) : null}
                </button>
              );
            })}
            {allowsCustomAnswer ? (
              <label className={optionRowClassName(customAnswerActive)}>
                <span className="pointer-events-none flex h-7 shrink-0 items-center">
                  {activeQuestion.multiSelect ? (
                    <CheckboxMark checked={customAnswerActive} />
                  ) : (
                    <OptionRadio checked={customAnswerActive} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  {activeQuestion.initialAnswer !== undefined ? (
                    <Textarea
                      {...customAnswerField}
                      size="sm"
                      onChange={(event) => changeCustomAnswer(event.target.value)}
                    />
                  ) : (
                    <Input
                      {...customAnswerField}
                      size="sm"
                      nativeInput
                      onChange={(event) => changeCustomAnswer(event.target.value)}
                    />
                  )}
                </span>
                {customAnswerIndex < 9 ? (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center sm:w-6">
                    <Kbd>{customAnswerIndex + 1}</Kbd>
                  </span>
                ) : null}
              </label>
            ) : null}
          </div>
        </ComposerBanner.Body>
      </ComposerBanner.Scroll>
      <div className="flex items-center justify-end gap-2 ps-6 pe-4 pt-1.5 pb-1 sm:ps-5.5">
        {!canRespond ? (
          <span className="me-auto text-muted-foreground">
            The provider can no longer take this answer.
          </span>
        ) : attachmentBlockReason ? (
          <span className="me-auto min-w-0 truncate text-muted-foreground">
            {attachmentBlockReason}
          </span>
        ) : null}
        {progress.questionIndex > 0 ? (
          <Button
            size="xs"
            variant="outline"
            disabled={isResponding}
            onClick={() => selectQuestion(progress.questionIndex - 1)}
          >
            Back
          </Button>
        ) : null}
        <Button size="xs" disabled={!canGoNext} onClick={goNext}>
          {isResponding ? "Submitting…" : progress.isLastQuestion ? "Submit" : "Next"}
        </Button>
      </div>
    </div>
  );
});

// Drawn with ui/radio-group's look instead of using its Radio: Radio only checks inside a
// RadioGroup, whose arrow keys select options and would trip the single-select auto-advance.
function OptionRadio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-input bg-background not-dark:bg-clip-padding sm:size-4 dark:bg-input/32",
        checked ? "shadow-none" : "shadow-xs/5",
      )}
    >
      {checked ? (
        <span className="-inset-px absolute flex items-center justify-center rounded-full bg-primary before:size-2 before:rounded-full before:bg-primary-foreground sm:before:size-1.5" />
      ) : null}
    </span>
  );
}
