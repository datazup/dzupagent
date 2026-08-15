/**
 * Pipeline serialization — Zod schemas + serialize/deserialize functions.
 *
 * @module pipeline/pipeline-serialization
 */

import { z } from "zod";
import {
  validatePipelineInteractionResumeV1,
  validatePipelineInteractionSpecV1,
  validatePipelinePendingInteractionV1,
  type PipelineApprovalInteractionSpecV1,
  type PipelineClarificationInteractionSpecV1,
  type PipelineInteractionResumeV1,
  type PipelineInteractionScopeV1,
  type PipelinePendingInteractionV1,
} from "@dzupagent/runtime-contracts";
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
  retryPolicy: z
    .object({
      initialBackoffMs: z.number().nonnegative().optional(),
      maxBackoffMs: z.number().nonnegative().optional(),
      multiplier: z.number().positive().optional(),
      backoffMultiplier: z.number().positive().optional(),
      jitter: z.boolean().optional(),
      retryableErrors: z.array(z.string()).optional(),
    })
    .strict()
    .optional(),
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
  interaction: z
    .custom<PipelineApprovalInteractionSpecV1>(
      (value) => {
        const result = validatePipelineInteractionSpecV1(value);
        return result.valid && result.value.kind === "approval";
      },
      { message: "invalid approval interaction specification" },
    )
    .optional(),
}).strict();

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
      suspensionSiteNodeIds: z.array(z.string().min(1)).optional(),
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
      concurrency: z.literal(1, {
        error:
          "for_each.concurrency must be 1 until a durable per-item frame and economic settlement protocol are admitted",
      }),
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
  interaction: z
    .custom<PipelineClarificationInteractionSpecV1>(
      (value) => {
        const result = validatePipelineInteractionSpecV1(value);
        return result.valid && result.value.kind === "clarification";
      },
      { message: "invalid clarification interaction specification" },
    )
    .optional(),
}).strict();

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

const PipelinePendingInteractionSchema = z.custom<PipelinePendingInteractionV1>(
  (value) => validatePipelinePendingInteractionV1(value).valid,
  { message: "invalid pending pipeline interaction" },
);

const PipelineInteractionResumeSchema = z.custom<PipelineInteractionResumeV1>(
  (value) => validatePipelineInteractionResumeV1(value).valid,
  { message: "invalid pipeline interaction receipt" },
);

const PipelineInteractionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pipeline") }).strict(),
  z
    .object({
      kind: z.literal("loop"),
      loopNodeId: z.string().min(1),
      iteration: z.number().int().nonnegative(),
    })
    .strict(),
]) satisfies z.ZodType<PipelineInteractionScopeV1>;

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
  pendingInteraction: PipelinePendingInteractionSchema.optional(),
  interactionReceipts: z
    .record(z.string().min(1), PipelineInteractionResumeSchema)
    .optional(),
  interactionResumeCursor: z
    .object({
      interactionId: z.string().min(1),
      receiptHash: z.string().min(1),
      definitionDigest: z.string().min(1),
      nodeId: z.string().min(1),
      scope: PipelineInteractionScopeSchema,
      selectedSuccessorNodeId: z.string().min(1).optional(),
      nextNodeId: z.string().min(1).optional(),
    })
    .strict()
    .optional(),
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
}).strict().superRefine((checkpoint, context) => {
  const hasInteractionState =
    checkpoint.pendingInteraction !== undefined ||
    checkpoint.interactionResumeCursor !== undefined ||
    Object.keys(checkpoint.interactionReceipts ?? {}).length > 0;
  if (checkpoint.schemaVersion === "1.0.0" && hasInteractionState) {
    context.addIssue({
      code: "custom",
      path: ["schemaVersion"],
      message: "pipeline interaction state requires checkpoint schemaVersion 1.1.0",
    });
  }
  const pending = checkpoint.pendingInteraction;
  if (pending !== undefined) {
    if (pending.pipelineId !== checkpoint.pipelineId) {
      context.addIssue({
        code: "custom",
        path: ["pendingInteraction", "pipelineId"],
        message: "pending interaction pipeline binding does not match checkpoint",
      });
    }
    if (pending.runId !== checkpoint.pipelineRunId) {
      context.addIssue({
        code: "custom",
        path: ["pendingInteraction", "runId"],
        message: "pending interaction run binding does not match checkpoint",
      });
    }
    if (pending.expectedCheckpointVersion !== checkpoint.version) {
      context.addIssue({
        code: "custom",
        path: ["pendingInteraction", "expectedCheckpointVersion"],
        message: "pending interaction version binding does not match checkpoint",
      });
    }
    if (checkpoint.interactionResumeCursor !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["interactionResumeCursor"],
        message: "a checkpoint cannot be both pending and post-consumption",
      });
    }
    if (checkpoint.interactionReceipts?.[pending.interactionId] !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["interactionReceipts", pending.interactionId],
        message: "a pending interaction cannot already have a committed receipt",
      });
    }
    if (pending.scope.kind === "loop") {
      const loop = checkpoint.loopState?.[pending.scope.loopNodeId];
      if (loop === undefined || loop.iteration !== pending.scope.iteration) {
        context.addIssue({
          code: "custom",
          path: ["pendingInteraction", "scope"],
          message: "pending loop interaction scope does not match the checkpoint loop cursor",
        });
      }
    }
  }

  for (const [interactionId, receipt] of Object.entries(
    checkpoint.interactionReceipts ?? {},
  )) {
    if (interactionId !== receipt.interactionId) {
      context.addIssue({
        code: "custom",
        path: ["interactionReceipts", interactionId],
        message: "interaction receipt map key must equal receipt.interactionId",
      });
    }
    if (
      receipt.pipelineId !== checkpoint.pipelineId ||
      receipt.runId !== checkpoint.pipelineRunId
    ) {
      context.addIssue({
        code: "custom",
        path: ["interactionReceipts", interactionId],
        message: "interaction receipt pipeline/run binding does not match checkpoint",
      });
    }
    if (receipt.expectedCheckpointVersion >= checkpoint.version) {
      context.addIssue({
        code: "custom",
        path: ["interactionReceipts", interactionId, "expectedCheckpointVersion"],
        message: "committed receipt must bind a checkpoint version before the current checkpoint",
      });
    }
  }

  const cursor = checkpoint.interactionResumeCursor;
  if (cursor !== undefined) {
    const receipt = checkpoint.interactionReceipts?.[cursor.interactionId];
    if (receipt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["interactionResumeCursor", "interactionId"],
        message: "interaction resume cursor requires its committed receipt",
      });
    } else if (
      receipt.receiptHash !== cursor.receiptHash ||
      receipt.definitionDigest !== cursor.definitionDigest ||
      receipt.nodeId !== cursor.nodeId ||
      JSON.stringify(receipt.scope) !== JSON.stringify(cursor.scope)
    ) {
      context.addIssue({
        code: "custom",
        path: ["interactionResumeCursor"],
        message: "interaction resume cursor does not match its committed receipt",
      });
    }
    if (
      cursor.scope.kind === "pipeline" &&
      cursor.nextNodeId !== cursor.selectedSuccessorNodeId
    ) {
      context.addIssue({
        code: "custom",
        path: ["interactionResumeCursor", "nextNodeId"],
        message: "pipeline interaction cursor must resume at its selected successor",
      });
    }
    if (cursor.scope.kind === "loop") {
      const loop = checkpoint.loopState?.[cursor.scope.loopNodeId];
      if (
        cursor.nextNodeId !== cursor.scope.loopNodeId ||
        loop?.iteration !== cursor.scope.iteration ||
        loop?.bodyGraphState === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["interactionResumeCursor", "scope"],
          message: "loop interaction cursor must bind the exact retained loop iteration",
        });
      }
    }
  }
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
  classificationEnvelope: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
}).strict().superRefine((definition, context) => {
  const interactionNodes = definition.nodes.filter(
    (node) =>
      (node.type === "gate" || node.type === "suspend") &&
      node.interaction !== undefined,
  );
  if (definition.schemaVersion === "1.0.0" && interactionNodes.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["schemaVersion"],
      message: "pipeline interaction specifications require schemaVersion 1.1.0",
    });
  }
  for (const node of interactionNodes) {
    if (node.type === "gate") {
      if (node.gateType !== "approval") {
        context.addIssue({
          code: "custom",
          path: ["nodes", definition.nodes.indexOf(node), "gateType"],
          message: "approval interaction specifications require an approval gate",
        });
        continue;
      }
      const edges = definition.edges.filter(
        (candidate) => candidate.type === "conditional" && candidate.sourceNodeId === node.id,
      );
      const edge = edges[0];
      const branchKeys = edge?.type === "conditional"
        ? Object.keys(edge.branches).sort()
        : [];
      if (
        edges.length !== 1 ||
        edge === undefined ||
        edge.type !== "conditional" ||
        branchKeys.length !== 2 ||
        branchKeys[0] !== "approved" ||
        branchKeys[1] !== "rejected" ||
        edge.branches.approved !== node.interaction?.outcomeToSuccessor.approved ||
        edge.branches.rejected !== node.interaction?.outcomeToSuccessor.rejected
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodes", definition.nodes.indexOf(node), "interaction"],
          message: "approval interaction outcome mapping must agree with exactly one conditional graph edge containing exact approved/rejected keys",
        });
      }
    }
  }
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
