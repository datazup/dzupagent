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

import type {
  LoopBudgetReconcileOutcome,
  LoopResumeOptions,
} from "./types.js";

export interface HeldPredicateIterationReservation {
  readonly iteration: number;
  readonly reservationId: string;
  readonly reservedCostCents: number;
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
    }
  | PredicateBudgetFailure;

export type PredicateBudgetSettlement =
  | {
      readonly status: "settled";
      readonly settledCostCents: number;
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
      input.retainedEconomics
    );
    if (economicsError !== undefined) return economicsError;

    const held: HeldPredicateIterationReservation = {
      iteration: input.iteration,
      reservationId,
      reservedCostCents: input.retainedEconomics.reservedCostCents,
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
      };
    }

    const reconciliation = await reconcileReservation({
      loopNode: input.loopNode,
      resume: input.resume,
      held,
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
    return { status: "held", held };
  }

  let reservation:
    | { status: "reserved"; reservedCostCents: number }
    | { status: "unknown" };
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
      reservationId,
      budgetCents,
      malformedCost: reservation.reservedCostCents,
    });
  }

  const held: HeldPredicateIterationReservation = {
    iteration: input.iteration,
    reservationId,
    reservedCostCents: reservation.reservedCostCents,
  };
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

  let settledCostCents: number;
  try {
    await input.resume!.settleIterationBudget!({
      loopNodeId: input.loopNode.id,
      iteration: input.held.iteration,
      reservationId: input.held.reservationId,
      reservedCostCents: input.held.reservedCostCents,
      actualCostCents,
    });
    settledCostCents = actualCostCents;
  } catch (error) {
    const resolution = await resolveUnknownSettlement({
      loopNode: input.loopNode,
      resume: input.resume,
      held: input.held,
      budgetCents: input.loopNode.typedWhile!.iterationBudgetCents as number,
      actualCostCents,
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
        overrun:
          `Loop "${input.loopNode.id}" iteration ${input.held.iteration} ` +
          `settled ${settledCostCents} cents, exceeding its ` +
          `${input.held.reservedCostCents}-cent reservation`,
      }
    : { status: "settled", settledCostCents };
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
}): Promise<void> {
  await checkpointBudget(
    input.resume,
    input.completedIterations,
    input.outcome,
    input.held,
    input.settledCostCents
  );
}

function validateRetainedEconomics(
  loopNode: LoopNode,
  iteration: number,
  expectedReservationId: string,
  budgetCents: number,
  economics: PipelineForEachItemEconomics
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
  return undefined;
}

async function reconcileUnknownFreshReserve(input: {
  readonly loopNode: LoopNode;
  readonly resume: LoopResumeOptions | undefined;
  readonly iteration: number;
  readonly completedIterations: number;
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
      });
      return {
        status: "settled",
        settledCostCents: input.actualCostCents,
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
    }),
    true
  );
}

async function reconcileReservation(input: {
  readonly loopNode: LoopNode;
  readonly resume: LoopResumeOptions | undefined;
  readonly held: HeldPredicateIterationReservation;
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
): { settledCostCents: number } | { error: string } {
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
  return { settledCostCents: outcome.cost.costCents };
}

async function checkpointBudget(
  resume: LoopResumeOptions | undefined,
  completedIterations: number,
  outcome: PipelineForEachItemOutcome,
  held: HeldPredicateIterationReservation,
  settledCostCents?: number
): Promise<void> {
  await resume?.onIterationBudgetCheckpoint?.({
    completedIterations,
    outcome,
    economics: {
      reservationId: held.reservationId,
      reservedCostCents: held.reservedCostCents,
      ...(settledCostCents === undefined ? {} : { settledCostCents }),
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
