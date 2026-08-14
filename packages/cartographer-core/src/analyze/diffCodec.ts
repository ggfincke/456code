// packages/cartographer-core/src/analyze/diffCodec.ts
// strictly decodes sealed structural graph-diff artifacts

import { z } from 'zod'

import type { GraphDiff } from './diff.js'

const EdgeEndpointsSchema = z
  .object({
    from: z.string(),
    to: z.string(),
  })
  .strict()

const MoveFlowSchema = EdgeEndpointsSchema.extend({
  count: z.number().int().nonnegative(),
}).strict()

const ExportChangeSchema = z
  .object({
    name: z.string(),
    typeOnly: z.boolean().optional(),
    brokenConsumers: z.array(z.string()).optional(),
  })
  .strict()

const FileApiChangeSchema = z
  .object({
    file: z.string(),
    addedExports: z.array(ExportChangeSchema),
    removedExports: z.array(ExportChangeSchema),
  })
  .strict()

const ViolationDeltaSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    rule: z.string(),
    severity: z.enum(['error', 'warn', 'info']),
  })
  .strict()

const GraphDiffSchema = z
  .object({
    baseGeneratedAt: z.string(),
    headGeneratedAt: z.string(),
    baseGitRef: z.string().optional(),
    headGitRef: z.string().optional(),
    addedNodes: z.array(z.string()),
    removedNodes: z.array(z.string()),
    addedEdges: z.array(EdgeEndpointsSchema),
    removedEdges: z.array(EdgeEndpointsSchema),
    movedNodes: z.array(EdgeEndpointsSchema),
    moveFlows: z.array(MoveFlowSchema),
    movedEdges: z.number().int().nonnegative(),
    apiChanges: z.array(FileApiChangeSchema),
    newViolations: z.array(ViolationDeltaSchema),
    resolvedViolations: z.array(ViolationDeltaSchema),
    changed: z.boolean(),
  })
  .strict()

export function parseGraphDiff(value: unknown): GraphDiff
{
  const parsed = GraphDiffSchema.parse(value)
  const apiChanges = parsed.apiChanges.map((change) => ({
    file: change.file,
    addedExports: change.addedExports.map((entry) => ({
      name: entry.name,
      ...(entry.typeOnly === undefined ? {} : { typeOnly: entry.typeOnly }),
      ...(entry.brokenConsumers === undefined ? {} : { brokenConsumers: entry.brokenConsumers }),
    })),
    removedExports: change.removedExports.map((entry) => ({
      name: entry.name,
      ...(entry.typeOnly === undefined ? {} : { typeOnly: entry.typeOnly }),
      ...(entry.brokenConsumers === undefined ? {} : { brokenConsumers: entry.brokenConsumers }),
    })),
  }))
  return {
    baseGeneratedAt: parsed.baseGeneratedAt,
    headGeneratedAt: parsed.headGeneratedAt,
    ...(parsed.baseGitRef === undefined ? {} : { baseGitRef: parsed.baseGitRef }),
    ...(parsed.headGitRef === undefined ? {} : { headGitRef: parsed.headGitRef }),
    addedNodes: parsed.addedNodes,
    removedNodes: parsed.removedNodes,
    addedEdges: parsed.addedEdges,
    removedEdges: parsed.removedEdges,
    movedNodes: parsed.movedNodes,
    moveFlows: parsed.moveFlows,
    movedEdges: parsed.movedEdges,
    apiChanges,
    newViolations: parsed.newViolations,
    resolvedViolations: parsed.resolvedViolations,
    changed: parsed.changed,
  }
}
