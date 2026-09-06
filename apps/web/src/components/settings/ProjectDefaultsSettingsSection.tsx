// apps/web/src/components/settings/ProjectDefaultsSettingsSection.tsx
// edits primary-host project defaults and explicit project inheritance

import { useAtomValue } from '@effect/atom-react'
import { useId, useState } from 'react'
import type { ModelSelection, ProjectScript } from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'
import { resolveProjectScripts } from '@t3tools/shared/projectScripts'

import { usePrimarySettings, useUpdatePrimarySettings } from '../../hooks/useSettings'
import { randomUUID } from '../../lib/utils'
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from '../../modelSelection'
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from '../../providerInstances'
import { useProjects } from '../../state/entities'
import { usePrimaryEnvironment } from '../../state/environments'
import { projectEnvironment } from '../../state/projects'
import { primaryServerProvidersAtom } from '../../state/server'
import { useAtomCommand } from '../../state/use-atom-command'
import { ProviderModelPicker } from '../chat/model-picker/ProviderModelPicker'
import { Button } from '../ui/button'
import { DraftInput } from '../ui/draft-input'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { SettingsRow, SettingsSection } from './settingsLayout'

function DefaultModelControl({
  value,
  label,
  onChange,
}: {
  readonly value: ModelSelection | null
  readonly label: string
  readonly onChange: (selection: ModelSelection | null) => void
})
{
  const settings = usePrimarySettings()
  const providers = useAtomValue(primaryServerProvidersAtom)
  const fallback = resolveAppModelSelectionState(settings, providers)
  const selection = value ?? fallback
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  )
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  )
  return (
    <div className="flex flex-wrap items-center gap-2">
      {value !== null ? (
        <ProviderModelPicker
          activeInstanceId={selection.instanceId}
          model={selection.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={modelOptions}
          triggerVariant="outline"
          triggerAriaLabel={label}
          onInstanceModelChange={(instanceId, model) =>
            onChange(createModelSelection(instanceId, model))
          }
        />
      ) : (
        <span className="text-sm text-muted-foreground">Inherited</span>
      )}
      <Switch
        checked={value !== null}
        aria-label={`Use a separate ${label.toLowerCase()}`}
        onCheckedChange={(enabled) => onChange(enabled ? selection : null)}
      />
    </div>
  )
}

function DefaultScriptsEditor({
  scripts,
  onChange,
}: {
  readonly scripts: readonly ProjectScript[]
  readonly onChange: (scripts: readonly ProjectScript[]) => void
})
{
  const id = useId()
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  return (
    <div className="space-y-3 py-3">
      {scripts.map((script) => (
        <div key={script.id} className="space-y-2 rounded-lg border border-border/60 p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <DraftInput
              value={script.name}
              aria-label={`Name for ${script.name}`}
              onCommit={(name) =>
              {
                if (name.trim())
                  onChange(
                    scripts.map((entry) =>
                      entry.id === script.id ? { ...entry, name: name.trim() } : entry,
                    ),
                  )
              }}
            />
            <DraftInput
              value={script.command}
              aria-label={`Command for ${script.name}`}
              onCommit={(command) =>
              {
                if (command.trim())
                  onChange(
                    scripts.map((entry) =>
                      entry.id === script.id ? { ...entry, command: command.trim() } : entry,
                    ),
                  )
              }}
            />
            <Button
              variant="outline"
              size="sm"
              aria-label={`Remove ${script.name}`}
              onClick={() => onChange(scripts.filter((entry) => entry.id !== script.id))}
            >
              Remove
            </Button>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={script.runOnWorktreeCreate}
              aria-label={`Run ${script.name} when creating a worktree`}
              onCheckedChange={(checked) =>
                onChange(
                  scripts.map((entry) => ({
                    ...entry,
                    runOnWorktreeCreate:
                      entry.id === script.id
                        ? checked
                        : checked
                          ? false
                          : entry.runOnWorktreeCreate,
                  })),
                )
              }
            />
            Run when creating a worktree
          </label>
        </div>
      ))}
      {scripts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No shared scripts.</p>
      ) : null}
      <form
        className="grid items-end gap-2 sm:grid-cols-[1fr_2fr_auto]"
        onSubmit={(event) =>
        {
          event.preventDefault()
          if (!name.trim() || !command.trim()) return
          onChange([
            ...scripts,
            {
              id: randomUUID(),
              name: name.trim(),
              command: command.trim(),
              icon: 'play',
              runOnWorktreeCreate: false,
            },
          ])
          setName('')
          setCommand('')
        }}
      >
        <label htmlFor={`${id}-name`} className="space-y-1 text-xs text-muted-foreground">
          Script name
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Dev server"
          />
        </label>
        <label htmlFor={`${id}-command`} className="space-y-1 text-xs text-muted-foreground">
          Command
          <Input
            id={`${id}-command`}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="pnpm dev"
          />
        </label>
        <Button type="submit" variant="outline" disabled={!name.trim() || !command.trim()}>
          Add script
        </Button>
      </form>
    </div>
  )
}

export function ProjectDefaultsSettingsSection()
{
  const settings = usePrimarySettings()
  const updateSettings = useUpdatePrimarySettings()
  const primary = usePrimaryEnvironment()
  const projects = useProjects().filter(
    (project) => project.environmentId === primary?.environmentId,
  )
  const updateProject = useAtomCommand(projectEnvironment.update, 'project defaults update')
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const project = projects.find((candidate) => candidate.id === selectedProjectId)
  const selectClassName =
    'max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
  const browserOverride =
    project && Object.hasOwn(settings.projectAgentBrowserAccessOverrides, project.id)
      ? settings.projectAgentBrowserAccessOverrides[project.id]
      : undefined
  const scriptsOverride =
    project && Object.hasOwn(settings.projectScriptOverrides, project.id)
      ? settings.projectScriptOverrides[project.id]
      : undefined
  const inheritsScripts = project
    ? scriptsOverride === null || (scriptsOverride === undefined && project.scripts.length === 0)
    : true

  return (
    <SettingsSection id="settings-project-defaults" title="Project defaults">
      <fieldset disabled={primary === null} className="min-w-0">
        <SettingsRow
          title="Default task model"
          description="Used for new tasks when their project has no model override. Existing tasks keep their selected model."
          control={
            <DefaultModelControl
              label="Default task model"
              value={settings.defaultModelSelection}
              onChange={(defaultModelSelection) => updateSettings({ defaultModelSelection })}
            />
          }
        />
        <SettingsRow
          title="Agent browser access"
          description="Allow agents to use browser tools unless a project overrides this default."
          control={
            <Switch
              checked={settings.enableAgentBrowserAccess}
              aria-label="Default agent browser access"
              onCheckedChange={(enableAgentBrowserAccess) =>
                updateSettings({ enableAgentBrowserAccess })
              }
            />
          }
        />
        <SettingsRow
          title="Shared project scripts"
          description="Inherited by projects without scripts or with explicit inheritance. Saving does not run a script."
        >
          <DefaultScriptsEditor
            scripts={settings.defaultProjectScripts}
            onChange={(defaultProjectScripts) => updateSettings({ defaultProjectScripts })}
          />
        </SettingsRow>
        <SettingsRow
          title="Project overrides"
          description="Changes apply only to the selected project on the primary environment."
          control={
            <select className={selectClassName} aria-label="Project to customize" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)} disabled={primary === null}>
              <option value="">Choose a project</option>
              {projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
            </select>
          }
        />
        {project ? (
          <div key={`${project.environmentId}:${project.id}`}>
            <SettingsRow
              title={`${project.title}: task model`}
              description="Turn off the override to use the shared default for future tasks."
              control={
                <DefaultModelControl
                  label="Project task model"
                  value={project.defaultModelSelection}
                  onChange={(defaultModelSelection) =>
                    {
                    void updateProject({
                      environmentId: project.environmentId,
                      input: { projectId: project.id, defaultModelSelection },
                    })
                  }}
                />
              }
            />
            <SettingsRow
              title="Project browser access"
              description="Inherit the shared browser default, or choose a project-specific value."
              control={
                <select
                  className={selectClassName}
                  aria-label="Project agent browser access"
                  value={browserOverride === undefined ? 'inherit' : String(browserOverride)}
                  onChange={(event) =>
                    updateSettings({
                      projectAgentBrowserAccessOverrides: {
                        [project.id]:
                          event.target.value === 'inherit' ? null : event.target.value === 'true',
                      },
                    })
                  }
                >
                  <option value="inherit">Inherit default</option>
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              }
            />
            <SettingsRow
              title="Project scripts"
              description="Inheritance leaves stored project scripts intact. Custom scripts replace the effective shared list."
              control={
                <select
                  className={selectClassName}
                  aria-label="Project script inheritance"
                  value={inheritsScripts ? 'inherit' : 'custom'}
                  onChange={(event) =>
                    updateSettings({
                      projectScriptOverrides: {
                        [project.id]:
                          event.target.value === 'inherit'
                            ? null
                            : resolveProjectScripts(settings, project),
                      },
                    })
                  }
                >
                  <option value="inherit">Inherit shared scripts</option>
                  <option value="custom">Custom scripts</option>
                </select>
              }
            >
              {!inheritsScripts ? (
                <DefaultScriptsEditor
                  scripts={resolveProjectScripts(settings, project)}
                  onChange={(scripts) =>
                    updateSettings({ projectScriptOverrides: { [project.id]: scripts } })
                  }
                />
              ) : null}
            </SettingsRow>
          </div>
        ) : null}
      </fieldset>
    </SettingsSection>
  )
}
