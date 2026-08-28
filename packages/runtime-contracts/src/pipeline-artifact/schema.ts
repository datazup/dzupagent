/**
 * Pipeline artifact schemas — zod validation for the persisted pipeline
 * definition artifact (nodes, edges, top-level definition), compile-time
 * pinned to the interfaces in `./definition.js` in both directions.
 *
 * Extracted from core's pipeline-serialization module (ARCH27-T-07) so
 * artifact producers such as the flow compiler can validate what they emit
 * without a runtime edge into core. Checkpoint and interaction-scope schemas
 * remain in core beside the stores that persist them.
 *
 * @module pipeline-artifact/schema
 */

import { z } from "zod";

import { validatePipelineInteractionSpecV1 } from "../pipeline-interaction/spec-validation.js";
import type {
  PipelineApprovalInteractionSpecV1,
  PipelineClarificationInteractionSpecV1,
} from "../pipeline-interaction/types.js";
import type {
  AgentNode,
  ConditionalEdge,
  ErrorEdge,
  ForkNode,
  GateNode,
  JoinNode,
  LoopNode,
  PipelineDefinition,
  PipelineEdge,
  PipelineNode,
  SequentialEdge,
  SuspendNode,
  ToolNode,
  TransformNode,
} from "./definition.js";
import { PIPELINE_SCHEMA_VERSIONS } from "./definition.js";

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
}).strict();

export const ToolNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal("tool"),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const TransformNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal("transform"),
  transformName: z.string().min(1),
}).strict();

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
}).strict();

export const JoinNodeSchema = PipelineNodeBaseSchema.extend({
  type: z.literal("join"),
  forkId: z.string().min(1),
  mergeStrategy: z.enum(["all", "first", "majority"]).optional(),
}).strict();

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
      // 24-I: widened from `z.literal(1)`. Still REQUIRED and still a positive
      // integer — absence remains a violation here, matching the agent-side
      // admission gate rather than the compiler's skip-if-absent rule.
      concurrency: z.number().int().positive({
        error: "for_each.concurrency must be a positive integer",
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
}).strict();

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
// Pipeline definition schema
// ---------------------------------------------------------------------------

export const PipelineDefinitionSchema = z
  .object({
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
  })
  .strict()
  .superRefine((definition, context) => {
    const interactionNodes = definition.nodes.filter(
      (node) =>
        (node.type === "gate" || node.type === "suspend") &&
        node.interaction !== undefined,
    );
    if (definition.schemaVersion === "1.0.0" && interactionNodes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["schemaVersion"],
        message:
          "pipeline interaction specifications require schemaVersion 1.1.0",
      });
    }
    for (const node of interactionNodes) {
      if (node.type === "gate") {
        if (node.gateType !== "approval") {
          context.addIssue({
            code: "custom",
            path: ["nodes", definition.nodes.indexOf(node), "gateType"],
            message:
              "approval interaction specifications require an approval gate",
          });
          continue;
        }
        const edges = definition.edges.filter(
          (candidate) =>
            candidate.type === "conditional" &&
            candidate.sourceNodeId === node.id,
        );
        const edge = edges[0];
        const branchKeys =
          edge?.type === "conditional" ? Object.keys(edge.branches).sort() : [];
        if (
          edges.length !== 1 ||
          edge === undefined ||
          edge.type !== "conditional" ||
          branchKeys.length !== 2 ||
          branchKeys[0] !== "approved" ||
          branchKeys[1] !== "rejected" ||
          edge.branches.approved !==
            node.interaction?.outcomeToSuccessor.approved ||
          edge.branches.rejected !==
            node.interaction?.outcomeToSuccessor.rejected
        ) {
          context.addIssue({
            code: "custom",
            path: ["nodes", definition.nodes.indexOf(node), "interaction"],
            message:
              "approval interaction outcome mapping must agree with exactly one conditional graph edge containing exact approved/rejected keys",
          });
        }
      }
    }
  });

// ---------------------------------------------------------------------------
// Schema/interface drift pins
// ---------------------------------------------------------------------------

// Every node/edge/definition schema above is compile-time-pinned to its
// hand-written interface, in BOTH directions: a schema admitting extra or
// wrong-typed fields fails the schema→interface check, and a schema quietly
// admitting LESS than the interface fails the interface→schema check — which
// is exactly how `retryableErrors` drifted (the type admitted RegExp, the
// schema rejected it).
//
// A direct `satisfies z.ZodType<X>` cannot express this under
// `exactOptionalPropertyTypes`: zod infers optional properties as `key?: T |
// undefined` while the interfaces say `key?: T`, so the clause fails on noise
// with zero real drift. `Loose` widens every property value of the interface
// with `| undefined` (preserving which keys are optional), which is invisible
// to every check we care about here.
type Loose<T> = T extends (infer E)[]
  ? Loose<E>[]
  : T extends object
    ? { [K in keyof T]: Loose<T[K]> | undefined }
    : T;
type Pinned<Schema extends z.ZodType, I> = [z.infer<Schema>] extends [Loose<I>]
  ? [I] extends [z.infer<Schema>]
    ? true
    : false
  : false;
type Assert<T extends true> = T;

export type PipelineSchemaInterfacePins = [
  Assert<Pinned<typeof AgentNodeSchema, AgentNode>>,
  Assert<Pinned<typeof ToolNodeSchema, ToolNode>>,
  Assert<Pinned<typeof TransformNodeSchema, TransformNode>>,
  Assert<Pinned<typeof GateNodeSchema, GateNode>>,
  Assert<Pinned<typeof ForkNodeSchema, ForkNode>>,
  Assert<Pinned<typeof JoinNodeSchema, JoinNode>>,
  Assert<Pinned<typeof LoopNodeSchema, LoopNode>>,
  Assert<Pinned<typeof SuspendNodeSchema, SuspendNode>>,
  Assert<Pinned<typeof PipelineNodeSchema, PipelineNode>>,
  Assert<Pinned<typeof SequentialEdgeSchema, SequentialEdge>>,
  Assert<Pinned<typeof ConditionalEdgeSchema, ConditionalEdge>>,
  Assert<Pinned<typeof ErrorEdgeSchema, ErrorEdge>>,
  Assert<Pinned<typeof PipelineEdgeSchema, PipelineEdge>>,
  Assert<Pinned<typeof PipelineDefinitionSchema, PipelineDefinition>>,
];
