import type {
  GateNode,
  PipelineCheckpoint,
  PipelineDefinition,
  PipelineNode,
  SuspendNode,
} from "@dzupagent/core/pipeline";
import {
  createPipelinePendingInteractionV1,
  digestPipelineDefinition,
  validatePipelinePendingInteractionV1,
  type PipelineInteractionScopeV1,
  type PipelineInteractionSpecV1,
  type PipelinePendingInteractionV1,
} from "@dzupagent/runtime-contracts";

export type PipelineInteractionRuntimeErrorCode =
  | "INVALID_PENDING_INTERACTION"
  | "INTERACTION_BINDING_MISMATCH"
  | "INTERACTION_EXPIRED"
  | "INTERACTION_RECEIPT_CONFLICT"
  | "INTERACTION_NOT_PENDING"
  | "INTERACTION_SUCCESSOR_INVALID";

export class PipelineInteractionRuntimeError extends Error {
  constructor(
    readonly code: PipelineInteractionRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PipelineInteractionRuntimeError";
  }
}

export function interactionSpecForNode(
  node: PipelineNode | undefined,
): PipelineInteractionSpecV1 | undefined {
  if (node?.type === "gate") return (node as GateNode).interaction;
  if (node?.type === "suspend") return (node as SuspendNode).interaction;
  return undefined;
}

export function createRuntimePendingInteraction(input: {
  definition: PipelineDefinition;
  runId: string;
  node: PipelineNode;
  scope: PipelineInteractionScopeV1;
  occurrence: number;
  expectedCheckpointVersion: number;
  ttlMs?: number;
  now?: () => Date;
}): PipelinePendingInteractionV1 {
  const spec = interactionSpecForNode(input.node);
  if (spec === undefined) {
    throw new PipelineInteractionRuntimeError(
      "INVALID_PENDING_INTERACTION",
      `Node "${input.node.id}" has no canonical interaction specification.`,
    );
  }
  const ttlMs = input.ttlMs ?? 86_400_000;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 2_592_000_000) {
    throw new PipelineInteractionRuntimeError(
      "INVALID_PENDING_INTERACTION",
      "Interaction ttlMs must be a positive integer no greater than 30 days.",
    );
  }
  const now = input.now?.() ?? new Date();
  return createPipelinePendingInteractionV1({
    kind: spec.kind,
    definitionDigest: digestPipelineDefinition(input.definition),
    pipelineId: input.definition.id,
    runId: input.runId,
    nodeId: input.node.id,
    scope: input.scope,
    occurrence: input.occurrence,
    expectedCheckpointVersion: input.expectedCheckpointVersion,
    requestDigest: spec.requestDigest,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

export function validatePendingInteractionForDefinition(
  definition: PipelineDefinition,
  checkpoint: PipelineCheckpoint,
): { pending: PipelinePendingInteractionV1; spec: PipelineInteractionSpecV1 } {
  const pending = checkpoint.pendingInteraction;
  if (pending === undefined) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_NOT_PENDING",
      "The checkpoint has no pending interaction.",
    );
  }
  const validation = validatePipelinePendingInteractionV1(pending);
  if (!validation.valid) {
    throw new PipelineInteractionRuntimeError(
      "INVALID_PENDING_INTERACTION",
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    );
  }
  const node = definition.nodes.find((candidate) => candidate.id === pending.nodeId);
  const spec = interactionSpecForNode(node);
  if (
    pending.pipelineId !== definition.id ||
    pending.runId !== checkpoint.pipelineRunId ||
    pending.expectedCheckpointVersion !== checkpoint.version ||
    pending.definitionDigest !== digestPipelineDefinition(definition) ||
    spec === undefined ||
    spec.kind !== pending.kind ||
    spec.requestDigest !== pending.requestDigest
  ) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_BINDING_MISMATCH",
      "The pending interaction does not match the exact definition/checkpoint binding.",
    );
  }
  if (pending.scope.kind === "pipeline") {
    if (checkpoint.suspendedAtNodeId !== pending.nodeId) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        "Pipeline interaction node does not match the suspension marker.",
      );
    }
  } else {
    const loop = checkpoint.loopState?.[pending.scope.loopNodeId];
    if (
      checkpoint.suspendedAtNodeId !== pending.scope.loopNodeId ||
      loop?.iteration !== pending.scope.iteration ||
      loop.bodyGraphState?.outcome?.kind !== "suspended" ||
      loop.bodyGraphState.outcome.exitNodeId !== pending.nodeId
    ) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        "Loop interaction does not match the retained loop suspension cursor.",
      );
    }
  }
  return { pending, spec };
}

export function assertInteractionNotExpired(
  pending: PipelinePendingInteractionV1,
  now: Date,
): void {
  if (now.getTime() > Date.parse(pending.expiresAt)) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_EXPIRED",
      `Interaction "${pending.interactionId}" has expired.`,
    );
  }
}
