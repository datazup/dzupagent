import {
  validateLoopEconomicsEvidence,
  type LoopEconomicsEvidenceOwner,
  type LoopEconomicsEvidenceV1,
} from "@dzupagent/runtime-contracts/loop-economics-evidence";

export interface LoopEconomicsEvidenceScope {
  readonly runId?: string | undefined;
  readonly loopNodeId: string;
  readonly reservationId: string;
  readonly iteration: number;
  readonly itemIndex?: number | undefined;
  readonly attempt?: number | undefined;
}

export interface LoopEconomicsBoundaryValidationInput
  extends LoopEconomicsEvidenceScope {
  readonly evidenceMode?: "required" | undefined;
  readonly evidence?: LoopEconomicsEvidenceV1 | undefined;
  readonly reservedCostCents: number;
  readonly settledCostCents?: number | undefined;
  readonly terminalStatus: "pending" | "recorded";
  readonly currentReservationBindingDigest?: `sha256:${string}` | undefined;
  readonly currentEvidenceDigest?: `sha256:${string}` | undefined;
  /** Compiled loop body ids; evidence may not name nodes outside this set. */
  readonly expectedNodeIds?: readonly string[] | undefined;
  /** Body nodes that necessarily execute through an AI admission. */
  readonly requiredExecutionNodeIds?: readonly string[] | undefined;
}

export function buildLoopEconomicsEvidenceOwner(
  scope: LoopEconomicsEvidenceScope
): LoopEconomicsEvidenceOwner | undefined {
  if (scope.runId === undefined || scope.runId.length === 0) return undefined;
  return {
    runId: scope.runId,
    loopNodeId: scope.loopNodeId,
    reservationId: scope.reservationId,
    unit: scope.itemIndex === undefined
      ? { kind: "iteration", iteration: scope.iteration }
      : {
          kind: "item",
          itemIndex: scope.itemIndex,
          iteration: scope.iteration,
          attempt: scope.attempt ?? 0,
        },
  };
}

/**
 * One shared predicate/for_each admission rule. Legacy checkpoints remain
 * readable, but an evidence-required host cannot dispatch from absent,
 * foreign, corrupt, cents-only, or non-terminally-accounted evidence.
 */
export function validateLoopEconomicsBoundary(
  input: LoopEconomicsBoundaryValidationInput
): string | undefined {
  if (input.evidence === undefined) {
    return input.evidenceMode === "required"
      ? "evidence-required loop economics cannot use a legacy cents-only reservation"
      : undefined;
  }
  const owner = buildLoopEconomicsEvidenceOwner(input);
  if (owner === undefined) {
    return "exact loop economics requires a non-empty runtime run identity";
  }
  const validation = validateLoopEconomicsEvidence(input.evidence, {
    owner,
    reservedCostCents: input.reservedCostCents,
    terminalStatus: input.terminalStatus,
    ...(input.settledCostCents === undefined
      ? {}
      : { settledCostCents: input.settledCostCents }),
    ...(input.currentReservationBindingDigest === undefined
      ? {}
      : {
          reservationBindingDigest:
            input.currentReservationBindingDigest,
        }),
    ...(input.currentEvidenceDigest === undefined
      ? {}
      : { evidenceDigest: input.currentEvidenceDigest }),
  });
  if (!validation.valid) {
    return validation.diagnostics
      .map(({ path, message }) => `${path}: ${message}`)
      .join("; ");
  }
  if (input.expectedNodeIds !== undefined) {
    const expected = new Set(input.expectedNodeIds);
    const foreign = [
      ...input.evidence.executions.map(({ nodeId }) => nodeId),
      ...input.evidence.effectIntents.map(({ nodeId }) => nodeId),
    ].find((nodeId) => !expected.has(nodeId));
    if (foreign !== undefined) {
      return `evidence names foreign body node ${JSON.stringify(foreign)}`;
    }
  }
  if (input.requiredExecutionNodeIds !== undefined) {
    const admitted = new Set(
      input.evidence.executions.map(({ nodeId }) => nodeId)
    );
    const missing = input.requiredExecutionNodeIds.find(
      (nodeId) => !admitted.has(nodeId)
    );
    if (missing !== undefined) {
      return `evidence omits required AI body node ${JSON.stringify(missing)}`;
    }
  }
  return undefined;
}
