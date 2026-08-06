// oxlint-plugin-456code/rules/no-manual-effect-runtime-in-tests.ts
// implement repository no manual effect runtime in tests

import { defineRule } from '@oxlint/plugins'
import type { ESTree, Scope, Variable } from '@oxlint/plugins'
import * as Option from 'effect/Option'

import { getPropertyName, unwrapExpression } from '../utils.ts'

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u
const EFFECT_RUNTIME_METHODS = new Set([
  'runCallback',
  'runCallbackWith',
  'runFork',
  'runForkWith',
  'runPromise',
  'runPromiseExit',
  'runPromiseExitWith',
  'runPromiseWith',
  'runSync',
  'runSyncExit',
  'runSyncExitWith',
  'runSyncWith',
])

// existing manual runners are tracked as debt. The rule permits no net-new
// occurrences in these files, while unlisted test files must have zero.
const LEGACY_BASELINE = new Map<string, number>([
  ['tests/apps/mobile/features/agent-awareness/liveActivityPreferences.test.ts', 1],
  ['tests/apps/mobile/features/agent-awareness/remoteRegistration.test.ts', 2],
  ['tests/apps/mobile/state/use-remote-environment-registry.test.ts', 2],
  ['tests/apps/server/orchestration/commandInvariants.test.ts', 6],
  ['tests/apps/server/orchestration/Layers/CheckpointReactor.test.ts', 42],
  ['tests/apps/server/orchestration/Layers/OrchestrationEngine.test.ts', 5],
  ['tests/apps/server/orchestration/Layers/OrchestrationReactor.test.ts', 4],
  ['tests/apps/server/orchestration/Layers/ProviderCommandReactor.test.ts', 14],
  ['tests/apps/server/orchestration/Layers/ProviderRuntimeIngestion.test.ts', 31],
  ['tests/apps/server/orchestration/Layers/ThreadDeletionReactor.test.ts', 2],
  ['tests/apps/server/orchestration/projector.test.ts', 20],
  ['tests/apps/server/project/Layers/ProjectSetupScriptRunner.test.ts', 4],
  ['tests/apps/server/provider/acp/CursorAcpSupport.test.ts', 1],
  ['tests/apps/server/provider/Layers/ClaudeAdapter.test.ts', 2],
  ['tests/apps/server/provider/Layers/CodexAdapter.test.ts', 1],
  ['tests/apps/server/provider/Layers/CodexSessionRuntime.test.ts', 5],
  ['tests/apps/server/provider/Layers/CursorAdapter.test.ts', 1],
  ['tests/apps/server/provider/Layers/CursorProvider.test.ts', 4],
  ['tests/apps/server/provider/Layers/ProviderService.test.ts', 2],
  ['tests/apps/server/provider/Layers/ProviderSessionReaper.test.ts', 21],
  ['tests/apps/server/relay/AgentAwarenessRelay.test.ts', 4],
  ['tests/apps/server/server.test.ts', 1],
  ['tests/apps/web/cloud/dpop.test.ts', 2],
  ['tests/apps/web/environments/runtime/service.addSavedEnvironment.test.ts', 1],
  ['tests/oxlint-plugin-456code/rules/no-manual-effect-runtime-in-tests.test.ts', 7],
  ['tests/packages/client-runtime/relay/managedRelayState.test.ts', 1],
  ['tests/packages/client-runtime/wsTransport.test.ts', 2],
])

const baselineFor = (filename: string): number =>
{
  const normalized = filename.replaceAll('\\', '/')
  for (const [suffix, count] of LEGACY_BASELINE)
  {
    if (normalized.endsWith(suffix)) return count
  }
  return 0
}

const getLiteralStringValue = (node: unknown): Option.Option<string> =>
{
  if (typeof node !== 'object' || node === null) return Option.none()
  if (!('type' in node) || node.type !== 'Literal') return Option.none()
  if (!('value' in node) || typeof node.value !== 'string') return Option.none()
  return Option.some(node.value)
}

type RuntimeNamespace = 'Effect' | 'ManagedRuntime'

type RuntimeImportBinding =
  | { readonly kind: 'namespace'; readonly namespace: RuntimeNamespace }
  | { readonly kind: 'runner'; readonly runner: string }

type ImportSpecifier =
  ESTree.ImportDefaultSpecifier | ESTree.ImportNamespaceSpecifier | ESTree.ImportSpecifier

export default defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow manually creating or running Effect runtimes in tests; use @effect/vitest.',
    },
  },
  create(context)
  {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {}

    const allowedCount = baselineFor(context.filename)
    const runtimeImports = new Map<Variable, RuntimeImportBinding>()
    let occurrenceCount = 0

    const resolveVariable = (node: unknown): Option.Option<Variable> =>
    {
      const expression = unwrapExpression(node)
      if (Option.isNone(expression) || expression.value.type !== 'Identifier')
      {
        return Option.none()
      }

      const variableName = expression.value.name
      let scope: Scope | null = context.sourceCode.getScope(expression.value)
      while (scope !== null)
      {
        const variable = scope.set.get(variableName)
        if (variable !== undefined) return Option.some(variable)
        scope = scope.upper
      }
      return Option.none()
    }

    const resolveRuntimeImport = (node: unknown): Option.Option<RuntimeImportBinding> =>
      Option.flatMap(resolveVariable(node), (variable) =>
        Option.fromNullishOr(runtimeImports.get(variable)),
      )

    const declaredImportVariable = (specifier: ImportSpecifier): Option.Option<Variable> =>
    {
      const local = unwrapExpression(specifier.local)
      if (Option.isNone(local) || local.value.type !== 'Identifier') return Option.none()
      const localName = local.value.name

      return Option.fromNullishOr(
        context.sourceCode
          .getDeclaredVariables(specifier)
          .find((variable) => variable.name === localName),
      )
    }

    const registerImport = (specifier: ImportSpecifier, binding: RuntimeImportBinding) =>
    {
      const variable = declaredImportVariable(specifier)
      if (Option.isSome(variable)) runtimeImports.set(variable.value, binding)
    }

    const trackImportDeclaration = (node: ESTree.ImportDeclaration) =>
    {
      if (node.importKind === 'type') return

      const source = getLiteralStringValue(node.source)
      if (Option.isNone(source)) return

      for (const specifier of node.specifiers)
      {
        if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue

        if (source.value === 'effect')
        {
          if (specifier.type !== 'ImportSpecifier') continue
          const imported = getPropertyName(specifier.imported)
          if (Option.isNone(imported)) continue
          if (imported.value === 'Effect' || imported.value === 'ManagedRuntime')
          {
            registerImport(specifier, { kind: 'namespace', namespace: imported.value })
          }
          continue
        }

        if (source.value === 'effect/Effect')
        {
          if (specifier.type === 'ImportSpecifier')
          {
            const imported = getPropertyName(specifier.imported)
            if (Option.isSome(imported) && EFFECT_RUNTIME_METHODS.has(imported.value))
            {
              registerImport(specifier, {
                kind: 'runner',
                runner: `Effect.${imported.value}`,
              })
            }
          }
          else
          {
            registerImport(specifier, { kind: 'namespace', namespace: 'Effect' })
          }
          continue
        }

        if (source.value !== 'effect/ManagedRuntime') continue
        if (specifier.type === 'ImportSpecifier')
        {
          const imported = getPropertyName(specifier.imported)
          if (Option.isSome(imported) && imported.value === 'make')
          {
            registerImport(specifier, { kind: 'runner', runner: 'ManagedRuntime.make' })
          }
        }
        else
        {
          registerImport(specifier, { kind: 'namespace', namespace: 'ManagedRuntime' })
        }
      }
    }

    const manualRunnerName = (callee: unknown): Option.Option<string> =>
    {
      const expression = unwrapExpression(callee)
      if (Option.isNone(expression)) return Option.none()

      if (expression.value.type === 'Identifier')
      {
        return Option.flatMap(resolveRuntimeImport(expression.value), (binding) =>
          binding.kind === 'runner' ? Option.some(binding.runner) : Option.none(),
        )
      }

      if (expression.value.type !== 'MemberExpression') return Option.none()

      const binding = resolveRuntimeImport(expression.value.object)
      const property = getPropertyName(expression.value.property)
      if (Option.isNone(binding) || binding.value.kind !== 'namespace' || Option.isNone(property))
      {
        return Option.none()
      }

      if (binding.value.namespace === 'Effect' && EFFECT_RUNTIME_METHODS.has(property.value))
      {
        return Option.some(`Effect.${property.value}`)
      }
      if (binding.value.namespace === 'ManagedRuntime' && property.value === 'make')
      {
        return Option.some('ManagedRuntime.make')
      }
      return Option.none()
    }

    return {
      ImportDeclaration: trackImportDeclaration,
      CallExpression(node)
      {
        const runner = manualRunnerName(node.callee)
        if (Option.isNone(runner)) return

        occurrenceCount++
        if (occurrenceCount <= allowedCount) return

        context.report({
          node: node.callee,
          message: `Do not use ${runner.value} in tests. Use @effect/vitest with it.effect(...) and test layers instead.`,
        })
      },
    }
  },
})
