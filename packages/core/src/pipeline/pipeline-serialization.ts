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
import {
  PIPELINE_CHECKPOINT_SCHEMA_VERSIONS,
  PIPELINE_FOR_EACH_ITEM_OUTCOMES,
} from "./pipeline-checkpoint-store.js";
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
      { message: "invalid approval interaction specification" }
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
      { message: "invalid clarification interaction specification" }
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
      isCompletedOutcome &&
      (!graph.completed || graph.nextNodeId !== undefined);
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

const PipelineSha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * 24-F: durable per-item economics. Costs are integer cents and never
 * negative; a fractional or negative amount is corrupt rather than merely
 * unusual, so it is rejected at the parse boundary instead of being rounded.
 */
const PipelineForEachItemEconomicsSchema = z
  .object({
    reservationId: z.string().min(1),
    reservedCostCents: z.number().int().nonnegative(),
    settledCostCents: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Mid-item durable progress for an in-flight for-each item (E0 frame). */
const PipelineForEachItemFrameSchema = z.object({
  itemIndex: z.number().int().nonnegative(),
  nextBodyNodeIndex: z.number().int().nonnegative(),
  bodyResults: z.record(z.string(), z.unknown()).optional(),
  attempt: z.number().int().nonnegative().optional(),
  // 24-F: the outcome vocabulary is closed. An unrecognised state is corrupt,
  // not forward-compatible: admitting it would let a reader fall through every
  // terminal check and treat a settled item as still running.
  outcome: z.enum(PIPELINE_FOR_EACH_ITEM_OUTCOMES).optional(),
  economics: PipelineForEachItemEconomicsSchema.optional(),
});

/**
 * 24-G: terminal accounting record for one item. `.strict()` for the same
 * reason the economics schema is: an unrecognised key here is a writer
 * disagreeing with this contract, and silently dropping it would let a
 * checkpoint claim an accounting fact no reader honours.
 */
const PipelineForEachItemTerminalRecordSchema = z
  .object({
    itemIndex: z.number().int().nonnegative(),
    outcome: z.enum(PIPELINE_FOR_EACH_ITEM_OUTCOMES),
    economics: PipelineForEachItemEconomicsSchema.optional(),
    attempt: z.number().int().nonnegative().optional(),
  })
  .strict();

const PipelineLoopCheckpointStateSchema = z
  .object({
    iteration: z.number().int().nonnegative(),
    nextBodyNodeIndex: z.number().int().nonnegative().optional(),
    bodyResults: z.record(z.string(), z.unknown()).optional(),
    itemFrame: PipelineForEachItemFrameSchema.optional(),
    itemFrames: z
      .record(
        z.string().regex(/^(0|[1-9][0-9]*)$/, {
          message: "itemFrames keys must be decimal item indices",
        }),
        PipelineForEachItemFrameSchema
      )
      .optional(),
    itemOutcomes: z
      .record(
        z.string().regex(/^(0|[1-9][0-9]*)$/, {
          message: "itemOutcomes keys must be decimal item indices",
        }),
        PipelineForEachItemTerminalRecordSchema
      )
      .optional(),
    bodyGraphState: PipelineLoopBodyGraphCheckpointStateSchema.optional(),
    previousOutput: z.unknown().optional(),
    progressDigest: PipelineSha256DigestSchema.optional(),
  })
  .superRefine((cursor, context) => {
    const hasNextBodyNodeIndex = cursor.nextBodyNodeIndex !== undefined;
    const hasBodyResults = cursor.bodyResults !== undefined;

    if (hasNextBodyNodeIndex !== hasBodyResults) {
      context.addIssue({
        code: "custom",
        path: hasNextBodyNodeIndex ? ["bodyResults"] : ["nextBodyNodeIndex"],
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
        message:
          "bodyGraphState is mutually exclusive with the flat body cursor",
      });
    }

    // G1: `itemFrame` is the pre-G1 singular spelling of `itemFrames`. A
    // checkpoint carrying both is ambiguous about which one is authoritative,
    // so reject it rather than silently preferring one.
    if (cursor.itemFrame !== undefined && cursor.itemFrames !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["itemFrames"],
        message:
          "itemFrames supersedes the legacy itemFrame; a checkpoint must not carry both",
      });
    }

    // Each frame is addressed by its item index, so a key disagreeing with the
    // frame it holds would resume the wrong item.
    if (cursor.itemFrames !== undefined) {
      for (const [key, frame] of Object.entries(cursor.itemFrames)) {
        if (String(frame.itemIndex) !== key) {
          context.addIssue({
            code: "custom",
            path: ["itemFrames", key, "itemIndex"],
            message:
              `itemFrames key "${key}" does not match its frame's itemIndex ` +
              `${frame.itemIndex}`,
          });
        }
      }
    }

    // 24-G: same rule for the terminal set, for the same reason. A key
    // disagreeing with the record it holds would attribute one item's outcome
    // — and its settled cost — to a different item.
    if (cursor.itemOutcomes !== undefined) {
      for (const [key, record] of Object.entries(cursor.itemOutcomes)) {
        if (String(record.itemIndex) !== key) {
          context.addIssue({
            code: "custom",
            path: ["itemOutcomes", key, "itemIndex"],
            message:
              `itemOutcomes key "${key}" does not match its record's ` +
              `itemIndex ${record.itemIndex}`,
          });
        }
      }
    }
  });

const PipelinePendingInteractionSchema = z.custom<PipelinePendingInteractionV1>(
  (value) => validatePipelinePendingInteractionV1(value).valid,
  { message: "invalid pending pipeline interaction" }
);

const PipelineInteractionResumeSchema = z.custom<PipelineInteractionResumeV1>(
  (value) => validatePipelineInteractionResumeV1(value).valid,
  { message: "invalid pipeline interaction receipt" }
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

export const PipelineCheckpointSchema = z
  .object({
    pipelineRunId: z.string().min(1),
    pipelineId: z.string().min(1),
    version: z.number().int().nonnegative(),
    schemaVersion: z.enum(PIPELINE_CHECKPOINT_SCHEMA_VERSIONS),
    sourceBinding: z
      .object({
        definitionDigest: PipelineSha256DigestSchema,
        loopSourceDigests: z
          .record(z.string(), PipelineSha256DigestSchema)
          .optional(),
      })
      .strict()
      .optional(),
    recursiveForkCompletions: z
      .record(
        z.string().min(1),
        z
          .object({
            schema: z.literal("dzupagent.pipelineRecursiveForkCompletion/v1"),
            definitionDigest: PipelineSha256DigestSchema,
            ownerPath: z.array(z.string().min(1)).min(1),
            forkNodeId: z.string().min(1),
            forkId: z.string().min(1),
            joinNodeId: z.string().min(1),
            parentCommitIdentity: PipelineSha256DigestSchema,
            mergeIdentity: PipelineSha256DigestSchema,
            childCommitIdentities: z.array(PipelineSha256DigestSchema).min(1),
            children: z
              .array(
                z
                  .object({
                    childScopeId: z.string().min(1),
                    frameIdentity: PipelineSha256DigestSchema,
                    commitIdentity: PipelineSha256DigestSchema,
                    normalExitNodeId: z.string().min(1),
                  })
                  .strict()
              )
              .min(1),
            checkpointVersion: z.number().int().positive(),
            selectedContinuationNodeId: z.string().min(1).optional(),
          })
          .strict()
      )
      .optional(),
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
    events: z
      .array(
        z.record(z.string(), z.unknown()).and(
          z.object({
            type: z.string().min(1),
          })
        )
      )
      .optional(),
    executionLog: z
      .object({
        storeRef: z.string().optional(),
        eventHistory: z.enum(["compact", "full"]),
        events: z.array(
          z.record(z.string(), z.unknown()).and(
            z.object({
              type: z.string().min(1),
            })
          )
        ),
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
        })
      )
      .optional(),
    createdAt: z.string().min(1),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const recursiveForkCompletions = Object.entries(
      checkpoint.recursiveForkCompletions ?? {}
    );
    if (
      checkpoint.schemaVersion !== "1.2.0" &&
      recursiveForkCompletions.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["schemaVersion"],
        message:
          "recursive fork completion receipts require checkpoint schemaVersion 1.2.0",
      });
    }
    for (const [forkNodeId, receipt] of recursiveForkCompletions) {
      if (forkNodeId !== receipt.forkNodeId) {
        context.addIssue({
          code: "custom",
          path: ["recursiveForkCompletions", forkNodeId, "forkNodeId"],
          message: "recursive fork completion key must equal forkNodeId",
        });
      }
      if (receipt.ownerPath.at(-1) !== receipt.forkNodeId) {
        context.addIssue({
          code: "custom",
          path: ["recursiveForkCompletions", forkNodeId, "ownerPath"],
          message: "recursive fork completion ownerPath must end at forkNodeId",
        });
      }
      if (receipt.checkpointVersion > checkpoint.version) {
        context.addIssue({
          code: "custom",
          path: [
            "recursiveForkCompletions",
            forkNodeId,
            "checkpointVersion",
          ],
          message:
            "recursive fork completion cannot bind a future checkpoint version",
        });
      }
      if (
        checkpoint.sourceBinding !== undefined &&
        receipt.definitionDigest !== checkpoint.sourceBinding.definitionDigest
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "recursiveForkCompletions",
            forkNodeId,
            "definitionDigest",
          ],
          message:
            "recursive fork completion definition digest must match checkpoint source binding",
        });
      }
      const sortedCommitIdentities = [...receipt.childCommitIdentities].sort();
      if (
        new Set(receipt.childCommitIdentities).size !==
          receipt.childCommitIdentities.length ||
        receipt.childCommitIdentities.some(
          (identity, index) => identity !== sortedCommitIdentities[index]
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "recursiveForkCompletions",
            forkNodeId,
            "childCommitIdentities",
          ],
          message:
            "recursive fork child commit identities must be unique and canonically sorted",
        });
      }
      const childCommitIdentities = receipt.children
        .map((child) => child.commitIdentity)
        .sort();
      if (
        receipt.children.length !== receipt.childCommitIdentities.length ||
        childCommitIdentities.some(
          (identity, index) => identity !== receipt.childCommitIdentities[index]
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["recursiveForkCompletions", forkNodeId, "children"],
          message:
            "recursive fork children must bind the exact child commit identity set",
        });
      }
    }
    const hasInteractionState =
      checkpoint.pendingInteraction !== undefined ||
      checkpoint.interactionResumeCursor !== undefined ||
      Object.keys(checkpoint.interactionReceipts ?? {}).length > 0;
    if (checkpoint.schemaVersion === "1.0.0" && hasInteractionState) {
      context.addIssue({
        code: "custom",
        path: ["schemaVersion"],
        message:
          "pipeline interaction state requires checkpoint schemaVersion 1.1.0",
      });
    }

    // 24-G: the per-item terminal set follows the interaction-state precedent
    // directly above rather than being exempted from it.
    //
    // 24-F's frame fields (`outcome`/`economics`) were additive-and-optional
    // and shipped ungated, which left a `1.0.0` checkpoint able to carry state
    // a `1.0.0` reader has no rule for. That is tolerable only while nothing
    // acts on the field. 24-G makes the terminal set load-bearing — for
    // accounting, and for the resume reader that now refuses to re-dispatch a
    // terminally-settled item — so a checkpoint carrying it is no longer
    // readable under the old contract. Requiring `1.1.0` surfaces that at the
    // parse boundary rather than at the point a stale reader silently
    // re-dispatches a settled item and opens a second ledger row.
    //
    // Absence stays unprovable in the other direction: a `1.0.0` checkpoint
    // carrying no terminal set is untouched by this rule and keeps resuming.
    const hasForEachTerminalSet = Object.values(
      checkpoint.loopState ?? {}
    ).some((cursor) => cursor.itemOutcomes !== undefined);
    if (checkpoint.schemaVersion === "1.0.0" && hasForEachTerminalSet) {
      context.addIssue({
        code: "custom",
        path: ["schemaVersion"],
        message:
          "for_each per-item terminal outcomes require checkpoint schemaVersion 1.1.0",
      });
    }

    const pending = checkpoint.pendingInteraction;
    if (pending !== undefined) {
      if (pending.pipelineId !== checkpoint.pipelineId) {
        context.addIssue({
          code: "custom",
          path: ["pendingInteraction", "pipelineId"],
          message:
            "pending interaction pipeline binding does not match checkpoint",
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
          message:
            "pending interaction version binding does not match checkpoint",
        });
      }
      if (checkpoint.interactionResumeCursor !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["interactionResumeCursor"],
          message: "a checkpoint cannot be both pending and post-consumption",
        });
      }
      if (
        checkpoint.interactionReceipts?.[pending.interactionId] !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["interactionReceipts", pending.interactionId],
          message:
            "a pending interaction cannot already have a committed receipt",
        });
      }
      if (pending.scope.kind === "loop") {
        const loop = checkpoint.loopState?.[pending.scope.loopNodeId];
        if (loop === undefined || loop.iteration !== pending.scope.iteration) {
          context.addIssue({
            code: "custom",
            path: ["pendingInteraction", "scope"],
            message:
              "pending loop interaction scope does not match the checkpoint loop cursor",
          });
        }
      }
    }

    for (const [interactionId, receipt] of Object.entries(
      checkpoint.interactionReceipts ?? {}
    )) {
      if (interactionId !== receipt.interactionId) {
        context.addIssue({
          code: "custom",
          path: ["interactionReceipts", interactionId],
          message:
            "interaction receipt map key must equal receipt.interactionId",
        });
      }
      if (
        receipt.pipelineId !== checkpoint.pipelineId ||
        receipt.runId !== checkpoint.pipelineRunId
      ) {
        context.addIssue({
          code: "custom",
          path: ["interactionReceipts", interactionId],
          message:
            "interaction receipt pipeline/run binding does not match checkpoint",
        });
      }
      if (receipt.expectedCheckpointVersion >= checkpoint.version) {
        context.addIssue({
          code: "custom",
          path: [
            "interactionReceipts",
            interactionId,
            "expectedCheckpointVersion",
          ],
          message:
            "committed receipt must bind a checkpoint version before the current checkpoint",
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
          message:
            "interaction resume cursor does not match its committed receipt",
        });
      }
      if (
        cursor.scope.kind === "pipeline" &&
        cursor.nextNodeId !== cursor.selectedSuccessorNodeId
      ) {
        context.addIssue({
          code: "custom",
          path: ["interactionResumeCursor", "nextNodeId"],
          message:
            "pipeline interaction cursor must resume at its selected successor",
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
            message:
              "loop interaction cursor must bind the exact retained loop iteration",
          });
        }
      }
    }
  });

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
        node.interaction !== undefined
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
            candidate.sourceNodeId === node.id
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
