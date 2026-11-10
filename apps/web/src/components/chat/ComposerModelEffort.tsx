import { selectableProviderOptionChoices } from "@t3tools/client-runtime/model-traits";
import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";
import { ChevronUpIcon, WorkflowIcon } from "lucide-react";
import { useRef } from "react";

import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";
import { composerFloatingLayerProps, focusCheckedPermission } from "./composerEventScope";
import { FastBolt } from "./EffortGlyph";
import { type TraitsSelectionInput, useTraitsSelection } from "./TraitsPicker";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** Service tiers, Claude's Fast mode, and Ultracode sit in the footer, not the column. */
function splitSpeed(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const speedSelect = selects.find((descriptor) => descriptor.id === "serviceTier") ?? null;
  const fastToggle = toggles.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const ultracodeToggle = toggles.find((descriptor) => descriptor.id === "ultracode") ?? null;
  return {
    speedSelect,
    fastToggle,
    ultracodeToggle,
    columnSelects: selects.filter((descriptor) => descriptor !== speedSelect),
    columnToggles: toggles.filter(
      (descriptor) => descriptor !== fastToggle && descriptor !== ultracodeToggle,
    ),
  };
}

const FOOTER_SEGMENT =
  "flex h-6 cursor-pointer items-center justify-center gap-1 px-2 text-muted-foreground text-xs outline-none first:rounded-l-md last:rounded-r-md hover:text-foreground data-checked:bg-input/72 data-checked:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function SpeedSegment(props: {
  checked: boolean;
  label: string;
  description?: string | undefined;
  onPick: () => void;
}) {
  const buttonProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.checked,
    "data-checked": props.checked || undefined,
    className: FOOTER_SEGMENT,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      {props.label === "Fast" || props.label === "Ultrafast" ? (
        <FastBolt ultra={props.label === "Ultrafast"} />
      ) : null}
      {props.label}
    </>
  );
  if (!props.description) return <button {...buttonProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...buttonProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="top">{props.description}</TooltipPopup>
    </Tooltip>
  );
}

function SpeedControl(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { speedSelect, fastToggle } = splitSpeed(
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  if (traits.modelIsUnavailable || (!speedSelect && !fastToggle)) return null;
  return (
    <div
      role="radiogroup"
      aria-label={speedSelect?.label ?? fastToggle?.label}
      className="flex rounded-lg bg-input/40 p-0.5"
    >
      {speedSelect
        ? selectableProviderOptionChoices(speedSelect).map((option) => (
            <SpeedSegment
              key={option.id}
              checked={option.id === traits.selectValue(speedSelect)}
              label={option.label}
              description={option.description}
              onPick={() => traits.changeSelect(speedSelect, option.id)}
            />
          ))
        : fastToggle
          ? ([false, true] as const).map((value) => (
              <SpeedSegment
                key={String(value)}
                checked={(fastToggle.currentValue === true) === value}
                label={value ? "Fast" : "Standard"}
                onPick={() => traits.changeBoolean(fastToggle.id, value)}
              />
            ))
          : null}
    </div>
  );
}

function UltracodeControl(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { ultracodeToggle } = splitSpeed(traits.selectDescriptors, traits.booleanDescriptors);
  if (traits.modelIsUnavailable || !ultracodeToggle) return null;
  const on = ultracodeToggle.currentValue === true;
  return (
    <div className="flex rounded-lg bg-input/40 p-0.5">
      <button
        type="button"
        aria-pressed={on}
        data-checked={on || undefined}
        className={FOOTER_SEGMENT}
        onClick={() => traits.changeBoolean(ultracodeToggle.id, !on)}
      >
        <WorkflowIcon aria-hidden="true" className="size-3" />
        {ultracodeToggle.label}
      </button>
    </div>
  );
}

/** Permissions change rarely, so the footer names the mode and nests the choice in a menu. */
function PermissionsMenu(props: {
  runtimeMode: RuntimeMode;
  options: ReadonlyArray<RuntimeModeOption>;
  onChange: (mode: RuntimeMode) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = props.options.find((option) => option.mode === props.runtimeMode);
  if (!current) return null;
  const CurrentIcon = current.icon;
  return (
    <Menu
      onOpenChangeComplete={(open) => {
        if (open) focusCheckedPermission(triggerRef.current);
      }}
    >
      <MenuTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            data-composer-permissions-trigger
            aria-label={`Permissions: ${current.label}`}
            className="ms-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs outline-none hover:bg-foreground/[0.09] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-foreground/[0.09] data-popup-open:text-foreground"
          />
        }
      >
        <CurrentIcon aria-hidden="true" className="size-3.5" />
        {current.label}
        <ChevronUpIcon aria-hidden="true" className="size-3" />
      </MenuTrigger>
      <MenuPopup side="top" align="end" {...composerFloatingLayerProps}>
        <ComposerPermissionsSection
          runtimeMode={props.runtimeMode}
          runtimeModeOptions={props.options}
          onRuntimeModeChange={props.onChange}
        />
      </MenuPopup>
    </Menu>
  );
}

/** The model picker's footer: speed stays one click away, permissions sit one menu deeper. */
export function ComposerPickerFooter(props: {
  traits: TraitsSelectionInput | null;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/70 bg-muted/40 px-3 py-2">
      {props.traits ? <SpeedControl traits={props.traits} /> : null}
      {props.traits ? <UltracodeControl traits={props.traits} /> : null}
      <PermissionsMenu
        runtimeMode={props.runtimeMode}
        options={props.runtimeModeOptions}
        onChange={props.onRuntimeModeChange}
      />
    </div>
  );
}
