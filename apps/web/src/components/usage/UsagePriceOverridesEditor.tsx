// apps/web/src/components/usage/UsagePriceOverridesEditor.tsx
// edit selected-environment model prices without replacing untouched rates

import { useMemo, useState, type FormEvent } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SettingResetButton, SettingsRow, SettingsSection } from '../settings/settingsLayout'
import {
  usagePriceCell,
  type UsagePriceEdits,
  type UsagePriceField,
  type UsagePriceTarget,
} from './usagePriceTargets'

const PRICE_FIELDS = [
  ['inputCostPerMillionTokens', 'Input'],
  ['outputCostPerMillionTokens', 'Output'],
  ['cacheReadCostPerMillionTokens', 'Cache read'],
  ['cacheWriteCostPerMillionTokens', 'Cache write'],
] as const satisfies readonly (readonly [UsagePriceField, string])[]

interface UsagePriceRowProps
{
  readonly model: string
  readonly targets: readonly UsagePriceTarget[]
  readonly saving: boolean
  readonly onUpdate: (model: string, edits: UsagePriceEdits | null) => Promise<boolean>
}

function UsagePriceRow({ model, targets, saving, onUpdate }: UsagePriceRowProps)
{
  const [edits, setEdits] = useState<UsagePriceEdits>({})
  const hasOverride = targets.some((target) => target.prices?.[model] !== undefined)
  const save = (event: FormEvent) =>
  {
    event.preventDefault()
    if (saving || Object.keys(edits).length === 0) return
    const submitted = edits
    void onUpdate(model, submitted).then((saved) =>
    {
      if (saved) setEdits((current) => (current === submitted ? {} : current))
    })
  }
  return (
    <SettingsRow
      title={model}
      description="USD per million tokens. Only edited fields change; blank cache rates use each environment's input rate."
      status={
        targets.length === 0
          ? 'Select an environment to edit prices'
          : `Editing ${targets.length} selected environment${targets.length === 1 ? '' : 's'}`
      }
      resetAction={
        hasOverride ? (
          <SettingResetButton
            label={`${model} pricing on selected environments`}
            onClick={() =>
              {
              if (!saving) void onUpdate(model, null)
            }}
          />
        ) : undefined
      }
    >
      <form className="grid gap-2 pt-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={save}>
        {PRICE_FIELDS.map(([field, label]) =>
        {
          const cell = usagePriceCell(targets, model, field)
          return (
            <Input
              key={field}
              nativeInput
              type="number"
              min="0"
              step="any"
              aria-label={`${model} ${label.toLowerCase()} price per million tokens`}
              placeholder={cell.mixed ? 'Mixed' : label}
              value={edits[field] ?? cell.value}
              disabled={saving || targets.length === 0}
              onChange={(event) =>
                setEdits((current) => ({ ...current, [field]: event.target.value }))
              }
            />
          )
        })}
        <Button
          type="submit"
          variant="outline"
          disabled={saving || targets.length === 0 || Object.keys(edits).length === 0}
        >
          Save rate
        </Button>
      </form>
    </SettingsRow>
  )
}

export interface UsagePriceOverridesEditorProps
{
  readonly models: readonly string[]
  readonly targets: readonly UsagePriceTarget[]
  readonly saving: boolean
  readonly onUpdate: UsagePriceRowProps['onUpdate']
}

export function UsagePriceOverridesEditor({
  models,
  targets,
  saving,
  onUpdate,
}: UsagePriceOverridesEditorProps)
{
  const allModels = useMemo(
    () =>
      [
        ...new Set([...models, ...targets.flatMap((target) => Object.keys(target.prices ?? {}))]),
      ].sort((left, right) => left.localeCompare(right)),
    [models, targets],
  )
  const targetKey = targets.map((target) => target.environmentId).join(':')
  return (
    <SettingsSection id="usage-model-pricing" title="Model pricing">
      {allModels.length === 0 ? (
        <SettingsRow
          title="No transcript models found"
          description="Run Claude or Codex once, then refresh Usage to add an exact-model price."
        />
      ) : (
        allModels.map((model) => (
          <UsagePriceRow
            key={`${targetKey}:${model}`}
            model={model}
            targets={targets}
            saving={saving}
            onUpdate={onUpdate}
          />
        ))
      )}
    </SettingsSection>
  )
}
