// apps/web/src/components/chat/composer/CompactComposerControlsMenu.tsx
// renders compact composer mode, access, and plan controls
import { coerceRuntimeMode, type CollaborationMode, RuntimeMode } from '@t3tools/contracts'
import { memo, type ReactNode } from 'react'
import { EllipsisIcon, ListTodoIcon } from 'lucide-react'
import { Button } from '../../ui/button'
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from '../../ui/menu'

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean
  collaborationMode: CollaborationMode
  planSidebarLabel: string
  planSidebarOpen: boolean
  runtimeMode: RuntimeMode
  showOrchestrate: boolean
  showPlanMode: boolean
  supportedRuntimeModes: ReadonlyArray<RuntimeMode>
  traitsMenuContent?: ReactNode
  onInteractionModeChange: (mode: 'build' | 'plan') => void
  onOrchestrateChange: (enabled: boolean) => void
  onTogglePlanSidebar: () => void
  onRuntimeModeChange: (mode: RuntimeMode) => void
})
{
  const effectiveRuntimeMode = coerceRuntimeMode(props.runtimeMode, props.supportedRuntimeModes)

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showPlanMode || props.showOrchestrate ? (
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
        ) : null}
        {props.showPlanMode ? (
          <MenuRadioGroup
            value={props.collaborationMode.baseMode === 'default' ? 'build' : 'plan'}
            onValueChange={(value) =>
              {
              if (!value) return
              props.onInteractionModeChange(value as 'build' | 'plan')
            }}
          >
            <MenuRadioItem value="build">Build</MenuRadioItem>
            <MenuRadioItem value="plan">Plan</MenuRadioItem>
          </MenuRadioGroup>
        ) : null}
        {props.showOrchestrate ? (
          <MenuCheckboxItem
            variant="switch"
            checked={props.collaborationMode.orchestrate}
            onCheckedChange={(checked) => props.onOrchestrateChange(checked === true)}
          >
            Orchestrate
          </MenuCheckboxItem>
        ) : null}
        {props.showPlanMode || props.showOrchestrate ? <MenuDivider /> : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={effectiveRuntimeMode}
          onValueChange={(value) =>
          {
            if (!value || value === props.runtimeMode) return
            props.onRuntimeModeChange(value as RuntimeMode)
          }}
        >
          {props.supportedRuntimeModes.includes('approval-required') ? (
            <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
          ) : null}
          {props.supportedRuntimeModes.includes('auto-accept-edits') ? (
            <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
          ) : null}
          {props.supportedRuntimeModes.includes('auto') ? (
            <MenuRadioItem value="auto">Auto</MenuRadioItem>
          ) : null}
          {props.supportedRuntimeModes.includes('full-access') ? (
            <MenuRadioItem value="full-access">Full access</MenuRadioItem>
          ) : null}
        </MenuRadioGroup>
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  )
})
