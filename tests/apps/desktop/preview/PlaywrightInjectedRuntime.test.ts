// tests/apps/desktop/preview/PlaywrightInjectedRuntime.test.ts
// verify playwright injected runtime behavior

import { it as effectIt } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { describe, expect } from 'vite-plus/test'

import {
  extractPlaywrightInjectedRuntimeSource,
  playwrightInjectedRuntimeInstallExpression,
  playwrightInjectedRuntimeSource,
} from '../../../../apps/desktop/src/preview/PlaywrightInjectedRuntime.ts'

const bundleWithSourceLiteral = (
  literal: string,
  moduleName = 'injectedScriptSource',
  symbol = 'source4',
): string => `var ${symbol};\nvar init_${moduleName} = __esm({
  "packages/playwright-core/src/generated/${moduleName}.ts"() {
    "use strict";
    ${symbol} = ${literal};\n  }\n});`

describe('playwright injected runtime', () =>
{
  effectIt.effect('extracts the pinned runtime from playwright-core', () =>
    Effect.gen(function* ()
    {
      const source = yield* playwrightInjectedRuntimeSource()
      expect(source.length).toBeGreaterThan(100_000)
      expect(source).toContain('InjectedScript')
      expect(source).toContain('parseSelector')
      expect(source).toContain('querySelector')
      expect(source).toContain('elementState')
    }),
  )

  effectIt.effect('selects the injected-script module after internal symbols are renumbered', () =>
    Effect.gen(function* ()
    {
      const expected = 'InjectedScript'.repeat(10_000)
      const bundle = [
        bundleWithSourceLiteral(`'${'utility'.repeat(20_000)}'`, 'utilityScriptSource', 'source3'),
        bundleWithSourceLiteral(`'${expected}'`, 'injectedScriptSource', 'source17'),
      ].join('\n')

      expect(yield* extractPlaywrightInjectedRuntimeSource(bundle, '/tmp/coreBundle.js')).toBe(
        expected,
      )
    }),
  )

  effectIt.effect('builds an idempotent install expression', () =>
    Effect.gen(function* ()
    {
      const expression = yield* playwrightInjectedRuntimeInstallExpression()
      expect(expression).toContain('__t3PlaywrightInjected')
      expect(expression).toContain('testIdAttributeName":"data-testid')
    }),
  )

  effectIt.effect('reports a missing source marker without an artificial cause', () =>
    Effect.gen(function* ()
    {
      const error = yield* Effect.flip(
        extractPlaywrightInjectedRuntimeSource(
          bundleWithSourceLiteral(
            `'${'utility'.repeat(20_000)}'`,
            'utilityScriptSource',
            'source3',
          ),
          '/tmp/coreBundle.js',
        ),
      )

      expect(error).toMatchObject({
        _tag: 'PlaywrightSourceMarkerNotFoundError',
        bundlePath: '/tmp/coreBundle.js',
        marker: '"packages/playwright-core/src/generated/injectedScriptSource.ts"() {',
      })
      expect('cause' in error).toBe(false)
    }),
  )

  effectIt.effect('keeps source validation metadata cause-free', () =>
    Effect.gen(function* ()
    {
      const error = yield* Effect.flip(
        extractPlaywrightInjectedRuntimeSource(
          bundleWithSourceLiteral('"short"'),
          '/tmp/coreBundle.js',
        ),
      )

      expect(error).toMatchObject({
        _tag: 'PlaywrightSourceValidationError',
        bundlePath: '/tmp/coreBundle.js',
        actualType: 'string',
        actualLength: 5,
        minimumLength: 100_000,
      })
      expect('cause' in error).toBe(false)
    }),
  )

  effectIt.effect('preserves the source evaluation cause', () =>
    Effect.gen(function* ()
    {
      const error = yield* Effect.flip(
        extractPlaywrightInjectedRuntimeSource(bundleWithSourceLiteral('('), '/tmp/coreBundle.js'),
      )

      expect(error).toMatchObject({
        _tag: 'PlaywrightSourceEvaluationError',
        bundlePath: '/tmp/coreBundle.js',
        timeoutMs: 1_000,
        cause: expect.objectContaining({ name: 'SyntaxError' }),
      })
    }),
  )
})
