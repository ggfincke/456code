// tests/oxlint-plugin-456code/rules/no-manual-effect-runtime-in-tests.test.ts
// verify 456code/no manual effect runtime in tests behavior

import { assert, describe } from '@effect/vitest'

import { createOxlintRuleHarness } from '../../../oxlint-plugin-456code/test/utils.ts'

const rule = createOxlintRuleHarness('456code/no-manual-effect-runtime-in-tests', {
  filename: 'fixture.test.ts',
})

describe('456code/no-manual-effect-runtime-in-tests', () =>
{
  rule.valid(
    'allows @effect/vitest effect tests',
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.effect("runs an Effect", () => Effect.succeed("ok"));
    `,
  )

  // representative Effect.run* surfaces; full method list is owned by the lint rule itself.
  for (const method of ['runPromise', 'runSync', 'runFork'] as const)
  {
    rule.invalid(
      `reports Effect.${method}`,
      `
        import * as Effect from "effect/Effect";

        test("runs an Effect", () => {
          Effect.${method}(Effect.succeed("ok"));
        });
      `,
      (output) =>
      {
        assert.match(output, /Use @effect\/vitest with it\.effect/)
      },
    )
  }

  rule.invalid(
    'reports ManagedRuntime.make',
    `
      import * as Layer from "effect/Layer";
      import * as ManagedRuntime from "effect/ManagedRuntime";

      test("makes a runtime", () => {
        ManagedRuntime.make(Layer.empty);
      });
    `,
  )
})

const productionRule = createOxlintRuleHarness('456code/no-manual-effect-runtime-in-tests')

productionRule.valid(
  'allows production runtime boundaries',
  `
    import * as Effect from "effect/Effect";

    export const main = () => Effect.runPromise(Effect.void);
  `,
)
