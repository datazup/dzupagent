/**
 * Pipeline serialization — Zod schemas + serialize/deserialize functions.
 *
 * @module pipeline/pipeline-serialization
 */

import { z } from 'zod'
import type { PipelineDefinition } from './pipeline-definition.js'

// ---------------------------------------------------------------------------
// Node schemas
// ---------------------------------------------------------------------------

const PipelineNodeBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retries: z.number().int().nonnegative().optional(),
})

export const AgentNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal('agent'),
  agentId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
})

export const ToolNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal('tool'),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
})

export const TransformNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal('transform'),
  transformName: z.string().min(1),
})

export const GateNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal('gate'),
  gateType: z.enum(['approval', 'budget', 'quality']),
  condition: z.string().optional(),
})

export const ForkNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal('fork'),
  forkId: z.string().min(1),
})

export const JoinNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal('join'),
  forkId: z.string().min(1),
  mergeStrategy: z.enum(['all', 'first', 'majority']).optional(),
})

export const LoopNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal('loop'),
  bodyNodeIds: z.array(z.string().min(1)).min(1),
  maxIterations: z.number().int().positive(),
  continuePredicateName: z.string().min(1),
  failOnMaxIterations: z.boolean().optional(),
})

export const SuspendNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal('suspend'),
  resumeCondition: z.string().optional(),
})

export const PipelineNodeSchema = z.discriminatedUnion('type', [
  AgentNodeSchema,
  ToolNodeSchema,
  TransformNodeSchema,
  GateNodeSchema,
  ForkNodeSchema,
  JoinNodeSchema,
  LoopNodeSchema,
  SuspendNodeSchema,
])

// ---------------------------------------------------------------------------
// Edge schemas
// ---------------------------------------------------------------------------

export const SequentialEdgeSchema = z.object({
  type: z.literal('sequential'),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
})

export const ConditionalEdgeSchema = z.object({
  type: z.literal('conditional'),
  sourceNodeId: z.string().min(1),
  predicateName: z.string().min(1),
  branches: z.record(z.string(), z.string()),
})

export const ErrorEdgeSchema = z.object({
  type: z.literal('error'),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  errorCodes: z.array(z.string()).optional(),
})

export const PipelineEdgeSchema = z.discriminatedUnion('type', [
  SequentialEdgeSchema,
  ConditionalEdgeSchema,
  ErrorEdgeSchema,
])

// ---------------------------------------------------------------------------
// Checkpoint schema
// ---------------------------------------------------------------------------

export const PipelineCheckpointSchema = z.object({
  pipelineRunId: z.string().min(1),
  pipelineId: z.string().min(1),
  version: z.number().int().nonnegative(),
  schemaVersion: z.literal('1.0.0'),
  completedNodeIds: z.array(z.string()),
  state: z.record(z.string(), z.unknown()),
  suspendedAtNodeId: z.string().optional(),
  budgetState: z
    .object({
      tokensUsed: z.number().nonnegative(),
      costCents: z.number().nonnegative(),
    })
    .optional(),
  createdAt: z.string().min(1),
})

// ---------------------------------------------------------------------------
// Pipeline definition schema
// ---------------------------------------------------------------------------

export const PipelineDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  schemaVersion: z.literal('1.0.0'),
  entryNodeId: z.string().min(1),
  nodes: z.array(PipelineNodeSchema).min(1),
  edges: z.array(PipelineEdgeSchema),
  budgetLimitCents: z.number().nonnegative().optional(),
  tokenLimit: z.number().int().positive().optional(),
  checkpointStrategy: z
    .enum(['after_each_node', 'on_suspend', 'manual', 'none'])
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
})

// ---------------------------------------------------------------------------
// Serialization / deserialization
// ---------------------------------------------------------------------------

/**
 * Serialize a PipelineDefinition to a JSON string.
 *
 * The definition is validated before serialization to catch errors early.
 * Throws if validation fails.
 */
export function serializePipeline(definition: PipelineDefinition): string {
  const result = PipelineDefinitionSchema.safeParse(definition)
  if (!result.success) {
    throw new Error(
      `Pipeline serialization failed: ${result.error.issues.map((i) => i.message).join('; ')}`,
    )
  }
  return JSON.stringify(result.data)
}

/**
 * Deserialize a JSON string into a validated PipelineDefinition.
 *
 * Throws if the JSON is invalid or does not match the schema.
 */
export function deserializePipeline(json: string): PipelineDefinition {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Pipeline deserialization failed: invalid JSON')
  }

  const result = PipelineDefinitionSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `Pipeline deserialization failed: ${result.error.issues.map((i) => i.message).join('; ')}`,
    )
  }
  return result.data as PipelineDefinition
}
