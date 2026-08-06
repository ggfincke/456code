// oxlint-plugin-456code/rules/no-global-process-runtime.ts
// coordinate no global process runtime

import { defineRule } from '@oxlint/plugins'
import type { ESTree, Scope, Variable } from '@oxlint/plugins'
import * as Option from 'effect/Option'

import { getPropertyName, isIdentifier, unwrapExpression } from '../utils.ts'

const RUNTIME_PROPERTIES = new Set(['platform', 'arch'])
const HOST_PROCESS_REFERENCE_FILE = 'packages/shared/src/hostProcess.ts'
const NODE_OS_MODULES = new Set(['node:os', 'os'])

const normalizePath = (path: string) => path.replaceAll('\\', '/')

const toRepoPath = (filename: string, cwd: string) =>
{
  const normalizedFilename = normalizePath(filename)
  const normalizedCwd = normalizePath(cwd).replace(/\/+$/u, '')
  const prefix = `${normalizedCwd}/`
  return normalizedFilename.startsWith(prefix)
    ? normalizedFilename.slice(prefix.length)
    : normalizedFilename
}

const isHostProcessReferenceFile = (filename: string, cwd: string) =>
  toRepoPath(filename, cwd) === HOST_PROCESS_REFERENCE_FILE

const message = (property: string) =>
  `Use HostProcess${property === 'arch' ? 'Architecture' : 'Platform'} instead of process.${property}; inject the runtime reference in Effect code and provide it explicitly in tests.`

const getLiteralStringValue = (node: unknown): Option.Option<string> =>
{
  if (typeof node !== 'object' || node === null) return Option.none()
  if (!('type' in node) || node.type !== 'Literal') return Option.none()
  if (!('value' in node) || typeof node.value !== 'string') return Option.none()
  return Option.some(node.value)
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow direct host runtime platform/architecture reads outside the shared host process references.',
    },
  },
  createOnce(context)
  {
    const nodeOsNamespaces = new Set<Variable>()
    const nodeOsRuntimeImports = new Map<Variable, string>()

    const resetBindings = () =>
    {
      nodeOsNamespaces.clear()
      nodeOsRuntimeImports.clear()
    }

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

    const isGlobalIdentifier = (node: unknown, name: string): boolean =>
    {
      const expression = unwrapExpression(node)
      if (!isIdentifier(expression, name) || Option.isNone(expression)) return false

      const variable = resolveVariable(expression.value)
      return Option.isNone(variable) || variable.value.defs.length === 0
    }

    const isGlobalProcessObject = (node: unknown): boolean =>
    {
      const expression = unwrapExpression(node)
      if (isGlobalIdentifier(node, 'process')) return true
      if (Option.isNone(expression) || expression.value.type !== 'MemberExpression') return false

      const property = getPropertyName(expression.value.property)
      return (
        isGlobalIdentifier(expression.value.object, 'globalThis') &&
        Option.isSome(property) &&
        property.value === 'process'
      )
    }

    const declaredImportVariable = (
      specifier:
        ESTree.ImportDefaultSpecifier | ESTree.ImportNamespaceSpecifier | ESTree.ImportSpecifier,
    ): Option.Option<Variable> =>
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

    const trackImportDeclaration = (node: ESTree.ImportDeclaration) =>
    {
      const source = getLiteralStringValue(node.source)
      if (Option.isNone(source) || !NODE_OS_MODULES.has(source.value)) return

      for (const specifier of node.specifiers)
      {
        const variable = declaredImportVariable(specifier)
        if (Option.isNone(variable)) continue

        if (
          specifier.type === 'ImportNamespaceSpecifier' ||
          specifier.type === 'ImportDefaultSpecifier'
        )
        {
          nodeOsNamespaces.add(variable.value)
          continue
        }

        if (specifier.type !== 'ImportSpecifier') continue

        const imported = getPropertyName(specifier.imported)
        if (Option.isSome(imported) && RUNTIME_PROPERTIES.has(imported.value))
        {
          nodeOsRuntimeImports.set(variable.value, imported.value)
        }
      }
    }

    const getNodeOsRuntimeImport = (callee: unknown): Option.Option<string> =>
    {
      const expression = unwrapExpression(callee)
      if (Option.isNone(expression) || expression.value.type !== 'Identifier')
      {
        return Option.none()
      }

      return Option.flatMap(resolveVariable(expression.value), (variable) =>
        Option.fromNullishOr(nodeOsRuntimeImports.get(variable)),
      )
    }

    const getNodeOsRuntimeMember = (node: unknown): Option.Option<string> =>
    {
      const expression = unwrapExpression(node)
      if (Option.isNone(expression) || expression.value.type !== 'MemberExpression')
      {
        return Option.none()
      }
      if (
        !Option.exists(resolveVariable(expression.value.object), (variable) =>
          nodeOsNamespaces.has(variable),
        )
      )
      {
        return Option.none()
      }
      return Option.filter(getPropertyName(expression.value.property), (property) =>
        RUNTIME_PROPERTIES.has(property),
      )
    }

    return {
      before: resetBindings,
      ImportDeclaration: trackImportDeclaration,
      MemberExpression(node)
      {
        if (isHostProcessReferenceFile(context.filename, context.cwd)) return

        const property = getPropertyName(node.property)
        if (Option.isNone(property) || !RUNTIME_PROPERTIES.has(property.value)) return
        if (!isGlobalProcessObject(node.object) && Option.isNone(getNodeOsRuntimeMember(node)))
        {
          return
        }

        context.report({
          node,
          message: message(property.value),
        })
      },
      CallExpression(node)
      {
        if (isHostProcessReferenceFile(context.filename, context.cwd)) return

        const property = getNodeOsRuntimeImport(node.callee)
        if (Option.isNone(property)) return

        context.report({
          node,
          message: message(property.value),
        })
      },
    }
  },
})
