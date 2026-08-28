/**
 * Pipeline serialization — Zod schemas + serialize/deserialize functions.
 *
 * @module pipeline/pipeline-serialization
 */
import { z } from "zod";
import {
  validatePipelineInteractionResumeV1,
  validatePipelinePendingInteractionV1,
  type PipelineInteractionResumeV1,
  type PipelineInteractionScopeV1,
  type PipelinePendingInteractionV1,
} from "@dzupagent/runtime-contracts";
import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
import {
  validateLoopEconomicsEvidence,
  type LoopEconomicsEvidenceV1,
} from "@dzupagent/runtime-contracts/loop-economics-evidence";
import {
  PIPELINE_CHECKPOINT_SCHEMA_VERSIONS,
  PIPELINE_FOR_EACH_ITEM_OUTCOMES,
} from "./pipeline-checkpoint-store.js";

// The node/edge/definition schemas and their interface pins moved to
// `@dzupagent/runtime-contracts/pipeline-artifact` (ARCH27-T-07); this module
// re-exports them so existing core consumers keep working, and keeps the
// checkpoint schema beside the stores that persist it.
export {
  AgentNodeSchema,
  ToolNodeSchema,
  TransformNodeSchema,
  GateNodeSchema,
  ForkNodeSchema,
  JoinNodeSchema,
  LoopNodeSchema,
  SuspendNodeSchema,
  PipelineNodeSchema,
  SequentialEdgeSchema,
  ConditionalEdgeSchema,
  ErrorEdgeSchema,
  PipelineEdgeSchema,
  PipelineDefinitionSchema,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
export type { PipelineSchemaInterfacePins } from "@dzupagent/runtime-contracts/pipeline-artifact";
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
      }),
    ),
  }),
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
    evidence: z
      .custom<LoopEconomicsEvidenceV1>(
        (value) => validateLoopEconomicsEvidence(value).valid,
        { message: "invalid canonical loop economics evidence" },
      )
      .optional(),
  })
  .strict()
  .superRefine((economics, context) => {
    if (economics.evidence === undefined) return;
    const validation = validateLoopEconomicsEvidence(economics.evidence, {
      reservedCostCents: economics.reservedCostCents,
      ...(economics.settledCostCents === undefined
        ? {}
        : { settledCostCents: economics.settledCostCents }),
    });
    for (const diagnostic of validation.diagnostics) {
      context.addIssue({
        code: "custom",
        path: ["evidence", diagnostic.path],
        message: diagnostic.message,
      });
    }
  });

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
    iterationOutcome: z.enum(PIPELINE_FOR_EACH_ITEM_OUTCOMES).optional(),
    iterationEconomics: PipelineForEachItemEconomicsSchema.optional(),
    itemFrame: PipelineForEachItemFrameSchema.optional(),
    itemFrames: z
      .record(
        z.string().regex(/^(0|[1-9][0-9]*)$/, {
          message: "itemFrames keys must be decimal item indices",
        }),
        PipelineForEachItemFrameSchema,
      )
      .optional(),
    itemOutcomes: z
      .record(
        z.string().regex(/^(0|[1-9][0-9]*)$/, {
          message: "itemOutcomes keys must be decimal item indices",
        }),
        PipelineForEachItemTerminalRecordSchema,
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

    if (
      (cursor.iterationOutcome === undefined) !==
      (cursor.iterationEconomics === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path:
          cursor.iterationOutcome === undefined
            ? ["iterationOutcome"]
            : ["iterationEconomics"],
        message:
          "predicate-loop iterationOutcome and iterationEconomics must be present or absent together",
      });
    }

    if (
      cursor.iterationEconomics !== undefined &&
      (cursor.itemFrame !== undefined ||
        cursor.itemFrames !== undefined ||
        cursor.itemOutcomes !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["iterationEconomics"],
        message:
          "predicate-loop iteration economics is mutually exclusive with for_each item state",
      });
    }

    if (
      cursor.iterationOutcome === "completed" &&
      cursor.iterationEconomics?.settledCostCents === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["iterationEconomics", "settledCostCents"],
        message:
          "a completed predicate-loop iteration requires an authoritative settled cost",
      });
    }

    if (
      cursor.iterationEconomics?.evidence !== undefined &&
      cursor.iterationOutcome !== undefined
    ) {
      const expectedTerminal =
        cursor.iterationOutcome === "completed" ? "recorded" : "pending";
      const validation = validateLoopEconomicsEvidence(
        cursor.iterationEconomics.evidence,
        { terminalStatus: expectedTerminal },
      );
      for (const diagnostic of validation.diagnostics) {
        context.addIssue({
          code: "custom",
          path: ["iterationEconomics", "evidence", diagnostic.path],
          message: diagnostic.message,
        });
      }
    }

    if (
      (cursor.iterationOutcome === "reserved" ||
        cursor.iterationOutcome === "running") &&
      cursor.iterationEconomics?.settledCostCents !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["iterationEconomics", "settledCostCents"],
        message:
          "a reserved or running predicate-loop iteration cannot already carry settled cost",
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
                  .strict(),
              )
              .min(1),
            checkpointVersion: z.number().int().positive(),
            selectedContinuationNodeId: z.string().min(1).optional(),
          })
          .strict(),
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
          }),
        ),
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
            }),
          ),
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
        }),
      )
      .optional(),
    createdAt: z.string().min(1),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const recursiveForkCompletions = Object.entries(
      checkpoint.recursiveForkCompletions ?? {},
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
          path: ["recursiveForkCompletions", forkNodeId, "checkpointVersion"],
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
          path: ["recursiveForkCompletions", forkNodeId, "definitionDigest"],
          message:
            "recursive fork completion definition digest must match checkpoint source binding",
        });
      }
      const sortedCommitIdentities = [...receipt.childCommitIdentities].sort();
      if (
        new Set(receipt.childCommitIdentities).size !==
          receipt.childCommitIdentities.length ||
        receipt.childCommitIdentities.some(
          (identity, index) => identity !== sortedCommitIdentities[index],
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
          (identity, index) =>
            identity !== receipt.childCommitIdentities[index],
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
      checkpoint.loopState ?? {},
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
      checkpoint.interactionReceipts ?? {},
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
        .join("; ")}`,
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
        .join("; ")}`,
    );
  }
  return result.data as PipelineDefinition;
}
