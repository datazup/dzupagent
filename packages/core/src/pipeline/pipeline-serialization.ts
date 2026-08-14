/**
 * Pipeline serialization — Zod schemas + serialize/deserialize functions.
 *
 * @module pipeline/pipeline-serialization
 */

import { z } from "zod";
import type { PipelineDefinition } from "./pipeline-definition.js";
import { PIPELINE_SCHEMA_VERSIONS } from "./pipeline-definition.js";

// ---------------------------------------------------------------------------
// Node schemas
// ---------------------------------------------------------------------------

const PipelineNodeBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retries: z.number().int().nonnegative().optional(),
  declaredIdempotencyKey: z.string().optional(),
  idempotency: z
    .enum(["idempotent", "at-least-once", "exactly-once-required"])
    .optional(),
  effectClass: z.string().optional(),
  source: z
    .object({
      kind: z.literal("flow-node"),
      path: z.string().min(1),
      nodeType: z.string().min(1),
      nodeId: z.string().min(1).optional(),
    })
    .optional(),
});

export const AgentNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal("agent"),
  agentId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const ToolNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal("tool"),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const TransformNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal("transform"),
  transformName: z.string().min(1),
});

export const GateNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal("gate"),
  gateType: z.enum(["approval", "budget", "quality"]),
  condition: z.string().optional(),
});

export const ForkNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal("fork"),
  forkId: z.string().min(1),
});

export const JoinNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal("join"),
  forkId: z.string().min(1),
  mergeStrategy: z.enum(["all", "first", "majority"]).optional(),
});

export const LoopNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal("loop"),
  bodyNodeIds: z.array(z.string().min(1)).min(1),
  bodyGraph: z
    .object({
      entryNodeId: z.string().min(1),
      normalExitNodeIds: z.array(z.string().min(1)),
      suspendedExitNodeIds: z.array(z.string().min(1)),
      terminalExitNodeIds: z.array(z.string().min(1)),
      errorExitNodeIds: z.array(z.string().min(1)),
    })
    .optional(),
  maxIterations: z.number().int().positive(),
  continuePredicateName: z.string().min(1),
  failOnMaxIterations: z.boolean().optional(),
  forEach: z
    .object({
      source: z.string().min(1),
      as: z.string().min(1),
      order: z.literal("input"),
      attachAs: z.string().min(1).optional(),
      collect: z
        .object({
          from: z.string().min(1),
          into: z.string().min(1),
          order: z.literal("input"),
        })
        .optional(),
      accumulator: z
        .object({
          key: z.string().min(1),
          window: z.number().int().positive().optional(),
          initialValue: z.unknown().optional(),
        })
        .optional(),
      concurrency: z.number().int().min(1).max(8),
      failFast: z.boolean().optional(),
      empty: z.object({
        body: z.literal("skip"),
        aggregate: z.literal("empty-array"),
      }),
    })
    .optional(),
  typedWhile: z
    .object({
      conditionSchema: z.literal("dzupagent.flowTypedCondition/v1"),
      condition: z.record(z.string(), z.unknown()),
      onExhausted: z.enum(["fail", "continue"]),
      iterationTimeoutMs: z.number().int().positive().optional(),
      iterationBudgetCents: z.number().positive().finite().optional(),
      progressKey: z.string().min(1).optional(),
    })
    .optional(),
});

export const SuspendNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal("suspend"),
  resumeCondition: z.string().optional(),
});

export const PipelineNodeSchema = z.discriminatedUnion("type", [
  AgentNodeSchema,
  ToolNodeSchema,
  TransformNodeSchema,
  GateNodeSchema,
  ForkNodeSchema,
  JoinNodeSchema,
  LoopNodeSchema,
  SuspendNodeSchema,
]);

// ---------------------------------------------------------------------------
// Edge schemas
// ---------------------------------------------------------------------------

export const SequentialEdgeSchema = z.object({
  type: z.literal("sequential"),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
});

export const ConditionalEdgeSchema = z.object({
  type: z.literal("conditional"),
  sourceNodeId: z.string().min(1),
  predicateName: z.string().min(1),
  branches: z.record(z.string(), z.string()),
});

export const ErrorEdgeSchema = z.object({
  type: z.literal("error"),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  errorCodes: z.array(z.string()).optional(),
});

export const PipelineEdgeSchema = z.discriminatedUnion("type", [
  SequentialEdgeSchema,
  ConditionalEdgeSchema,
  ErrorEdgeSchema,
]);

// ---------------------------------------------------------------------------
// Checkpoint schema
// ---------------------------------------------------------------------------

const PipelineForkCheckpointStateSchema = z.record(
  z.string(),
  z.object({
    branches: z.record(
      z.string(),
      z.object({
        stateDelta: z.record(z.string(), z.unknown()),
        nodeResults: z.record(z.string(), z.unknown()),
      })
    ),
  })
);

const PipelineLoopBodyGraphCheckpointStateSchema = z
  .object({
    completed: z.boolean(),
    nextNodeId: z.string().min(1).optional(),
    outcome: z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("normal"),
          exitNodeId: z.string().min(1),
        }),
        z.object({
          kind: z.literal("suspended"),
          exitNodeId: z.string().min(1),
        }),
        z.object({
          kind: z.literal("terminal"),
          exitNodeId: z.string().min(1),
        }),
      ])
      .optional(),
    completedNodeIds: z.array(z.string().min(1)),
    nodeResults: z.record(z.string(), z.unknown()),
    nodeIdempotencyKeys: z.record(z.string(), z.string()),
    forkState: PipelineForkCheckpointStateSchema.optional(),
  })
  .superRefine((graph, context) => {
    const isSuspended = graph.outcome?.kind === "suspended";
    const isCompletedOutcome =
      graph.outcome?.kind === "normal" || graph.outcome?.kind === "terminal";
    const legacyCursorInvalid =
      graph.outcome === undefined &&
      graph.completed === (graph.nextNodeId !== undefined);
    const suspendedCursorInvalid =
      isSuspended && (graph.completed || graph.nextNodeId !== undefined);
    const completedOutcomeInvalid =
      isCompletedOutcome && (!graph.completed || graph.nextNodeId !== undefined);
    if (legacyCursorInvalid) {
      context.addIssue({
        code: "custom",
        path: ["nextNodeId"],
        message:
          "completed graph cursors omit nextNodeId; incomplete cursors require it",
      });
    }
    if (suspendedCursorInvalid || completedOutcomeInvalid) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "normal/terminal outcomes require completed=true; suspended outcomes require completed=false; classified outcomes omit nextNodeId",
      });
    }

    const seenNodeIds = new Set<string>();
    graph.completedNodeIds.forEach((nodeId, index) => {
      if (seenNodeIds.has(nodeId)) {
        context.addIssue({
          code: "custom",
          path: ["completedNodeIds", index],
          message: `completedNodeIds contains duplicate node ID "${nodeId}"`,
        });
      }
      seenNodeIds.add(nodeId);
    });
  });

const PipelineLoopCheckpointStateSchema = z
  .object({
    iteration: z.number().int().nonnegative(),
    nextBodyNodeIndex: z.number().int().nonnegative().optional(),
    bodyResults: z.record(z.string(), z.unknown()).optional(),
    bodyGraphState: PipelineLoopBodyGraphCheckpointStateSchema.optional(),
    previousOutput: z.unknown().optional(),
    progressDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .superRefine((cursor, context) => {
    const hasNextBodyNodeIndex = cursor.nextBodyNodeIndex !== undefined;
    const hasBodyResults = cursor.bodyResults !== undefined;

    if (hasNextBodyNodeIndex !== hasBodyResults) {
      context.addIssue({
        code: "custom",
        path: hasNextBodyNodeIndex
          ? ["bodyResults"]
          : ["nextBodyNodeIndex"],
        message:
          "nextBodyNodeIndex and bodyResults must be present or absent together",
      });
    }

    if (
      cursor.bodyGraphState !== undefined &&
      (hasNextBodyNodeIndex || hasBodyResults)
    ) {
      context.addIssue({
        code: "custom",
        path: ["bodyGraphState"],
        message: "bodyGraphState is mutually exclusive with the flat body cursor",
      });
    }
  });

export const PipelineCheckpointSchema = z.object({
  pipelineRunId: z.string().min(1),
  pipelineId: z.string().min(1),
  version: z.number().int().nonnegative(),
  schemaVersion: z.enum(PIPELINE_SCHEMA_VERSIONS),
  completedNodeIds: z.array(z.string()),
  nodeIdempotencyKeys: z.record(z.string(), z.string()).optional(),
  loopState: z
    .record(z.string(), PipelineLoopCheckpointStateSchema)
    .optional(),
  forkState: PipelineForkCheckpointStateSchema.optional(),
  state: z.record(z.string(), z.unknown()),
  suspendedAtNodeId: z.string().optional(),
  budgetState: z
    .object({
      tokensUsed: z.number().nonnegative(),
      costCents: z.number().nonnegative(),
    })
    .optional(),
  recoveryAttemptsUsed: z.number().int().nonnegative().optional(),
  events: z.array(z.record(z.string(), z.unknown()).and(z.object({
    type: z.string().min(1),
  }))).optional(),
  executionLog: z
    .object({
      storeRef: z.string().optional(),
      eventHistory: z.enum(["compact", "full"]),
      events: z.array(z.record(z.string(), z.unknown()).and(z.object({
        type: z.string().min(1),
      }))),
    })
    .optional(),
  providerSessionRefs: z
    .array(
      z.object({
        nodeId: z.string().min(1),
        provider: z.string().min(1),
        sessionId: z.string().min(1),
        label: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  createdAt: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Pipeline definition schema
// ---------------------------------------------------------------------------

export const PipelineDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  schemaVersion: z.enum(PIPELINE_SCHEMA_VERSIONS),
  entryNodeId: z.string().min(1),
  nodes: z.array(PipelineNodeSchema).min(1),
  edges: z.array(PipelineEdgeSchema),
  budgetLimitCents: z.number().nonnegative().optional(),
  tokenLimit: z.number().int().positive().optional(),
  checkpointStrategy: z
    .enum(["after_each_node", "on_suspend", "manual", "none"])
    .optional(),
  checkpoint: z
    .object({
      storeRef: z.string().optional(),
      includeEvents: z.boolean().optional(),
      includeProviderSessionRefs: z.boolean().optional(),
      retention: z
        .object({
          ttlMs: z.number().int().nonnegative().optional(),
          maxVersions: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  resume: z
    .object({
      onProcessRestart: z
        .enum(["fail_running", "resume_from_checkpoint", "redeliver_running"])
        .optional(),
      requireResumePoint: z.boolean().optional(),
      maxReplayNodes: z.number().int().nonnegative().optional(),
    })
    .optional(),
  executionLog: z
    .object({
      storeRef: z.string().optional(),
      eventHistory: z.enum(["none", "compact", "full"]).optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

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
  const result = PipelineDefinitionSchema.safeParse(definition);
  if (!result.success) {
    throw new Error(
      `Pipeline serialization failed: ${result.error.issues
        .map((i) => i.message)
        .join("; ")}`
    );
  }
  return JSON.stringify(result.data);
}

/**
 * Deserialize a JSON string into a validated PipelineDefinition.
 *
 * Throws if the JSON is invalid or does not match the schema.
 */
export function deserializePipeline(json: string): PipelineDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Pipeline deserialization failed: invalid JSON");
  }

  const result = PipelineDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Pipeline deserialization failed: ${result.error.issues
        .map((i) => i.message)
        .join("; ")}`
    );
  }
  return result.data as PipelineDefinition;
}
