/**
 * Strict reserve/settle/release/reconcile custody for predicate-loop
 * iterations.
 *
 * The byte and callback contracts are intentionally the same ones used by
 * `for_each`; only the deterministic identity scope differs (`iteration`
 * instead of `item`).
 */

import type {
  LoopNode,
  PipelineForEachItemEconomics,
  PipelineForEachItemOutcome,
  PipelineNode,
} from "@dzupagent/core/pipeline";
import type { NodeResult } from "@dzupagent/runtime-contracts";
import type { LoopEconomicsEvidenceV1 } from "@dzupagent/runtime-contracts/loop-economics-evidence";

import { validateLoopEconomicsBoundary } from "./economics-evidence.js";
import type {
  LoopIterationBudgetReservation,
  LoopBudgetReconcileOutcome,
  LoopResumeOptions,
} from "./types.js";

export interface HeldPredicateIterationReservation {
  readonly iteration: number;
  readonly reservationId: string;
  readonly reservedCostCents: number;
  readonly evidence?: LoopEconomicsEvidenceV1;
}

export type PredicateBudgetFailureReason =
  | "budget_unknown"
  | "budget_exceeded";

export interface PredicateBudgetFailure {
  readonly status: "blocked";
  readonly error: string;
  readonly reason: PredicateBudgetFailureReason;
}

export type PredicateBudgetAdmission =
  | { readonly status: "unpriced" }
  | {
      readonly status: "held";
      readonly held: HeldPredicateIterationReservation;
    }
  | {
      readonly status: "settled";
      readonly held: HeldPredicateIterationReservation;
      readonly settledCostCents: number;
      readonly evidence?: LoopEconomicsEvidenceV1;
    }
  | PredicateBudgetFailure;

export type PredicateBudgetSettlement =
  | {
      readonly status: "settled";
      readonly settledCostCents: number;
      readonly evidence?: LoopEconomicsEvidenceV1;
      readonly overrun?: string;
    }
  | PredicateBudgetFailure;

export type PredicateBudgetRelease =
  | { readonly status: "released" }
  | PredicateBudgetFailure;

type ReconciledReservation =
  | Exclude<LoopBudgetReconcileOutcome, { status: "unknown" | "conflict" }>
  | { status: "blocked"; error: string };

export function deriveIterationReservationId(params: {
  readonly runId?: string;
  readonly loopNodeId: string;
  readonly iteration: number;
}): string {
  const run = params.runId === undefined ? "" : params.runId;
  return `resv:v1:${run}:iteration:${params.loopNodeId}:${params.iteration}`;
}

export function validatePredicateBudgetHost(
  loopNode: LoopNode,
  resume: LoopResumeOptions | undefined
): string | undefined {
  const budgetCents = loopNode.typedWhile?.iterationBudgetCents;
  if (budgetCents === undefined) return undefined;
  if (
    resume?.budgetMode !== "strict" ||
    !Number.isSafeInteger(budgetCents) ||
    budgetCents < 0 ||
    resume.reserveIterationBudget === undefined ||
    resume.settleIterationBudget === undefined ||
    resume.releaseIterationBudget === undefined ||
    resume.reconcileIterationBudget === undefined ||
    resume.measureItemCost === undefined
  ) {
    return (
      `Loop "${loopNode.id}" hard iteration ceiling requires a strict budget ` +
      "host with a non-negative integer ceiling and reserve/settle/" +
      "release/reconcile/measureItemCost lifecycle"
    );
  }
  return undefined;
}

export async function admitPredicateIteration(input: {
  readonly loopNode: LoopNode;
  readonly bodyNodes: readonly PipelineNode[];
  readonly state: Readonly<Record<string, unknown>>;
  readonly resume: LoopResumeOptions | undefined;
  readonly iteration: number;
  readonly completedIterations: number;
  readonly bodyComplete: boolean;
  readonly retainedOutcome?: PipelineForEachItemOutcome;
  readonly retainedEconomics?: PipelineForEachItemEconomics;
}): Promise<PredicateBudgetAdmission> {
  const budgetCents = input.loopNode.typedWhile?.iterationBudgetCents;
  if (budgetCents === undefined) return { status: "unpriced" };

  const reservationId = deriveIterationReservationId({
    ...(input.resume?.budgetRunId === undefined
      ? {}
      : { runId: input.resume.budgetRunId }),
    loopNodeId: input.loopNode.id,
    iteration: input.iteration,
  });

  if (
    (input.retainedOutcome === undefined) !==
    (input.retainedEconomics === undefined)
  ) {
    return blocked(
      input.loopNode,
      input.iteration,
      "checkpoint carries incomplete predicate-loop reservation bytes"
    );
  }

  if (input.retainedEconomics !== undefined) {
    const economicsError = validateRetainedEconomics(
      input.loopNode,
      input.iteration,
      reservationId,
      budgetCents,
      input.retainedEconomics,
      input.bodyNodes,
      input.resume,
      input.retainedOutcome,
      input.bodyComplete
    );
    if (economicsError !== undefined) return economicsError;

    const held: HeldPredicateIterationReservation = {
      iteration: input.iteration,
      reservationId,
      reservedCostCents: input.retainedEconomics.reservedCostCents,
      ...(input.retainedEconomics.evidence === undefined
        ? {}
        : { evidence: input.retainedEconomics.evidence }),
    };
    if (
      input.retainedOutcome === "failed" ||
      input.retainedOutcome === "cancelled" ||
      input.retainedOutcome === "denied"
    ) {
      return blocked(
        input.loopNode,
        input.iteration,
        `checkpoint marks the iteration ${input.retainedOutcome}; redispatch is blocked`
      );
    }
    if (input.retainedOutcome === "completed") {
      if (!input.bodyComplete) {
        return blocked(
          input.loopNode,
          input.iteration,
          "checkpoint reports settled completion before the body-complete cursor"
        );
      }
      return {
        status: "settled",
        held,
        settledCostCents: input.retainedEconomics.settledCostCents as number,
        ...(input.retainedEconomics.evidence === undefined
          ? {}
          : { evidence: input.retainedEconomics.evidence }),
      };
    }

    const reconciliation = await reconcileReservation({
      loopNode: input.loopNode,
      resume: input.resume,
      held,
      bodyNodes: input.bodyNodes,
      budgetCents,
      boundary: input.bodyComplete ? "settle" : "reserve",
      reason: "resume of a durable predicate-loop iteration reservation",
    });
    if (reconciliation.status === "blocked") {
      return blocked(
        input.loopNode,
        input.iteration,
        reconciliation.error
      );
    }
    if (reconciliation.status === "settled") {
      const settled = readSettledCost(
        input.loopNode,
        input.iteration,
        reconciliation,
        input.bodyComplete ? "settle" : "reserve"
      );
      if ("error" in settled) {
        return blocked(input.loopNode, input.iteration, settled.error);
      }
      if (!input.bodyComplete) {
        return blocked(
          input.loopNode,
          input.iteration,
          `reservation was already charged ${settled.settledCostCents} cents before the retained body completed`
        );
      }
      return { status: "settled", held, ...settled };
    }
    if (reconciliation.status !== "reserved") {
      return blocked(
        input.loopNode,
        input.iteration,
        `reconciliation returned ${reconciliation.status}; retained body work cannot be redispatched`
      );
    }
    if (reconciliation.reservedCostCents !== held.reservedCostCents) {
      return blocked(
        input.loopNode,
        input.iteration,
        "reconciliation disagreed with the durable reservation amount"
      );
    }
    const evidenceError = validateLoopEconomicsBoundary({
      evidenceMode: input.resume?.budgetEvidenceMode,
      evidence: reconciliation.evidence,
      runId: input.resume?.budgetRunId,
      loopNodeId: input.loopNode.id,
      reservationId,
      iteration: input.iteration,
      reservedCostCents: reconciliation.reservedCostCents,
      terminalStatus: "pending",
      ...(held.evidence === undefined
        ? {}
        : {
            currentReservationBindingDigest:
              held.evidence.reservationBindingDigest,
          }),
    });
    if (evidenceError !== undefined) {
      return blocked(
        input.loopNode,
        input.iteration,
        `reconciliation returned invalid exact economics evidence: ${evidenceError}`
      );
    }
    if (reconciliation.evidence !== undefined) {
      return {
        status: "held",
        held: { ...held, evidence: reconciliation.evidence },
      };
    }
    return { status: "held", held };
  }

  let reservation: LoopIterationBudgetReservation;
  let unobservedReason: string | undefined;
  try {
    reservation = await input.resume!.reserveIterationBudget!({
      loopNodeId: input.loopNode.id,
      iteration: input.iteration,
      budgetCents,
      bodyNodeIds: input.bodyNodes.map(({ id }) => id),
      state: input.state,
      reservationId,
    });
  } catch (error) {
    reservation = { status: "unknown" };
    unobservedReason = error instanceof Error ? error.message : String(error);
  }

  if (reservation.status === "unknown") {
    const reconciled = await reconcileUnknownFreshReserve({
      loopNode: input.loopNode,
      resume: input.resume,
      iteration: input.iteration,
      completedIterations: input.completedIterations,
      bodyNodes: input.bodyNodes,
      reservationId,
      budgetCents,
      reason:
        unobservedReason ??
        "the strict host answered that reservation authority is unknown",
    });
    return reconciled;
  }

  if (
    !Number.isSafeInteger(reservation.reservedCostCents) ||
    reservation.reservedCostCents < 0
  ) {
    return reconcileMalformedFreshReserve({
      loopNode: input.loopNode,
      resume: input.resume,
      iteration: input.iteration,
      completedIterations: input.completedIterations,
      bodyNodes: input.bodyNodes,
      reservationId,
      budgetCents,
      malformedCost: reservation.reservedCostCents,
    });
  }

  const held: HeldPredicateIterationReservation = {
    iteration: input.iteration,
    reservationId,
    reservedCostCents: reservation.reservedCostCents,
    ...(reservation.evidence === undefined
      ? {}
      : { evidence: reservation.evidence }),
  };
  const evidenceError = validateLoopEconomicsBoundary({
    evidenceMode: input.resume?.budgetEvidenceMode,
    evidence: reservation.evidence,
    runId: input.resume?.budgetRunId,
    loopNodeId: input.loopNode.id,
    reservationId,
    iteration: input.iteration,
    reservedCostCents: reservation.reservedCostCents,
    terminalStatus: "pending",
    expectedNodeIds: input.bodyNodes.map(({ id }) => id),
    requiredExecutionNodeIds: input.bodyNodes
      .filter(({ type }) => type === "agent")
      .map(({ id }) => id),
  });
  if (evidenceError !== undefined) {
    try {
      await input.resume!.releaseIterationBudget!({
        loopNodeId: input.loopNode.id,
        iteration: input.iteration,
        reservationId,
        reservedCostCents: reservation.reservedCostCents,
        reason: "failed",
        ...(reservation.evidence === undefined
          ? {}
          : { evidence: reservation.evidence }),
      });
    } catch (error) {
      return blocked(
        input.loopNode,
        input.iteration,
        `returned invalid exact economics evidence and its hold could not be released: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return blocked(
      input.loopNode,
      input.iteration,
      `returned invalid exact economics evidence and its hold was released: ${evidenceError}`
    );
  }
  if (held.reservedCostCents > budgetCents) {
    const released = await releasePredicateIteration({
      loopNode: input.loopNode,
      resume: input.resume,
      completedIterations: input.completedIterations,
      held,
      outcome: "denied",
      reason: "failed",
    });
    if (released.status === "blocked") return released;
    return {
      status: "blocked",
      reason: "budget_exceeded",
      error:
        `Loop "${input.loopNode.id}" iteration ${input.iteration} reservation ` +
        `${held.reservedCostCents} cents exceeds the ${budgetCents}-cent ` +
        "ceiling and was released",
    };
  }

  await checkpointBudget(input.resume, input.completedIterations, "reserved", held);
  return { status: "held", held };
}

export async function settlePredicateIteration(input: {
  readonly loopNode: LoopNode;
  readonly resume: LoopResumeOptions | undefined;
  readonly completedIterations: number;
  readonly held: HeldPredicateIterationReservation;
  readonly bodyResults: Readonly<Record<string, NodeResult>>;
}): Promise<PredicateBudgetSettlement> {
  let cost;
  try {
    cost = await input.resume!.measureItemCost!({
      loopNodeId: input.loopNode.id,
      iteration: input.held.iteration,
      reservationId: input.held.reservationId,
      bodyResults: input.bodyResults,
      ...(input.held.evidence === undefined
        ? {}
        : { evidence: input.held.evidence }),
    });
  } catch (error) {
    cost = {
      status: "unknown" as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (cost.status === "unknown") {
    await checkpointBudget(
      input.resume,
      input.completedIterations,
      "outcome_unknown",
      input.held
    );
    return blocked(
      input.loopNode,
      input.held.iteration,
      `usage/cost is unknown; settlement was not attempted: ${cost.reason ?? "no reason"}`
    );
  }
  const actualCostCents = cost.costCents;
  if (!Number.isSafeInteger(actualCostCents) || actualCostCents < 0) {
    await checkpointBudget(
      input.resume,
      input.completedIterations,
      "outcome_unknown",
      input.held
    );
    return blocked(
      input.loopNode,
      input.held.iteration,
      `host reported invalid actual cost ${String(actualCostCents)}`
    );
  }
  const evidenceError = validateLoopEconomicsBoundary({
    evidenceMode: input.resume?.budgetEvidenceMode,
    evidence: cost.evidence,
    runId: input.resume?.budgetRunId,
    loopNodeId: input.loopNode.id,
    reservationId: input.held.reservationId,
    iteration: input.held.iteration,
    reservedCostCents: input.held.reservedCostCents,
    settledCostCents: actualCostCents,
    terminalStatus: "recorded",
    ...(input.held.evidence === undefined
      ? {}
      : {
          currentReservationBindingDigest:
            input.held.evidence.reservationBindingDigest,
        }),
  });
  if (evidenceError !== undefined) {
    await checkpointBudget(
      input.resume,
      input.completedIterations,
      "outcome_unknown",
      input.held
    );
    return blocked(
      input.loopNode,
      input.held.iteration,
      `terminal exact economics evidence is invalid; settlement was not attempted: ${evidenceError}`
    );
  }

  let settledCostCents: number;
  try {
    await input.resume!.settleIterationBudget!({
      loopNodeId: input.loopNode.id,
      iteration: input.held.iteration,
      reservationId: input.held.reservationId,
      reservedCostCents: input.held.reservedCostCents,
      actualCostCents,
      ...(cost.evidence === undefined ? {} : { evidence: cost.evidence }),
    });
    settledCostCents = actualCostCents;
  } catch (error) {
    const resolution = await resolveUnknownSettlement({
      loopNode: input.loopNode,
      resume: input.resume,
      held: input.held,
      budgetCents: input.loopNode.typedWhile!.iterationBudgetCents as number,
      actualCostCents,
      ...(cost.evidence === undefined
        ? {}
        : { terminalEvidence: cost.evidence }),
      reason: error instanceof Error ? error.message : String(error),
    });
    if (resolution.status === "blocked") {
      await checkpointBudget(
        input.resume,
        input.completedIterations,
        "outcome_unknown",
        input.held
      );
      return resolution;
    }
    settledCostCents = resolution.settledCostCents;
  }

  return settledCostCents > input.held.reservedCostCents
    ? {
        status: "settled",
        settledCostCents,
        ...(cost.evidence === undefined ? {} : { evidence: cost.evidence }),
        overrun:
          `Loop "${input.loopNode.id}" iteration ${input.held.iteration} ` +
          `settled ${settledCostCents} cents, exceeding its ` +
          `${input.held.reservedCostCents}-cent reservation`,
      }
    : {
        status: "settled",
        settledCostCents,
        ...(cost.evidence === undefined ? {} : { evidence: cost.evidence }),
      };
}

export async function releasePredicateIteration(input: {
  readonly loopNode: LoopNode;
  readonly resume: LoopResumeOptions | undefined;
  readonly completedIterations: number;
  readonly held: HeldPredicateIterationReservation;
  readonly outcome: Extract<
    PipelineForEachItemOutcome,
    "failed" | "cancelled" | "denied"
  >;
  readonly reason: "aborted" | "failed";
}): Promise<PredicateBudgetRelease> {
  let releaseError: string | undefined;
  try {
    await input.resume!.releaseIterationBudget!({
      loopNodeId: input.loopNode.id,
      iteration: input.held.iteration,
      reservationId: input.held.reservationId,
      reservedCostCents: input.held.reservedCostCents,
      reason: input.reason,
      ...(input.held.evidence === undefined
        ? {}
        : { evidence: input.held.evidence }),
    });
  } catch (error) {
    releaseError = error instanceof Error ? error.message : String(error);
  }

  if (releaseError !== undefined) {
    const resolved = await resolveUnknownRelease({
      loopNode: input.loopNode,
      resume: input.resume,
      held: input.held,
      budgetCents: input.loopNode.typedWhile!.iterationBudgetCents as number,
      releaseReason: input.reason,
      reason: releaseError,
    });
    if (resolved.status === "blocked") {
      await checkpointBudget(
        input.resume,
        input.completedIterations,
        "outcome_unknown",
        input.held
      );
      return resolved;
    }
  }

  await checkpointBudget(
    input.resume,
    input.completedIterations,
    input.outcome,
    input.held
  );
  return { status: "released" };
}

export async function checkpointSettledPredicateIteration(input: {
  readonly resume: LoopResumeOptions | undefined;
  readonly completedIterations: number;
  readonly outcome: Extract<PipelineForEachItemOutcome, "completed" | "failed">;
  readonly held: HeldPredicateIterationReservation;
  readonly settledCostCents: number;
  readonly evidence?: LoopEconomicsEvidenceV1;
}): Promise<void> {
  await checkpointBudget(
    input.resume,
    input.completedIterations,
    input.outcome,
    input.held,
    input.settledCostCents,
    input.evidence
  );
}

function validateRetainedEconomics(
  loopNode: LoopNode,
  iteration: number,
  expectedReservationId: string,
  budgetCents: number,
  economics: PipelineForEachItemEconomics,
  bodyNodes: readonly PipelineNode[],
  resume: LoopResumeOptions | undefined,
  retainedOutcome: PipelineForEachItemOutcome | undefined,
  bodyComplete: boolean
): PredicateBudgetFailure | undefined {
  if (economics.reservationId !== expectedReservationId) {
    return blocked(
      loopNode,
      iteration,
      `checkpoint reservation ${economics.reservationId} does not match ` +
        `the deterministic owner ${expectedReservationId}`
    );
  }
  if (
    !Number.isSafeInteger(economics.reservedCostCents) ||
    economics.reservedCostCents < 0 ||
    economics.reservedCostCents > budgetCents
  ) {
    return blocked(
      loopNode,
      iteration,
      `checkpoint carries invalid reserved cost ${String(economics.reservedCostCents)}`
    );
  }
  if (
    economics.settledCostCents !== undefined &&
    (!Number.isSafeInteger(economics.settledCostCents) ||
      economics.settledCostCents < 0)
  ) {
    return blocked(
      loopNode,
      iteration,
      `checkpoint carries invalid settled cost ${String(economics.settledCostCents)}`
    );
  }
  const evidenceError = validateLoopEconomicsBoundary({
    evidenceMode: resume?.budgetEvidenceMode,
    evidence: economics.evidence,
    runId: resume?.budgetRunId,
    loopNodeId: loopNode.id,
    reservationId: economics.reservationId,
    iteration,
    reservedCostCents: economics.reservedCostCents,
    ...(economics.settledCostCents === undefined
      ? {}
      : { settledCostCents: economics.settledCostCents }),
    terminalStatus:
      retainedOutcome === "completed" && bodyComplete
        ? "recorded"
        : "pending",
    expectedNodeIds: bodyNodes.map(({ id }) => id),
    requiredExecutionNodeIds: bodyNodes
      .filter(({ type }) => type === "agent")
      .map(({ id }) => id),
  });
  if (evidenceError !== undefined) {
    return blocked(
      loopNode,
      iteration,
      `checkpoint exact economics evidence is invalid: ${evidenceError}`
    );
  }
  return undefined;
}

async function reconcileUnknownFreshReserve(input: {
  readonly loopNode: LoopNode;
  readonly resume: LoopResumeOptions | undefined;
  readonly iteration: number;
  readonly completedIterations: number;
  readonly bodyNodes: readonly PipelineNode[];
  readonly reservationId: string;
  readonly budgetCents: number;
  readonly reason: string;
}): Promise<PredicateBudgetFailure> {
  const reconciliation = await reconcileReservation({
    loopNode: input.loopNode,
    resume: input.resume,
    held: {
      iteration: input.iteration,
      reservationId: input.reservationId,
      reservedCostCents: 0,
    },
    bodyNodes: input.bodyNodes,
    budgetCents: input.budgetCents,
    boundary: "reserve",
    reason: input.reason,
  });
  if (reconciliation.status === "reserved") {
    if (
      !Number.isSafeInteger(reconciliation.reservedCostCents) ||
      reconciliation.reservedCostCents < 0 ||
      reconciliation.reservedCostCents > input.budgetCents
    ) {
      return blocked(
        input.loopNode,
        input.iteration,
        `reserve reconciliation reported invalid hold ${String(reconciliation.reservedCostCents)}`
      );
    }
    const held = {
      iteration: input.iteration,
      reservationId: input.reservationId,
      reservedCostCents: reconciliation.reservedCostCents,
      ...(reconciliation.evidence === undefined
        ? {}
        : { evidence: reconciliation.evidence }),
    };
    const released = await releasePredicateIteration({
      loopNode: input.loopNode,
      resume: input.resume,
      completedIterations: input.completedIterations,
      held,
      outcome: "denied",
      reason: "failed",
    });
    if (released.status === "blocked") return released;
  } else if (reconciliation.status === "settled") {
    const settled = readSettledCost(
      input.loopNode,
      input.iteration,
      reconciliation,
      "reserve"
    );
    return blocked(
      input.loopNode,
      input.iteration,
      "error" in settled
        ? settled.error
        : `was charged ${settled.settledCostCents} cents before body admission`
    );
  } else if (reconciliation.status === "blocked") {
    return blocked(input.loopNode, input.iteration, reconciliation.error);
  }
  return {
    status: "blocked",
    reason: "budget_unknown",
    error:
      `Loop "${input.loopNode.id}" iteration ${input.iteration} budget is ` +
      `unknown: reservation was reconciled as ${reconciliation.status}; ` +
      "body dispatch is denied",
  };
}

async function reconcileMalformedFreshReserve(input: {
  readonly loopNode: LoopNode;
  readonly resume: LoopResumeOptions | undefined;
  readonly iteration: number;
  readonly completedIterations: number;
  readonly bodyNodes: readonly PipelineNode[];
  readonly reservationId: string;
  readonly budgetCents: number;
  readonly malformedCost: number;
}): Promise<PredicateBudgetFailure> {
  const reconciliation = await reconcileReservation({
    loopNode: input.loopNode,
    resume: input.resume,
    held: {
      iteration: input.iteration,
      reservationId: input.reservationId,
      reservedCostCents: 0,
    },
    bodyNodes: input.bodyNodes,
    budgetCents: input.budgetCents,
    boundary: "reserve",
    reason: `host returned malformed reserved cost ${String(input.malformedCost)}`,
  });
  if (reconciliation.status === "reserved") {
    if (
      Number.isSafeInteger(reconciliation.reservedCostCents) &&
      reconciliation.reservedCostCents >= 0
    ) {
      const held = {
        iteration: input.iteration,
        reservationId: input.reservationId,
        reservedCostCents: reconciliation.reservedCostCents,
        ...(reconciliation.evidence === undefined
          ? {}
          : { evidence: reconciliation.evidence }),
      };
      const released = await releasePredicateIteration({
        loopNode: input.loopNode,
        resume: input.resume,
        completedIterations: input.completedIterations,
        held,
        outcome: "denied",
        reason: "failed",
      });
      if (released.status === "blocked") return released;
    }
  }
  return blocked(
    input.loopNode,
    input.iteration,
    `reserve returned malformed evidence ${String(input.malformedCost)}; dispatch is denied`
  );
}

async function resolveUnknownSettlement(input: {
  readonly loopNode: LoopNode;
  readonly resume: LoopResumeOptions | undefined;
  readonly held: HeldPredicateIterationReservation;
  readonly budgetCents: number;
  readonly actualCostCents: number;
  readonly terminalEvidence?: LoopEconomicsEvidenceV1;
  readonly reason: string;
}): Promise<PredicateBudgetSettlement> {
  const interpret = async (
    reconciliation: ReconciledReservation,
    allowRetry: boolean
  ): Promise<PredicateBudgetSettlement> => {
    if (reconciliation.status === "blocked") {
      return blocked(
        input.loopNode,
        input.held.iteration,
        reconciliation.error
      );
    }
    if (reconciliation.status === "settled") {
      const settled = readSettledCost(
        input.loopNode,
        input.held.iteration,
        reconciliation,
        "settle"
      );
      return "error" in settled
        ? blocked(input.loopNode, input.held.iteration, settled.error)
        : { status: "settled", ...settled };
    }
    if (reconciliation.status !== "reserved") {
      return blocked(
        input.loopNode,
        input.held.iteration,
        `settlement was not applied: reconciliation returned ${reconciliation.status}; redispatch is blocked`
      );
    }
    if (reconciliation.reservedCostCents !== input.held.reservedCostCents) {
      return blocked(
        input.loopNode,
        input.held.iteration,
        "settle reconciliation disagreed with the durable reservation amount"
      );
    }
    if (!allowRetry) {
      return blocked(
        input.loopNode,
        input.held.iteration,
        "retried settlement remains held; outcome is still unknown"
      );
    }
    try {
      await input.resume!.settleIterationBudget!({
        loopNodeId: input.loopNode.id,
        iteration: input.held.iteration,
        reservationId: input.held.reservationId,
        reservedCostCents: input.held.reservedCostCents,
        actualCostCents: input.actualCostCents,
        ...(input.terminalEvidence === undefined
          ? {}
          : { evidence: input.terminalEvidence }),
      });
      return {
        status: "settled",
        settledCostCents: input.actualCostCents,
        ...(input.terminalEvidence === undefined
          ? {}
          : { evidence: input.terminalEvidence }),
      };
    } catch (error) {
      return interpret(
        await reconcileReservation({
          loopNode: input.loopNode,
          resume: input.resume,
          held: input.held,
          budgetCents: input.budgetCents,
          boundary: "settle",
          reason: error instanceof Error ? error.message : String(error),
        }),
        false
      );
    }
  };

  return interpret(
    await reconcileReservation({
      loopNode: input.loopNode,
      resume: input.resume,
      held: input.held,
      budgetCents: input.budgetCents,
      boundary: "settle",
      reason: input.reason,
      ...(input.held.evidence === undefined
        ? {}
        : { evidence: input.held.evidence }),
    }),
    true
  );
}

async function resolveUnknownRelease(input: {
  readonly loopNode: LoopNode;
  readonly resume: LoopResumeOptions | undefined;
  readonly held: HeldPredicateIterationReservation;
  readonly budgetCents: number;
  readonly releaseReason: "aborted" | "failed";
  readonly reason: string;
}): Promise<PredicateBudgetRelease> {
  const interpret = async (
    reconciliation: ReconciledReservation,
    allowRetry: boolean
  ): Promise<PredicateBudgetRelease> => {
    if (reconciliation.status === "blocked") {
      return blocked(
        input.loopNode,
        input.held.iteration,
        reconciliation.error
      );
    }
    if (
      reconciliation.status === "released" ||
      reconciliation.status === "absent"
    ) {
      return { status: "released" };
    }
    if (reconciliation.status === "settled") {
      const settled = readSettledCost(
        input.loopNode,
        input.held.iteration,
        reconciliation,
        "release"
      );
      return blocked(
        input.loopNode,
        input.held.iteration,
        "error" in settled
          ? settled.error
          : `release reconciliation proves incomplete work was charged ${settled.settledCostCents} cents`
      );
    }
    if (reconciliation.reservedCostCents !== input.held.reservedCostCents) {
      return blocked(
        input.loopNode,
        input.held.iteration,
        "release reconciliation disagreed with the durable reservation amount"
      );
    }
    if (!allowRetry) {
      return blocked(
        input.loopNode,
        input.held.iteration,
        "retried release remains held; outcome is still unknown"
      );
    }
    try {
      await input.resume!.releaseIterationBudget!({
        loopNodeId: input.loopNode.id,
        iteration: input.held.iteration,
        reservationId: input.held.reservationId,
        reservedCostCents: input.held.reservedCostCents,
        reason: input.releaseReason,
        ...(input.held.evidence === undefined
          ? {}
          : { evidence: input.held.evidence }),
      });
      return { status: "released" };
    } catch (error) {
      return interpret(
        await reconcileReservation({
          loopNode: input.loopNode,
          resume: input.resume,
          held: input.held,
          budgetCents: input.budgetCents,
          boundary: "release",
          reason: error instanceof Error ? error.message : String(error),
        }),
        false
      );
    }
  };

  return interpret(
    await reconcileReservation({
      loopNode: input.loopNode,
      resume: input.resume,
      held: input.held,
      budgetCents: input.budgetCents,
      boundary: "release",
      reason: input.reason,
      ...(input.held.evidence === undefined
        ? {}
        : { evidence: input.held.evidence }),
    }),
    true
  );
}

async function reconcileReservation(input: {
  readonly loopNode: LoopNode;
  readonly resume: LoopResumeOptions | undefined;
  readonly held: HeldPredicateIterationReservation;
  readonly bodyNodes?: readonly PipelineNode[];
  readonly budgetCents: number;
  readonly boundary: "reserve" | "settle" | "release";
  readonly reason: string;
}): Promise<ReconciledReservation> {
  const blockedMessage =
    `Loop "${input.loopNode.id}" iteration ${input.held.iteration} reservation ` +
    `${input.held.reservationId} is outcome-unknown after its ${input.boundary} ` +
    `could not be observed and was not reconciled: ${input.reason}`;
  try {
    const outcome = await input.resume!.reconcileIterationBudget!({
      loopNodeId: input.loopNode.id,
      iteration: input.held.iteration,
      reservationId: input.held.reservationId,
      budgetCents: input.budgetCents,
      boundary: input.boundary,
      reason: input.reason,
      ...(input.held.evidence === undefined
        ? {}
        : { evidence: input.held.evidence }),
    });
    if (outcome.status === "unknown") {
      return { status: "blocked", error: blockedMessage };
    }
    if (outcome.status === "conflict") {
      return {
        status: "blocked",
        error:
          `Loop "${input.loopNode.id}" iteration ${input.held.iteration} ` +
          `reservation ${input.held.reservationId} is held by another writer ` +
          `"${outcome.heldBy}" after its ${input.boundary}: ${input.reason}`,
      };
    }
    if (outcome.status === "reserved") {
      const evidenceError = validateLoopEconomicsBoundary({
        evidenceMode: input.resume?.budgetEvidenceMode,
        evidence: outcome.evidence,
        runId: input.resume?.budgetRunId,
        loopNodeId: input.loopNode.id,
        reservationId: input.held.reservationId,
        iteration: input.held.iteration,
        reservedCostCents: outcome.reservedCostCents,
        terminalStatus: "pending",
        ...(input.bodyNodes === undefined
          ? {}
          : {
              expectedNodeIds: input.bodyNodes.map(({ id }) => id),
              requiredExecutionNodeIds: input.bodyNodes
                .filter(({ type }) => type === "agent")
                .map(({ id }) => id),
            }),
        ...(input.held.evidence === undefined
          ? {}
          : {
              currentReservationBindingDigest:
                input.held.evidence.reservationBindingDigest,
            }),
      });
      if (evidenceError !== undefined) {
        return {
          status: "blocked",
          error: `reconciliation returned invalid exact economics evidence: ${evidenceError}`,
        };
      }
    }
    if (outcome.status === "settled" && outcome.cost.status === "known") {
      const evidenceError = validateLoopEconomicsBoundary({
        evidenceMode: input.resume?.budgetEvidenceMode,
        evidence: outcome.cost.evidence,
        runId: input.resume?.budgetRunId,
        loopNodeId: input.loopNode.id,
        reservationId: input.held.reservationId,
        iteration: input.held.iteration,
        reservedCostCents: input.held.reservedCostCents,
        settledCostCents: outcome.cost.costCents,
        terminalStatus: "recorded",
        ...(input.held.evidence === undefined
          ? {}
          : {
              currentReservationBindingDigest:
                input.held.evidence.reservationBindingDigest,
            }),
      });
      if (evidenceError !== undefined) {
        return {
          status: "blocked",
          error: `settlement reconciliation returned invalid exact economics evidence: ${evidenceError}`,
        };
      }
    }
    return outcome;
  } catch (error) {
    return {
      status: "blocked",
      error:
        `${blockedMessage} (reconciliation failed: ` +
        `${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

function readSettledCost(
  loopNode: LoopNode,
  iteration: number,
  outcome: Extract<LoopBudgetReconcileOutcome, { status: "settled" }>,
  boundary: "reserve" | "settle" | "release"
):
  | { settledCostCents: number; evidence?: LoopEconomicsEvidenceV1 }
  | { error: string } {
  if (outcome.cost.status === "unknown") {
    return {
      error:
        `Loop "${loopNode.id}" iteration ${iteration} reconciliation after ` +
        `${boundary} reported settled usage/cost as unknown: ` +
        `${outcome.cost.reason ?? "no reason"}`,
    };
  }
  if (
    !Number.isSafeInteger(outcome.cost.costCents) ||
    outcome.cost.costCents < 0
  ) {
    return {
      error:
        `Loop "${loopNode.id}" iteration ${iteration} reconciliation after ` +
        `${boundary} reported invalid settled cost ${String(outcome.cost.costCents)}`,
    };
  }
  return {
    settledCostCents: outcome.cost.costCents,
    ...(outcome.cost.evidence === undefined
      ? {}
      : { evidence: outcome.cost.evidence }),
  };
}

async function checkpointBudget(
  resume: LoopResumeOptions | undefined,
  completedIterations: number,
  outcome: PipelineForEachItemOutcome,
  held: HeldPredicateIterationReservation,
  settledCostCents?: number,
  evidence?: LoopEconomicsEvidenceV1
): Promise<void> {
  await resume?.onIterationBudgetCheckpoint?.({
    completedIterations,
    outcome,
    economics: {
      reservationId: held.reservationId,
      reservedCostCents: held.reservedCostCents,
      ...(settledCostCents === undefined ? {} : { settledCostCents }),
      ...((evidence ?? held.evidence) === undefined
        ? {}
        : { evidence: evidence ?? held.evidence }),
    },
  });
}

function blocked(
  loopNode: LoopNode,
  iteration: number,
  detail: string,
  reason: PredicateBudgetFailureReason = "budget_unknown"
): PredicateBudgetFailure {
  return {
    status: "blocked",
    reason,
    error: `Loop "${loopNode.id}" iteration ${iteration} ${detail}`,
  };
}
