// apps/web/src/components/chat/composer/ComposerFooterModeControls.tsx
// renders composer runtime-mode and interaction-mode footer controls

import type { CollaborationMode, RuntimeMode } from '@t3tools/contracts'
import { memo } from 'react'
import {
  BotIcon,
  ListTodoIcon,
  type LucideIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  PencilRulerIcon,
  SparklesIcon,
  WorkflowIcon,
} from 'lucide-react'
import { cn } from '~/lib/utils'
import { Button } from '../../ui/button'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../../ui/select'
import { Separator } from '../../ui/separator'
import { Toggle } from '../../ui/toggle'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../../ui/tooltip'

const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  'approval-required': {
    label: 'Supervised',
    description: 'Ask before commands and file changes.',
    icon: LockIcon,
  },
  'auto-accept-edits': {
    label: 'Auto-accept edits',
    description: 'Auto-approve edits, ask before other actions.',
    icon: PenLineIcon,
  },
  auto: {
    label: 'Auto',
    description: 'An AI reviewer approves routine actions; risky ones still ask.',
    icon: SparklesIcon,
  },
  'full-access': {
    label: 'Full access',
    description: 'Allow commands and edits without prompts.',
    icon: LockOpenIcon,
  },
}

const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[]

export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showPlanMode: boolean
  collaborationMode: CollaborationMode
  runtimeMode: RuntimeMode
  showPlanToggle: boolean
  planSidebarLabel: string
  planSidebarOpen: boolean
  onInteractionModeChange: (mode: 'build' | 'plan') => void
  onOrchestrateChange: (enabled: boolean) => void
  onRuntimeModeChange: (mode: RuntimeMode) => void
  onTogglePlanSidebar: () => void
})
{
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode]
  const RuntimeModeIcon = runtimeModeOption.icon
  const effectiveMode = props.collaborationMode.baseMode === 'default' ? 'build' : 'plan'
  const interactionModeTooltip =
    effectiveMode === 'plan'
      ? 'Plan mode — explore and propose changes before building'
      : 'Build mode — make changes directly'
  const InteractionModeIcon = effectiveMode === 'plan' ? PencilRulerIcon : BotIcon
  const orchestrateTooltip = props.collaborationMode.orchestrate
    ? 'Disable Orchestrate — stop coordinating work through the worker broker'
    : 'Enable Orchestrate — coordinate bounded work through the worker broker'
  const planSidebarTooltip = props.planSidebarOpen
    ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
    : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`

  const interactionModeToggle = (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Tooltip>
        <Select
          value={effectiveMode}
          onValueChange={(value) => props.onInteractionModeChange(value! as 'build' | 'plan')}
        >
          <TooltipTrigger
            render={
              <SelectTrigger
                variant="ghost"
                size="sm"
                className={cn(
                  'shrink-0 whitespace-nowrap px-2 sm:px-3',
                  effectiveMode !== 'build'
                    ? 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300'
                    : 'text-muted-foreground/70 hover:text-foreground/80',
                )}
                aria-label={interactionModeTooltip}
              />
            }
          >
            <InteractionModeIcon className="size-4" />
            <SelectValue>{effectiveMode === 'plan' ? 'Plan' : 'Build'}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false} popupClassName="min-w-40">
            {/* item text is one block, and preflight makes svg display:block, so
                each label needs its own flex row to sit beside its icon */}
            <SelectItem value="build" hideIndicator>
              <span className="flex items-center gap-2 whitespace-nowrap">
                <BotIcon className="size-3.5" />
                Build
              </span>
            </SelectItem>
            {props.showPlanMode ? (
              <SelectItem value="plan" hideIndicator>
                <span className="flex items-center gap-2 whitespace-nowrap">
                  <PencilRulerIcon className="size-3.5" />
                  Plan
                </span>
              </SelectItem>
            ) : null}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              variant="ghost"
              size="sm"
              className={cn(
                'shrink-0 px-2 sm:px-3',
                props.collaborationMode.orchestrate
                  ? 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300'
                  : 'text-muted-foreground/70 hover:text-foreground/80',
              )}
              aria-label={orchestrateTooltip}
              pressed={props.collaborationMode.orchestrate}
              onPressedChange={props.onOrchestrateChange}
            >
              <WorkflowIcon className="size-4" />
              <span className="sr-only sm:not-sr-only">Orchestrate</span>
            </Toggle>
          }
        />
        <TooltipPopup side="top">{orchestrateTooltip}</TooltipPopup>
      </Tooltip>
    </>
  )

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      <Tooltip>
        <Select
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value!)}
        >
          <TooltipTrigger
            render={
              <SelectTrigger
                variant="ghost"
                size="sm"
                className="font-medium"
                aria-label="Runtime mode"
              />
            }
          >
            <RuntimeModeIcon className="size-4" />
            <SelectValue>{runtimeModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {runtimeModeOptions.map((mode) =>
            {
              const option = runtimeModeConfig[mode]
              const OptionIcon = option.icon
              return (
                <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {option.description}
                      </span>
                    </div>
                  </div>
                </SelectItem>
              )
            })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{runtimeModeOption.description}</TooltipPopup>
      </Tooltip>

      {interactionModeToggle}

      {props.showPlanToggle ? (
        <>
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  className={cn(
                    'shrink-0 whitespace-nowrap px-2 sm:px-3',
                    props.planSidebarOpen
                      ? 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300'
                      : 'text-muted-foreground/70 hover:text-foreground/80',
                  )}
                  size="sm"
                  type="button"
                  onClick={props.onTogglePlanSidebar}
                  aria-label={planSidebarTooltip}
                />
              }
            >
              <ListTodoIcon
                className={props.planSidebarOpen ? 'text-current opacity-100' : undefined}
              />
              <span className="sr-only sm:not-sr-only">{props.planSidebarLabel}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{planSidebarTooltip}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
    </>
  )
})
