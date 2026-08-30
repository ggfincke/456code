// tests/oxlint-plugin-456code/rules/no-mobile-uniwind-theme-escape-hatches.test.ts
// verify mobile semantic theme boundary linting

import { assert, describe } from '@effect/vitest'

import { createOxlintRuleHarness } from '../../../oxlint-plugin-456code/test/utils.ts'

const guardedMobileFile = createOxlintRuleHarness(
  '456code/no-mobile-uniwind-theme-escape-hatches',
  { filename: 'apps/mobile/src/features/settings/NewThemeSurface.tsx' },
)
const reviewedInteropFile = createOxlintRuleHarness(
  '456code/no-mobile-uniwind-theme-escape-hatches',
  { filename: 'apps/mobile/src/features/home/HomeHeader.tsx' },
)
const webFile = createOxlintRuleHarness('456code/no-mobile-uniwind-theme-escape-hatches', {
  filename: 'apps/web/src/ThemeSurface.tsx',
})

describe('456code/no-mobile-uniwind-theme-escape-hatches', () =>
{
  guardedMobileFile.valid(
    'allows semantic mobile theme classes',
    'const surface = <View className="bg-screen text-foreground" />',
  )

  guardedMobileFile.valid(
    'does not conflate shadowed Uniwind namespaces',
    `
      import * as Uniwind from 'uniwind'

      export function readDirect(Uniwind: { useCSSVariable: () => string }) {
        return Uniwind.useCSSVariable()
      }

      export function readDestructured(Uniwind: { useCSSVariable: () => string }) {
        const { useCSSVariable } = Uniwind
        return useCSSVariable()
      }
    `,
  )

  reviewedInteropFile.valid(
    'allows reviewed native interop boundaries',
    `
      import { useThemeColor } from '../../lib/useThemeColor'
      export const foreground = useThemeColor('--color-foreground')
    `,
  )

  webFile.valid(
    'does not impose mobile theme policy on web code',
    'const surface = <div className="bg-white dark:bg-black" />',
  )

  guardedMobileFile.invalid(
    'reports direct CSS variable subscriptions',
    `
      import { useCSSVariable } from 'uniwind'
      export const foreground = useCSSVariable('--color-foreground')
    `,
    (output) => assert.match(output, /generated native bridge/),
  )

  guardedMobileFile.invalid(
    'reports namespace CSS variable subscriptions',
    `
      import * as Uniwind from 'uniwind'
      export const foreground = Uniwind.useCSSVariable('--color-foreground')
    `,
    (output) => assert.match(output, /generated native bridge/),
  )

  guardedMobileFile.invalid(
    'reports destructured namespace CSS variable subscriptions',
    `
      import * as Uniwind from 'uniwind'

      const { useCSSVariable: resolveVariable } = Uniwind
      export const foreground = resolveVariable('--color-foreground')
    `,
    (output) => assert.match(output, /generated native bridge/),
  )

  guardedMobileFile.invalid(
    'reports aliased namespace CSS variable subscriptions',
    `
      import * as Uniwind from 'uniwind'

      const Theme = Uniwind
      const NestedTheme = Theme
      export const foreground = NestedTheme.useCSSVariable('--color-foreground')
    `,
    (output) => assert.match(output, /generated native bridge/),
  )

  guardedMobileFile.invalid(
    'reports object-rest namespace CSS variable subscriptions',
    `
      import * as Uniwind from 'uniwind'

      const { ...Theme } = Uniwind
      export const foreground = Theme.useCSSVariable('--color-foreground')
    `,
    (output) => assert.match(output, /generated native bridge/),
  )

  guardedMobileFile.invalid(
    'reports unreviewed theme color escape hatches',
    `
      import { useThemeColor } from '../../../lib/useThemeColor'
      export const foreground = useThemeColor('--color-foreground')
    `,
    (output) => assert.match(output, /native\/third-party boundary/),
  )

  guardedMobileFile.invalid(
    'reports unreviewed generated variable bridge imports',
    `
      import { useMobileThemeVariables } from '../../../lib/useMobileThemeVariables'
      export const variables = useMobileThemeVariables()
    `,
    (output) => assert.match(output, /native\/third-party boundary/),
  )

  guardedMobileFile.invalid(
    'reports appearance-specific Uniwind variants',
    'const surface = <View className="bg-white dark:bg-black" />',
    (output) => assert.match(output, /adaptive semantic token/),
  )
})
