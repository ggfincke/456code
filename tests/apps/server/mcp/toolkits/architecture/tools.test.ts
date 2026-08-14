// tests/apps/server/mcp/toolkits/architecture/tools.test.ts
// verifies architecture tool descriptors expose bounded inputs and typed failures

import { expect, it } from '@effect/vitest'
import {
  ARCHITECTURE_BLAST_TARGET_MAX_LENGTH,
  ARCHITECTURE_PATCH_MAX_OPS,
  ARCHITECTURE_PATCH_MAX_PATH_LENGTH,
} from '@t3tools/contracts'
import { Tool } from 'effect/unstable/ai'

import { ArchitectureToolkit } from '../../../../../../apps/server/src/mcp/toolkits/architecture/tools.ts'

const schemaHasDescription = (schema: unknown): boolean =>
{
  if (!schema || typeof schema !== 'object') return false
  const record = schema as Record<string, unknown>
  if (typeof record.description === 'string' && record.description.length > 0) return true
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription))
}

function schemaNodes(schema: unknown): ReadonlyArray<Record<string, unknown>>
{
  if (!schema || typeof schema !== 'object') return []
  const record = schema as Record<string, unknown>
  return [
    record,
    ...Object.values(record).flatMap((value) =>
      Array.isArray(value) ? value.flatMap(schemaNodes) : schemaNodes(value),
    ),
  ]
}

const expectedFields = {
  architecture_blast_radius: ['context', 'direction', 'maxDepth', 'target'],
  architecture_graph_diff: ['comparison'],
  architecture_propose_patch: ['context', 'ops'],
} as const

const forbiddenAuthorityFields = [
  'environmentId',
  'threadId',
  'projectId',
  'root',
  'graphPath',
  'contextId',
  'providerSessionId',
  'providerInstanceId',
  'activeTurnId',
] as const

it('exports three described object schemas without caller-supplied authority', () =>
{
  expect(Object.keys(ArchitectureToolkit.tools).sort()).toEqual(Object.keys(expectedFields).sort())

  for (const tool of Object.values(ArchitectureToolkit.tools))
  {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown
      readonly properties?: Readonly<Record<string, unknown>>
      readonly anyOf?: unknown
      readonly oneOf?: unknown
      readonly additionalProperties?: unknown
    }
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should explain its authority, bounds, and side effects`,
    ).toBeGreaterThan(100)
    expect(tool.failureMode, `${tool.name} must retain typed failures for MCP delivery`).toBe(
      'return',
    )
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe('object')
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined()
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined()
    expect(schema.additionalProperties, `${tool.name} must reject unknown fields`).toBe(false)
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      [...expectedFields[tool.name]].sort(),
    )

    for (const field of forbiddenAuthorityFields)
    {
      expect(
        schema.properties,
        `${tool.name} must derive ${field} from MCP authority`,
      ).not.toHaveProperty(field)
    }
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {}))
    {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass: ${JSON.stringify(fieldSchema)}`,
      ).toBe(true)
    }
  }

  const blastSchema = Tool.getJsonSchema(ArchitectureToolkit.tools.architecture_blast_radius) as {
    readonly properties?: Readonly<
      Record<string, { readonly allOf?: readonly Record<string, unknown>[] }>
    >
  }
  expect(blastSchema.properties?.target?.allOf).toContainEqual({ minLength: 1 })
  expect(blastSchema.properties?.target?.allOf).toContainEqual(
    expect.objectContaining({ maxLength: ARCHITECTURE_BLAST_TARGET_MAX_LENGTH }),
  )

  const inputSchemaNodes = Object.values(ArchitectureToolkit.tools).flatMap((tool) =>
    schemaNodes(Tool.getJsonSchema(tool)),
  )
  const objectSchemas = inputSchemaNodes.filter((schema) => schema.type === 'object')
  expect(objectSchemas.length).toBeGreaterThan(8)
  for (const schema of objectSchemas)
  {
    expect(schema.additionalProperties).toBe(false)
  }

  const proposePatchNodes = schemaNodes(
    Tool.getJsonSchema(ArchitectureToolkit.tools.architecture_propose_patch),
  )
  expect(proposePatchNodes).toContainEqual(
    expect.objectContaining({ maxItems: ARCHITECTURE_PATCH_MAX_OPS }),
  )
  expect(proposePatchNodes).toContainEqual(
    expect.objectContaining({ maxLength: ARCHITECTURE_PATCH_MAX_PATH_LENGTH }),
  )
})
