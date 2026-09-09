// apps/web/src/components/usage/usagePriceTargets.ts
// preserve target-local rates while selected environments settle price writes independently

import type {
  EnvironmentId,
  ServerSettingsPatch,
  UsageModelPriceOverride,
} from '@t3tools/contracts'

export type UsagePriceField = keyof UsageModelPriceOverride
export type UsagePriceEdits = Partial<Record<UsagePriceField, string>>
export interface UsagePriceTarget
{
  readonly environmentId: EnvironmentId
  readonly label: string
  readonly prices: Readonly<Record<string, UsageModelPriceOverride>> | null
  readonly unavailable: string | null
}

export function usagePriceCell(
  targets: readonly UsagePriceTarget[],
  model: string,
  field: UsagePriceField,
)
{
  const values = targets.map((target) => target.prices?.[model]?.[field]?.toString() ?? '')
  const mixed = values.some((value) => value !== values[0])
  return { value: mixed ? '' : (values[0] ?? ''), mixed }
}

export async function writeUsagePrice(input: {
  readonly targets: readonly UsagePriceTarget[]
  readonly model: string
  readonly edits: UsagePriceEdits | null
  readonly write: (target: {
    environmentId: EnvironmentId
    input: { patch: ServerSettingsPatch }
  }) => Promise<{ readonly _tag: 'Success' | 'Failure' }>
  readonly onResult: (environmentId: EnvironmentId, error: string | null) => void
})
{
  await Promise.all(
    input.targets.map(async (target) =>
    {
      if (target.unavailable || target.prices === null)
      {
        input.onResult(target.environmentId, target.unavailable ?? 'Prices are unavailable.')
        return
      }
      const price: { -readonly [Key in UsagePriceField]?: UsageModelPriceOverride[Key] } = {
        ...target.prices[input.model],
      }
      if (input.edits !== null)
      {
        for (const [field, value] of Object.entries(input.edits) as [UsagePriceField, string][])
        {
          if (value.trim() === '') delete price[field]
          else price[field] = Number(value)
        }
        if (
          price.inputCostPerMillionTokens === undefined ||
          price.outputCostPerMillionTokens === undefined ||
          Object.values(price).some((value) => !Number.isFinite(value) || value < 0)
        )
        {
          input.onResult(
            target.environmentId,
            'Input and output prices must be non-negative numbers on this environment.',
          )
          return
        }
      }
      try
      {
        const result = await input.write({
          environmentId: target.environmentId,
          input: {
            patch: {
              usagePriceOverrides: {
                [input.model]: input.edits === null ? null : (price as UsageModelPriceOverride),
              },
            },
          },
        })
        input.onResult(
          target.environmentId,
          result._tag === 'Success' ? null : 'Could not save. Try again.',
        )
      }
      catch
      {
        input.onResult(target.environmentId, 'Could not save. Try again.')
      }
    }),
  )
}
