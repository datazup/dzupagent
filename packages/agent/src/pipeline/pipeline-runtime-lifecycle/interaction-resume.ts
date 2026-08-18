import type { PipelineCheckpoint, PipelineNode } from "@dzupagent/core/pipeline";
import {
  digestPipelineDefinition,
  validatePipelineInteractionResumeV1,
  type PipelineInteractionResumeV1,
} from "@dzupagent/runtime-contracts";

import type { BudgetTrackerState } from "../pipeline-runtime/iteration-budget-tracker.js";
import { restoreBudgetTrackerState } from "../pipeline-runtime/iteration-budget-tracker.js";
import { pipelineCompletedEvent, pipelineStartedEvent } from "../pipeline-runtime/runtime-events.js";
import { writeCheckpoint } from "../pipeline-runtime/checkpoint-writer.js";
import type { NodeResult, PipelineRunContext, PipelineRunResult, PipelineRuntimeConfig, PipelineRuntimeEvent, PipelineState } from "../pipeline-runtime-types.js";
import { restoreRunContextFromCheckpoint } from "./resume-orchestrator.js";
import { assertInteractionNotExpired, interactionSpecForNode, PipelineInteractionRuntimeError, validatePendingInteractionForDefinition } from "../pipeline-interaction-runtime.js";

export interface InteractionResumeHost {
  readonly config: PipelineRuntimeConfig;
  readonly nodeMap: ReadonlyMap<string, PipelineNode>;
  readonly eventLog: PipelineRuntimeEvent[];
  assertDefinitionValid(): void;
  getNextNodeIds(nodeId: string, runState: Record<string, unknown>): string[];
  runFromNode(ctx: PipelineRunContext): Promise<PipelineRunResult>;
  resumeFromCheckpoint(checkpoint: PipelineCheckpoint): Promise<PipelineRunResult>;
  emit(event: PipelineRuntimeEvent): void;
  setState(state: PipelineState): void;
  setRecoveryAttemptsUsed(count: number): void;
  setBudgetTracker(state: BudgetTrackerState): void;
  getRecoveryAttemptsUsed(): number;
  getBudgetTracker(): BudgetTrackerState;
}

export async function resumePipelineInteraction(
host: InteractionResumeHost,
checkpoint: PipelineCheckpoint,
receipt: PipelineInteractionResumeV1,
): Promise<PipelineRunResult> {
  host.assertDefinitionValid();
  const standalone = validatePipelineInteractionResumeV1(receipt);
  if (!standalone.valid) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_BINDING_MISMATCH",
      standalone.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; "),
    );
  }

  const store = host.config.checkpointStore;
  const loaded = await store?.load(checkpoint.pipelineRunId);
  if (store !== undefined && loaded === undefined) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_BINDING_MISMATCH",
      "The authoritative latest checkpoint is missing or corrupt.",
    );
  }
  const latest = loaded ?? checkpoint;
  if (
    latest.pipelineRunId !== checkpoint.pipelineRunId ||
    latest.pipelineId !== host.config.definition.id
  ) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_BINDING_MISMATCH",
      "The latest checkpoint does not belong to this pipeline run.",
    );
  }

  const existing = latest.interactionReceipts?.[receipt.interactionId];
  if (existing !== undefined) {
    if (existing.receiptHash !== receipt.receiptHash) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_RECEIPT_CONFLICT",
        `Interaction "${receipt.interactionId}" already has a different committed receipt.`,
      );
    }
    assertCommittedInteractionReceiptValid(host, latest, existing);
    if (latest.interactionResumeCursor !== undefined) {
      assertInteractionResumeCursorValid(host, latest);
      return host.resumeFromCheckpoint(latest);
    }
    if (latest.pendingInteraction !== undefined) {
      return host.resumeFromCheckpoint(latest);
    }
    if (existing.scope.kind === "pipeline") {
      return completedInteractionResult(host,
        latest.pipelineRunId,
        restoreRunContextFromCheckpoint(latest, undefined, {
          hydrateCompleted: true,
        }).nodeResults,
        Date.now(),
      );
    }
    return host.resumeFromCheckpoint(latest);
  }

  for (const committed of Object.values(latest.interactionReceipts ?? {})) {
    if (committed.receiptId === receipt.receiptId) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_RECEIPT_CONFLICT",
        `Receipt ID "${receipt.receiptId}" is already bound to another interaction.`,
      );
    }
  }

  const { pending, spec } = validatePendingInteractionForDefinition(
    host.config.definition,
    latest,
  );
  assertInteractionNotExpired(
    pending,
    host.config.interaction?.now?.() ?? new Date(),
  );
  const validation = validatePipelineInteractionResumeV1(receipt, {
    pending,
    spec,
  });
  if (!validation.valid) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_BINDING_MISMATCH",
      validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; "),
    );
  }

  const restored = restoreRunContextFromCheckpoint(latest, undefined, {
    hydrateCompleted: true,
  });
  const interactionNode = host.nodeMap.get(pending.nodeId);
  if (interactionNode === undefined) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_BINDING_MISMATCH",
      `Interaction node "${pending.nodeId}" is missing.`,
    );
  }

  const selectedNextNodeId =
    spec.kind === "approval" && receipt.response.kind === "approval"
      ? spec.outcomeToSuccessor[receipt.response.decision]
      : exactInteractionSuccessor(host, pending.nodeId, restored.runState);
  if (
    selectedNextNodeId !== undefined &&
    !host.nodeMap.has(selectedNextNodeId)
  ) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_SUCCESSOR_INVALID",
      `Interaction successor "${selectedNextNodeId}" is missing.`,
    );
  }

  const responseOutput =
    receipt.response.kind === "clarification"
      ? receipt.response.value
      : receipt.response;
  if (spec.kind === "clarification" && receipt.response.kind === "clarification") {
    restored.runState[spec.outputKey] = receipt.response.value;
  }

  if (pending.scope.kind === "pipeline") {
    if (!restored.completedNodeIds.includes(pending.nodeId)) {
      restored.completedNodeIds.push(pending.nodeId);
    }
    restored.nodeResults.set(pending.nodeId, {
      nodeId: pending.nodeId,
      output: responseOutput,
      durationMs: 0,
    });
  } else {
    const loop = restored.loopState[pending.scope.loopNodeId];
    const graph = loop?.bodyGraphState;
    if (
      loop === undefined ||
      graph === undefined ||
      graph.outcome?.kind !== "suspended" ||
      graph.outcome.exitNodeId !== pending.nodeId
    ) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        "The retained loop graph does not match the interaction receipt.",
      );
    }
    if (!graph.completedNodeIds.includes(pending.nodeId)) {
      graph.completedNodeIds.push(pending.nodeId);
    }
    graph.nodeResults[pending.nodeId] = {
      nodeId: pending.nodeId,
      output: responseOutput,
      durationMs: 0,
    };
    if (selectedNextNodeId === undefined) {
      graph.completed = true;
      delete graph.nextNodeId;
      graph.outcome = { kind: "normal", exitNodeId: pending.nodeId };
    } else {
      graph.completed = false;
      graph.nextNodeId = selectedNextNodeId;
      delete graph.outcome;
    }
  }

  restored.interactionReceipts[receipt.interactionId] = receipt;
  const cursor = {
    interactionId: receipt.interactionId,
    receiptHash: receipt.receiptHash,
    definitionDigest: receipt.definitionDigest,
    nodeId: receipt.nodeId,
    scope: receipt.scope,
    ...(selectedNextNodeId === undefined
      ? {}
      : { selectedSuccessorNodeId: selectedNextNodeId }),
    ...(pending.scope.kind === "pipeline"
      ? selectedNextNodeId === undefined
        ? {}
        : { nextNodeId: selectedNextNodeId }
      : { nextNodeId: pending.scope.loopNodeId }),
  } as const;
  delete restored.pendingInteraction;
  restored.interactionResumeCursor = cursor;
  const versionTracker = { version: latest.version };
  const committed = await writeCheckpoint({
    config: host.config,
    runId: restored.runId,
    runState: restored.runState,
    nodeResults: restored.nodeResults,
    completedNodeIds: restored.completedNodeIds,
    nodeIdempotencyKeys: restored.nodeIdempotencyKeys,
    loopState: restored.loopState,
    forkState: restored.forkState,
    recursiveForkCompletions: restored.recursiveForkCompletions,
    eventLog: host.eventLog,
    versionTracker,
    recoveryAttemptsUsed: latest.recoveryAttemptsUsed ?? 0,
    budgetTracker: restoreBudgetTrackerState(
      latest.budgetState?.costCents ?? 0,
      host.config.iterationBudget?.maxCostCents ?? 0,
    ),
    interactionReceipts: restored.interactionReceipts,
    interactionResumeCursor: cursor,
    emit: (event) => host.emit(event),
  });
  if (committed === undefined) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_BINDING_MISMATCH",
      "Interaction receipt could not be committed: no checkpoint store is " +
        "configured, or another writer committed a newer version for this run " +
        "first. Reload the run and retry the response against the current cursor.",
    );
  }
  host.setState("running");
  host.setRecoveryAttemptsUsed(committed.recoveryAttemptsUsed ?? 0);
  host.setBudgetTracker(restoreBudgetTrackerState(
    committed.budgetState?.costCents ?? 0,
    host.config.iterationBudget?.maxCostCents ?? 0,
  ));
  host.emit(pipelineStartedEvent(host.config.definition.id, restored.runId));
  const startTime = Date.now();
  const result = cursor.nextNodeId === undefined
    ? completedInteractionResult(host,
        restored.runId,
        restored.nodeResults,
        startTime,
      )
    : await host.runFromNode({
        startNodeId: cursor.nextNodeId,
        runId: restored.runId,
        runState: restored.runState,
        nodeResults: restored.nodeResults,
        completedNodeIds: restored.completedNodeIds,
        nodeIdempotencyKeys: restored.nodeIdempotencyKeys,
        loopState: restored.loopState,
        forkState: restored.forkState,
        recursiveForkCompletions: restored.recursiveForkCompletions,
        eventLog: host.eventLog,
        versionTracker,
        interactionReceipts: restored.interactionReceipts,
        interactionResumeCursor: cursor,
        startTime,
      });
  if (result.state === "completed") {
    restored.interactionResumeCursor = undefined;
    await writeCheckpoint({
      config: host.config,
      runId: restored.runId,
      runState: restored.runState,
      nodeResults: restored.nodeResults,
      completedNodeIds: restored.completedNodeIds,
      nodeIdempotencyKeys: restored.nodeIdempotencyKeys,
      loopState: restored.loopState,
      forkState: restored.forkState,
      recursiveForkCompletions: restored.recursiveForkCompletions,
      eventLog: host.eventLog,
      versionTracker,
      recoveryAttemptsUsed: host.getRecoveryAttemptsUsed(),
      budgetTracker: host.getBudgetTracker(),
      interactionReceipts: restored.interactionReceipts,
      emit: (event) => host.emit(event),
    });
  }
  return result;
}


function exactInteractionSuccessor(
host: InteractionResumeHost,
  nodeId: string,
  runState: Record<string, unknown>,
): string | undefined {
  const targets = host.getNextNodeIds(nodeId, runState);
  if (targets.length > 1) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_SUCCESSOR_INVALID",
      `Interaction node "${nodeId}" resolved ${targets.length} successors; at most one is allowed.`,
    );
  }
  return targets[0];
}

function assertCommittedInteractionReceiptValid(
host: InteractionResumeHost,
  checkpoint: PipelineCheckpoint,
  receipt: PipelineInteractionResumeV1,
): void {
  const validation = validatePipelineInteractionResumeV1(receipt);
  const node = host.nodeMap.get(receipt.nodeId);
  const spec = interactionSpecForNode(node);
  if (
    !validation.valid ||
    receipt.pipelineId !== host.config.definition.id ||
    receipt.runId !== checkpoint.pipelineRunId ||
    receipt.definitionDigest !== digestPipelineDefinition(host.config.definition) ||
    spec === undefined ||
    spec.kind !== receipt.response.kind ||
    spec.requestDigest !== receipt.requestDigest
  ) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_BINDING_MISMATCH",
      "The committed interaction receipt no longer matches the exact pipeline artifact.",
    );
  }
}

export function assertInteractionResumeCursorValid(
host: InteractionResumeHost,
  checkpoint: PipelineCheckpoint,
): void {
  const cursor = checkpoint.interactionResumeCursor;
  if (cursor === undefined) return;
  const receipt = checkpoint.interactionReceipts?.[cursor.interactionId];
  if (receipt === undefined) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_BINDING_MISMATCH",
      "The interaction resume cursor has no committed receipt.",
    );
  }
  assertCommittedInteractionReceiptValid(host, checkpoint, receipt);
  const spec = interactionSpecForNode(host.nodeMap.get(receipt.nodeId));
  if (spec === undefined) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_BINDING_MISMATCH",
      "The interaction resume cursor references a non-interaction node.",
    );
  }
  const selectedSuccessorNodeId =
    spec.kind === "approval" && receipt.response.kind === "approval"
      ? spec.outcomeToSuccessor[receipt.response.decision]
      : exactInteractionSuccessor(host, receipt.nodeId, checkpoint.state);
  const expectedNextNodeId = receipt.scope.kind === "pipeline"
    ? selectedSuccessorNodeId
    : receipt.scope.loopNodeId;
  let exactLoopCursor = true;
  if (receipt.scope.kind === "loop") {
    const loop = checkpoint.loopState?.[receipt.scope.loopNodeId];
    const graph = loop?.bodyGraphState;
    exactLoopCursor =
      loop?.iteration === receipt.scope.iteration &&
      graph !== undefined &&
      (selectedSuccessorNodeId === undefined
        ? graph.completed &&
          graph.outcome?.kind === "normal" &&
          graph.outcome.exitNodeId === receipt.nodeId
        : graph.completedNodeIds.includes(selectedSuccessorNodeId) ||
          (!graph.completed &&
            graph.outcome === undefined &&
            graph.nextNodeId === selectedSuccessorNodeId));
  }
  if (
    cursor.receiptHash !== receipt.receiptHash ||
    cursor.definitionDigest !== receipt.definitionDigest ||
    cursor.nodeId !== receipt.nodeId ||
    JSON.stringify(cursor.scope) !== JSON.stringify(receipt.scope) ||
    cursor.selectedSuccessorNodeId !== selectedSuccessorNodeId ||
    cursor.nextNodeId !== expectedNextNodeId ||
    !exactLoopCursor ||
    (selectedSuccessorNodeId !== undefined &&
      !host.nodeMap.has(selectedSuccessorNodeId)) ||
    (expectedNextNodeId !== undefined && !host.nodeMap.has(expectedNextNodeId))
  ) {
    throw new PipelineInteractionRuntimeError(
      "INTERACTION_BINDING_MISMATCH",
      "The interaction resume cursor does not match its receipt, artifact, and exact successor.",
    );
  }
}

function completedInteractionResult(
host: InteractionResumeHost,
  runId: string,
  nodeResults: Map<string, NodeResult>,
  startTime: number,
): PipelineRunResult {
  host.setState("completed");
  const durationMs = Date.now() - startTime;
  host.emit(pipelineCompletedEvent(runId, durationMs));
  return {
    pipelineId: host.config.definition.id,
    runId,
    state: "completed",
    nodeResults,
    totalDurationMs: durationMs,
  };
}
