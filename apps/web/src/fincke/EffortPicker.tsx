// apps/web/src/fincke/EffortPicker.tsx
// composer effort chip whose popover is a level slider with fast mode & the remaining model options
import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getTraitSelectChange,
  REASONING_SELECT_DESCRIPTOR_IDS,
  replaceDescriptorCurrentValue,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import type { ProviderOptionDescriptor, ProviderOptionSelection } from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import { BrainIcon, GaugeIcon, RotateCcwIcon, SparklesIcon, ZapIcon } from "lucide-react";
import { type ComponentProps, memo, type ReactNode, useRef, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
} from "../components/chat/ComposerControl";
import { useComposerMenuProps } from "../components/chat/composerEventScope";
import { getTraitsSectionVisibility, TraitsPicker } from "../components/chat/TraitsPicker";
import { useComposerMenuState } from "../components/chat/useComposerMenuState";
import { UltrafastIcon } from "../components/Icons";
import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { type EffortLevel, EffortSlider } from "./EffortSlider";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

const ULTRA_LEVEL_IDS: ReadonlySet<string> = new Set(["ultra", "ultracode", "ultrathink"]);

// codex exposes speed as a service tier select; the bolt toggles standard <-> its fast tier
function codexSpeedTier(descriptor: SelectDescriptor | undefined) {
  if (!descriptor) return null;
  const fast =
    descriptor.options.find(({ label }) => label === "Fast") ??
    descriptor.options.find(({ label }) => label === "Ultrafast");
  const standard =
    descriptor.options.find(({ id }) => id === "default") ??
    descriptor.options.find(({ id }) => id !== fast?.id);
  return fast && standard ? { fast, standard } : null;
}

/**
 * Owned replacement for the composer's TraitsPicker (components/chat/TraitsPicker.tsx).
 * Models without a reasoning level, or whose catalog entry is missing, fall back to it.
 */
export const EffortPicker = memo(function EffortPicker(props: ComponentProps<typeof TraitsPicker>) {
  const {
    provider,
    instanceId,
    models,
    model,
    promptUltrathink,
    onPromptEdit,
    modelOptions,
    reportedModelSelection,
    allowPromptInjectedEffort = true,
    planModeEnabled,
    triggerClassName,
    isComposerOwned,
    size = "sm",
    hidden = false,
    disabled = false,
  } = props;
  const composerMenuProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(hidden || disabled);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);

  const selected = getTraitsSectionVisibility({
    provider,
    models,
    model,
    promptUltrathink,
    modelOptions,
    allowPromptInjectedEffort,
    planModeEnabled,
  });
  const reasoning = selected.selectDescriptors.find((descriptor) =>
    REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id),
  );
  if (!selected.hasAnyControls) return null;
  if (selected.modelIsUnavailable || !reasoning || reasoning.options.length < 2) {
    return <TraitsPicker {...props} />;
  }

  const modelSelection =
    instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null;

  // same persistence path as TraitsMenuContent
  const updateModelOptions = (nextOptions: ReadonlyArray<ProviderOptionSelection> | undefined) => {
    if ("onModelOptionsChange" in props) {
      props.onModelOptionsChange(nextOptions);
      return;
    }
    const threadTarget = props.threadRef ?? ("draftId" in props ? props.draftId : undefined);
    if (!threadTarget) return;
    setProviderModelOptions(threadTarget, provider, nextOptions, {
      ...(instanceId ? { instanceId } : {}),
      model,
      persistSticky: true,
    });
  };
  const selectValue = (descriptor: SelectDescriptor, value: string) => {
    // whether a pick applies, and the options it writes, do not depend on the prompt text
    const change = getTraitSelectChange(selected, descriptor, "", value);
    if (!change) return;
    onPromptEdit?.(
      (prompt) => getTraitSelectChange(selected, descriptor, prompt, value)?.prompt ?? prompt,
    );
    if ("modelOptions" in change) updateModelOptions(change.modelOptions);
  };
  const setBoolean = (descriptor: BooleanDescriptor, value: boolean) => {
    updateModelOptions(
      buildProviderOptionSelectionsFromDescriptors(
        replaceDescriptorCurrentValue(selected.descriptors, descriptor.id, value),
      ),
    );
  };

  const isPrimary = reasoning.id === selected.primarySelectDescriptor?.id;
  const levelLocked = isPrimary && selected.ultrathinkInBodyText;
  const levels: ReadonlyArray<EffortLevel> = selectableProviderOptionChoices(reasoning).map(
    (option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      isDefault: option.isDefault,
      ultra: ULTRA_LEVEL_IDS.has(option.id),
    }),
  );
  const currentValue =
    isPrimary && selected.ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(reasoning, modelSelection, reportedModelSelection);
  const defaultIndex = Math.max(
    0,
    levels.findIndex((level) => level.isDefault),
  );
  const currentIndex = levels.findIndex((level) => level.id === currentValue);
  // a reported value outside the catalog sits on the default stop
  const levelIndex = currentIndex >= 0 ? currentIndex : defaultIndex;
  const level = levels[levelIndex];
  const shownLevel = levels[previewIndex ?? levelIndex] ?? level;

  const fastMode = selected.fastModeDescriptor;
  const serviceTier =
    provider === "codex"
      ? selected.selectDescriptors.find((descriptor) => descriptor.id === "serviceTier")
      : undefined;
  const speedTier = codexSpeedTier(serviceTier);
  const serviceTierValue = serviceTier ? getDescriptorStringValue(serviceTier) : null;
  // codex names its speed tiers by label, the same way buildTraitsTriggerDisplay reads them
  const serviceTierLabel = serviceTier?.options.find(({ id }) => id === serviceTierValue)?.label;
  const ultrafastOn = fastMode === null && serviceTierLabel === "Ultrafast";
  const fastOn = fastMode
    ? fastMode.currentValue === true
    : speedTier !== null && (serviceTierLabel === "Fast" || ultrafastOn);
  const toggleFast =
    fastMode !== null
      ? () => setBoolean(fastMode, !fastOn)
      : speedTier && serviceTier
        ? () => selectValue(serviceTier, fastOn ? speedTier.standard.id : speedTier.fast.id)
        : null;

  // everything the old menu offered beyond the level & the bolt stays reachable as rows
  const selectRows = selected.selectDescriptors.filter(
    (descriptor) =>
      descriptor.id !== reasoning.id &&
      !(descriptor === serviceTier && speedTier !== null && descriptor.options.length <= 2),
  );
  const booleanRows = selected.booleanDescriptors.filter(
    (descriptor) => descriptor.id !== "fastMode",
  );

  const { label: triggerLabel } = buildTraitsTriggerDisplay({
    provider,
    descriptors: selected.descriptors,
    primarySelectDescriptorId: selected.primarySelectDescriptor?.id ?? null,
    ultrathinkPromptControlled: selected.ultrathinkPromptControlled,
    modelSelection,
    reportedModelSelection,
  });
  const modelName =
    models.find((candidate) => candidate.slug === normalizeModelSlug(model, provider))?.name ??
    model;
  const isCodexStyle = provider === "codex";
  const chipUltra = level?.ultra === true;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next && !disabled);
        if (!next) setPreviewIndex(null);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  disabled={disabled}
                  aria-label={triggerLabel}
                  data-composer-shortcut={isComposerOwned ? "composer.effort" : undefined}
                  data-effort-ultra={chipUltra ? "" : undefined}
                  size={size}
                  className={cn(
                    isCodexStyle
                      ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48"
                      : "shrink-0 whitespace-nowrap",
                    triggerClassName,
                  )}
                />
              }
            />
          }
        >
          <span className={cn("flex min-w-0 items-center", size === "xs" ? "gap-1" : "gap-1.5")}>
            {fastOn ? (
              <ComposerControlIcon
                icon={ultrafastOn ? UltrafastIcon : ZapIcon}
                size={size}
                className="fill-current text-(--fincke-yellow,var(--warning))"
              />
            ) : null}
            {/* the redesign swaps TraitsPicker's brain for a gauge; ultra keeps its sparkle */}
            {chipUltra ? (
              <ComposerControlIcon icon={SparklesIcon} size={size} className="text-current" />
            ) : (
              <>
                <ComposerControlIcon icon={BrainIcon} size={size} className="redesign:hidden" />
                <ComposerControlIcon
                  icon={GaugeIcon}
                  size={size}
                  className="hidden redesign:block"
                />
              </>
            )}
            <span data-composer-control-label className="min-w-0 truncate">
              {level?.label ?? triggerLabel}
            </span>
            <ComposerControlChevron size={size} />
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        {...(isComposerOwned ? composerMenuProps : {})}
        side="top"
        align="start"
        width="md"
        padding="compact"
        initialFocus={levelLocked ? true : trackRef}
      >
        <div data-slot="effort-panel" className="flex flex-col gap-3 py-1">
          <div className="flex items-center gap-2">
            {toggleFast ? (
              <button
                type="button"
                data-slot="effort-fast"
                aria-pressed={fastOn}
                aria-label="Fast mode"
                onClick={toggleFast}
              >
                <ZapIcon aria-hidden="true" className="size-4" />
              </button>
            ) : (
              <span aria-hidden="true" className="size-7 shrink-0" />
            )}
            <div className="min-w-0 flex-1 text-center leading-tight">
              <div
                data-slot="effort-level"
                className="truncate font-semibold"
                data-ultra={shownLevel?.ultra ? "" : undefined}
                data-preview={previewIndex !== null && previewIndex !== levelIndex ? "" : undefined}
              >
                {shownLevel?.label}
              </div>
              <div className="truncate text-muted-foreground text-xs">{modelName}</div>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label="Reset to default"
                    disabled={levelLocked || levelIndex === defaultIndex}
                    onClick={() => {
                      const defaultLevel = levels[defaultIndex];
                      if (defaultLevel) selectValue(reasoning, defaultLevel.id);
                    }}
                  />
                }
              >
                <RotateCcwIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Reset to default</TooltipPopup>
            </Tooltip>
          </div>
          <EffortSlider
            key={`${instanceId ?? provider}:${model}:${reasoning.id}`}
            levels={levels}
            index={levelIndex}
            label={reasoning.label}
            disabled={levelLocked}
            trackRef={trackRef}
            onCommit={(index) => {
              const next = levels[index];
              if (next) selectValue(reasoning, next.id);
            }}
            onPreviewChange={setPreviewIndex}
          />
          {levelLocked ? (
            <p className="text-center text-muted-foreground text-xs">
              Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
              option.
            </p>
          ) : levels.some((option) => option.description) ? (
            <p data-slot="effort-description" data-ultra={shownLevel?.ultra ? "" : undefined}>
              {shownLevel?.description}
            </p>
          ) : null}
          {selectRows.length > 0 || booleanRows.length > 0 ? (
            <div className="flex flex-col gap-1.5 border-t pt-2.5">
              {selectRows.map((descriptor) => (
                <OptionRow key={descriptor.id} label={descriptor.label}>
                  <SelectOptionControl
                    descriptor={descriptor}
                    value={getDescriptorStringValue(
                      descriptor,
                      modelSelection,
                      reportedModelSelection,
                    )}
                    onChange={(value) => selectValue(descriptor, value)}
                  />
                </OptionRow>
              ))}
              {booleanRows.map((descriptor) => (
                <OptionRow key={descriptor.id} label={descriptor.label}>
                  <ToggleGroup
                    aria-label={descriptor.label}
                    value={[descriptor.currentValue === true ? "on" : "off"]}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (next !== undefined) setBoolean(descriptor, next === "on");
                    }}
                  >
                    <Toggle value="on">On</Toggle>
                    <Toggle value="off">Off</Toggle>
                  </ToggleGroup>
                </OptionRow>
              ))}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});

function OptionRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <span className="min-w-0 truncate text-muted-foreground text-xs">{props.label}</span>
      {props.children}
    </div>
  );
}

// short choices read best as segments; longer lists (agents, many tiers) collapse to a select
function SelectOptionControl(props: {
  descriptor: SelectDescriptor;
  value: string | null;
  onChange: (value: string) => void;
}) {
  const options = selectableProviderOptionChoices(props.descriptor);
  if (options.length <= 3) {
    return (
      <ToggleGroup
        aria-label={props.descriptor.label}
        value={props.value === null ? [] : [props.value]}
        onValueChange={(values) => {
          const next = values[0];
          if (next !== undefined) props.onChange(next);
        }}
      >
        {options.map((option) => (
          <Tooltip key={option.id}>
            <TooltipTrigger render={<Toggle value={option.id} />}>{option.label}</TooltipTrigger>
            {option.description ? (
              <TooltipPopup side="top">{option.description}</TooltipPopup>
            ) : null}
          </Tooltip>
        ))}
      </ToggleGroup>
    );
  }
  const current = options.find((option) => option.id === props.value);
  return (
    <div className="w-40 shrink-0">
      <Select
        value={props.value ?? ""}
        onValueChange={(value) => {
          if (typeof value === "string" && value.length > 0) props.onChange(value);
        }}
      >
        <SelectTrigger size="xs" aria-label={props.descriptor.label}>
          <SelectValue>{current?.label ?? props.value ?? ""}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
