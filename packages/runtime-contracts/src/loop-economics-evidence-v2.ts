import { MICROS_PER_CENT } from "./ai-economics.js";
import {
  validateAiUsageTruthV2,
  type AiUsageTruthV2,
} from "./ai-execution.js";
import {
  CANONICAL_JSON_VERSION,
  canonicalInputDigest,
} from "./idempotency.js";
import {
  LOOP_ECONOMICS_EVIDENCE_SCHEMA,
  materializeLoopEconomicsEvidence,
  validateLoopEconomicsEvidence,
  type LoopEconomicsEffectIntentBinding,
  type LoopEconomicsEvidenceOwner,
  type LoopEconomicsExecutionAdmission,
  type LoopEconomicsMoneyBinding,
  type LoopEconomicsQuotaBinding,
} from "./loop-economics-evidence.js";

export const LOOP_ECONOMICS_EVIDENCE_V2_SCHEMA =
  "dzupagent.loopEconomicsEvidence/v2" as const;

/**
 * V1 stays readable through its own validator. It is never silently upgraded
 * or accepted by a boundary that requires per-leaf V2 outcome custody.
 */
export const LOOP_ECONOMICS_EVIDENCE_V2_COMPATIBILITY = {
  v1Read: "validate-with-v1",
  v1Upgrade: "reconcile-from-current-authority",
  downgrade: "deny",
} as const;

export type LoopEconomicsSha256DigestV2 = `sha256:${string}`;

export type LoopEconomicsControlSelectionV2 =
  | {
      readonly kind: "branch";
      readonly nodePath: readonly string[];
      readonly selectedBranch: string;
    }
  | {
      readonly kind: "catch";
      readonly nodePath: readonly string[];
      readonly selectedArm: "body" | "catch";
    };

export type LoopEconomicsLeafControlRequirementV2 =
  | {
      readonly selectionIndex: number;
      readonly kind: "branch";
      readonly requiredBranch: string;
    }
  | {
      readonly selectionIndex: number;
      readonly kind: "catch";
      readonly requiredArm: "body" | "catch";
    };

interface LoopEconomicsLeafAdmissionBaseV2 {
  readonly leafId: string;
  /** Zero-based execution order within the exact body plan. */
  readonly order: number;
  /** Ordered node identifiers from the loop body root to this leaf. */
  readonly nodePath: readonly string[];
  /** Exact control arms under which this leaf is dispatchable. */
  readonly controlRequirements: readonly LoopEconomicsLeafControlRequirementV2[];
  /** Stable across lease/fence takeover for authoritative external replay. */
  readonly idempotencyKey: string;
  /** Current positive host fencing token; unlike the idempotency key, it advances. */
  readonly fence: number;
}

export type LoopEconomicsLeafAdmissionV2 =
  | (LoopEconomicsLeafAdmissionBaseV2 & {
      readonly kind: "execution";
      readonly execution: LoopEconomicsExecutionAdmission;
    })
  | (LoopEconomicsLeafAdmissionBaseV2 & {
      readonly kind: "effect";
      readonly effect: LoopEconomicsEffectIntentBinding;
    })
  | (LoopEconomicsLeafAdmissionBaseV2 & {
      readonly kind: "charge";
      readonly chargeId: string;
      readonly executionLeafId: string;
      readonly bindingDigest: LoopEconomicsSha256DigestV2;
      readonly money: LoopEconomicsMoneyBinding;
      readonly quota: LoopEconomicsQuotaBinding;
    });

export const LOOP_ECONOMICS_RELEASE_REASONS_V2 = [
  "not-selected",
  "prior-leaf-failed",
  "dispatch-denied",
  "cancelled-before-dispatch",
] as const;

export type LoopEconomicsReleaseReasonV2 =
  (typeof LOOP_ECONOMICS_RELEASE_REASONS_V2)[number];

export const LOOP_ECONOMICS_UNKNOWN_REASONS_V2 = [
  "dispatch-acknowledgement-lost",
  "receipt-unavailable",
  "reconciliation-unavailable",
  "authority-drift",
] as const;

export type LoopEconomicsUnknownReasonV2 =
  (typeof LOOP_ECONOMICS_UNKNOWN_REASONS_V2)[number];

export type LoopEconomicsRecordedLeafOutcomeV2 =
  | {
      readonly leafId: string;
      readonly kind: "execution";
      readonly status: "recorded";
      readonly bindingDigest: LoopEconomicsSha256DigestV2;
      readonly receiptDigest: LoopEconomicsSha256DigestV2;
      readonly usage: AiUsageTruthV2;
    }
  | {
      readonly leafId: string;
      readonly kind: "effect";
      readonly status: "recorded";
      readonly intentDigest: LoopEconomicsSha256DigestV2;
      readonly receiptDigest: LoopEconomicsSha256DigestV2;
    }
  | {
      readonly leafId: string;
      readonly kind: "charge";
      readonly status: "recorded";
      readonly bindingDigest: LoopEconomicsSha256DigestV2;
      readonly receiptDigest: LoopEconomicsSha256DigestV2;
      readonly usage: AiUsageTruthV2;
    };

export interface LoopEconomicsReleasedLeafOutcomeV2 {
  readonly leafId: string;
  readonly kind: LoopEconomicsLeafAdmissionV2["kind"];
  readonly status: "released";
  readonly reason: LoopEconomicsReleaseReasonV2;
  /** Digest of the durable authority proving dispatch did not occur. */
  readonly releaseDigest: LoopEconomicsSha256DigestV2;
}

export interface LoopEconomicsUnknownLeafOutcomeV2 {
  readonly leafId: string;
  readonly kind: LoopEconomicsLeafAdmissionV2["kind"];
  readonly status: "unknown";
  readonly reason: LoopEconomicsUnknownReasonV2;
  /** Digest of the durable observation that must be reconciled. */
  readonly observationDigest: LoopEconomicsSha256DigestV2;
}

export type LoopEconomicsLeafOutcomeV2 =
  | LoopEconomicsRecordedLeafOutcomeV2
  | LoopEconomicsReleasedLeafOutcomeV2
  | LoopEconomicsUnknownLeafOutcomeV2;

export type LoopEconomicsResolutionV2 =
  | { readonly status: "pending" }
  | {
      readonly status: "settled";
      readonly outcomes: readonly LoopEconomicsLeafOutcomeV2[];
    }
  | {
      readonly status: "reconciliation-required";
      readonly outcomes: readonly LoopEconomicsLeafOutcomeV2[];
    };

export interface LoopEconomicsEvidenceV2 {
  readonly schema: typeof LOOP_ECONOMICS_EVIDENCE_V2_SCHEMA;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly owner: LoopEconomicsEvidenceOwner;
  readonly definitionDigest: LoopEconomicsSha256DigestV2;
  readonly bodyPlanDigest: LoopEconomicsSha256DigestV2;
  /** Zero-based attempt of this complete loop unit. */
  readonly unitAttempt: number;
  readonly controlSelections: readonly LoopEconomicsControlSelectionV2[];
  readonly leaves: readonly LoopEconomicsLeafAdmissionV2[];
  readonly resolution: LoopEconomicsResolutionV2;
  /** Digest of the exact plan, authority, external identities, and current fences. */
  readonly admissionDigest: LoopEconomicsSha256DigestV2;
  /** Digest of admission plus all retained leaf outcomes. */
  readonly evidenceDigest: LoopEconomicsSha256DigestV2;
}

export type LoopEconomicsEvidenceInputV2 = Omit<
  LoopEconomicsEvidenceV2,
  "admissionDigest" | "evidenceDigest"
>;

export interface LoopEconomicsEvidenceExpectationV2 {
  readonly owner?: LoopEconomicsEvidenceOwner;
  readonly definitionDigest?: LoopEconomicsSha256DigestV2;
  readonly bodyPlanDigest?: LoopEconomicsSha256DigestV2;
  readonly unitAttempt?: number;
  readonly admissionDigest?: LoopEconomicsSha256DigestV2;
  readonly evidenceDigest?: LoopEconomicsSha256DigestV2;
  readonly reservedCostCents?: number;
  readonly settledCostCents?: number;
  readonly resolutionStatus?: LoopEconomicsResolutionV2["status"];
}

export type LoopEconomicsEvidenceDiagnosticCodeV2 =
  | "LOOP_ECONOMICS_V2_INVALID"
  | "LOOP_ECONOMICS_V2_BINDING_MISMATCH"
  | "LOOP_ECONOMICS_V2_OWNER_MISMATCH"
  | "LOOP_ECONOMICS_V2_COST_MISMATCH"
  | "LOOP_ECONOMICS_V2_DUPLICATE_LEAF"
  | "LOOP_ECONOMICS_V2_MISSING_LEAF"
  | "LOOP_ECONOMICS_V2_DOWNGRADE_DENIED";

export interface LoopEconomicsEvidenceDiagnosticV2 {
  readonly code: LoopEconomicsEvidenceDiagnosticCodeV2;
  readonly path: string;
  readonly message: string;
}

export interface LoopEconomicsEvidenceValidationV2 {
  /** Structural and binding validity; this alone does not authorize completion. */
  readonly valid: boolean;
  /** True only for a valid settled record with no unknown leaf outcomes. */
  readonly terminalSuccess: boolean;
  /** True only for a valid record that contains an unresolved leaf outcome. */
  readonly requiresReconciliation: boolean;
  readonly resolutionStatus:
    | LoopEconomicsResolutionV2["status"]
    | "invalid";
  readonly diagnostics: readonly LoopEconomicsEvidenceDiagnosticV2[];
}

export type LoopEconomicsEvidenceAdmissionResultV2 =
  | { readonly status: "admitted"; readonly evidence: LoopEconomicsEvidenceV2 }
  | { readonly status: "pending"; readonly evidence: LoopEconomicsEvidenceV2 }
  | {
      readonly status: "reconciliation-required";
      readonly evidence: LoopEconomicsEvidenceV2;
    }
  | {
      readonly status: "denied";
      readonly diagnostics: readonly LoopEconomicsEvidenceDiagnosticV2[];
    };

export function materializeLoopEconomicsEvidenceV2(
  input: LoopEconomicsEvidenceInputV2
): LoopEconomicsEvidenceV2 {
  const admissionDigest = digest(admissionCore(input));
  const withAdmissionDigest = { ...input, admissionDigest };
  return {
    ...withAdmissionDigest,
    evidenceDigest: digest(withAdmissionDigest),
  };
}

/**
 * Fail-closed terminal admission. Pending and reconciliation-required evidence
 * are returned as explicit non-success states, never as admitted completion.
 */
export function admitLoopEconomicsEvidenceV2(
  value: unknown,
  expected: LoopEconomicsEvidenceExpectationV2 = {}
): LoopEconomicsEvidenceAdmissionResultV2 {
  const validation = validateLoopEconomicsEvidenceV2(value, expected);
  if (!validation.valid || !record(value)) {
    return { status: "denied", diagnostics: validation.diagnostics };
  }
  const evidence = value as unknown as LoopEconomicsEvidenceV2;
  if (validation.terminalSuccess) {
    return { status: "admitted", evidence };
  }
  if (validation.requiresReconciliation) {
    return { status: "reconciliation-required", evidence };
  }
  return { status: "pending", evidence };
}

export function validateLoopEconomicsEvidenceV2(
  value: unknown,
  expected: LoopEconomicsEvidenceExpectationV2 = {}
): LoopEconomicsEvidenceValidationV2 {
  const diagnostics: LoopEconomicsEvidenceDiagnosticV2[] = [];
  if (!record(value)) {
    return invalid("$", "Loop economics V2 evidence must be an object.");
  }
  if (containsCycle(value)) {
    return invalid("$", "Loop economics V2 evidence must be acyclic.");
  }
  if (value.schema === LOOP_ECONOMICS_EVIDENCE_SCHEMA) {
    add(
      diagnostics,
      "LOOP_ECONOMICS_V2_DOWNGRADE_DENIED",
      "schema",
      "V1 evidence cannot satisfy a boundary that requires per-leaf V2 outcomes."
    );
    return validation(diagnostics, "invalid");
  }

  exactKeys(
    value,
    [
      "schema",
      "canonicalization",
      "owner",
      "definitionDigest",
      "bodyPlanDigest",
      "unitAttempt",
      "controlSelections",
      "leaves",
      "resolution",
      "admissionDigest",
      "evidenceDigest",
    ],
    "$",
    diagnostics
  );
  if (value.schema !== LOOP_ECONOMICS_EVIDENCE_V2_SCHEMA) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "schema", "Unsupported loop economics V2 evidence schema.");
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "canonicalization", "Unsupported canonical JSON version.");
  }

  validateOwner(value.owner, "owner", diagnostics);
  if (expected.owner !== undefined && !canonicalEqual(value.owner, expected.owner)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_OWNER_MISMATCH", "owner", "Evidence owner does not match the current loop reservation owner.");
  }
  sha(value.definitionDigest, "definitionDigest", diagnostics);
  sha(value.bodyPlanDigest, "bodyPlanDigest", diagnostics);
  nonNegativeSafeIntegerField(value.unitAttempt, "unitAttempt", diagnostics);
  compareExpected(value.definitionDigest, expected.definitionDigest, "definitionDigest", diagnostics);
  compareExpected(value.bodyPlanDigest, expected.bodyPlanDigest, "bodyPlanDigest", diagnostics);
  if (expected.unitAttempt !== undefined && value.unitAttempt !== expected.unitAttempt) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "unitAttempt", "Unit attempt differs from current host authority.");
  }

  const selections = Array.isArray(value.controlSelections)
    ? value.controlSelections
    : [];
  if (!Array.isArray(value.controlSelections)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "controlSelections", "Control selections must be an array.");
  }
  validateControlSelections(selections, diagnostics);

  const leaves = Array.isArray(value.leaves) ? value.leaves : [];
  if (!Array.isArray(value.leaves) || leaves.length === 0) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "leaves", "At least one economics leaf admission is required.");
  }
  validateLeaves(leaves, selections, value.owner, diagnostics);

  const resolutionStatus = validateResolution(
    value.resolution,
    leaves,
    selections,
    value.owner,
    diagnostics
  );

  const evidence = value as unknown as LoopEconomicsEvidenceV2;
  const expectedAdmissionDigest = safeDigest(admissionCore(evidence));
  if (value.admissionDigest !== expectedAdmissionDigest) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "admissionDigest", "Admission digest does not match the canonical plan and leaf authority.");
  }
  compareExpected(value.admissionDigest, expected.admissionDigest, "admissionDigest", diagnostics);
  const { evidenceDigest, ...withoutEvidenceDigest } = value;
  if (evidenceDigest !== safeDigest(withoutEvidenceDigest)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "evidenceDigest", "Evidence digest does not match canonical content.");
  }
  compareExpected(evidenceDigest, expected.evidenceDigest, "evidenceDigest", diagnostics);
  if (
    expected.resolutionStatus !== undefined &&
    resolutionStatus !== expected.resolutionStatus
  ) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "resolution.status", `Expected resolution status ${expected.resolutionStatus}.`);
  }

  if (expected.reservedCostCents !== undefined) {
    const reservedMicros = sumPricedReservations(leaves);
    const expectedCents = reservedMicros === undefined
      ? undefined
      : Math.ceil(reservedMicros / MICROS_PER_CENT);
    if (
      !nonNegativeSafeInteger(expected.reservedCostCents) ||
      expectedCents === undefined ||
      expectedCents !== expected.reservedCostCents
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_COST_MISMATCH", "leaves", "Priced execution reservations do not equal authoritative reserved cents.");
    }
  }
  if (expected.settledCostCents !== undefined) {
    const settledMicros = sumSettledCosts(value.resolution, leaves);
    const expectedCents = settledMicros === undefined
      ? undefined
      : Math.ceil(settledMicros / MICROS_PER_CENT);
    if (
      !nonNegativeSafeInteger(expected.settledCostCents) ||
      expectedCents === undefined ||
      expectedCents !== expected.settledCostCents
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_COST_MISMATCH", "resolution.outcomes", "Recorded charge truth does not equal authoritative settled cents.");
    }
  }

  return validation(diagnostics, resolutionStatus);
}

function validateControlSelections(
  values: readonly unknown[],
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const path = `controlSelections[${index}]`;
    if (!record(value)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Control selection must be an object.");
      return;
    }
    if (value.kind === "branch") {
      exactKeys(value, ["kind", "nodePath", "selectedBranch"], path, diagnostics);
      validateNodePath(value.nodePath, `${path}.nodePath`, diagnostics);
      nonEmpty(value.selectedBranch, `${path}.selectedBranch`, diagnostics);
    } else if (value.kind === "catch") {
      exactKeys(value, ["kind", "nodePath", "selectedArm"], path, diagnostics);
      validateNodePath(value.nodePath, `${path}.nodePath`, diagnostics);
      if (value.selectedArm !== "body" && value.selectedArm !== "catch") {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.selectedArm`, "Catch selection must choose body or catch.");
      }
    } else {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.kind`, "Control selection must be branch or catch.");
    }
    const key = safeDigest({ kind: value.kind, nodePath: value.nodePath });
    if (key !== undefined && seen.has(key)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "A control node can be selected only once.");
    } else if (key !== undefined) {
      seen.add(key);
    }
  });
}

function validateLeaves(
  leaves: readonly unknown[],
  selections: readonly unknown[],
  owner: unknown,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  const ids = new Set<string>();
  const pathKinds = new Set<string>();
  const executionLeaves = new Map<string, Record<string, unknown>>();

  leaves.forEach((leaf, index) => {
    const path = `leaves[${index}]`;
    if (!record(leaf)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Leaf admission must be an object.");
      return;
    }
    if (leaf.kind === "execution") {
      exactKeys(leaf, ["leafId", "order", "nodePath", "controlRequirements", "idempotencyKey", "fence", "kind", "execution"], path, diagnostics);
    } else if (leaf.kind === "effect") {
      exactKeys(leaf, ["leafId", "order", "nodePath", "controlRequirements", "idempotencyKey", "fence", "kind", "effect"], path, diagnostics);
    } else if (leaf.kind === "charge") {
      exactKeys(leaf, ["leafId", "order", "nodePath", "controlRequirements", "idempotencyKey", "fence", "kind", "chargeId", "executionLeafId", "bindingDigest", "money", "quota"], path, diagnostics);
    } else {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.kind`, "Leaf kind must be execution, effect, or charge.");
    }

    nonEmpty(leaf.leafId, `${path}.leafId`, diagnostics);
    if (nonEmptyString(leaf.leafId)) {
      if (ids.has(leaf.leafId)) {
        add(diagnostics, "LOOP_ECONOMICS_V2_DUPLICATE_LEAF", `${path}.leafId`, "Leaf ids must be unique.");
      }
      ids.add(leaf.leafId);
    }
    if (leaf.order !== index) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.order`, "Leaf order must be contiguous and equal its array position.");
    }
    validateNodePath(leaf.nodePath, `${path}.nodePath`, diagnostics);
    validateControlRequirements(
      leaf.controlRequirements,
      selections,
      `${path}.controlRequirements`,
      diagnostics
    );
    nonEmpty(leaf.idempotencyKey, `${path}.idempotencyKey`, diagnostics);
    positiveSafeIntegerField(leaf.fence, `${path}.fence`, diagnostics);
    const pathKind = safeDigest({ kind: leaf.kind, nodePath: leaf.nodePath });
    if (pathKind !== undefined && pathKinds.has(pathKind)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_DUPLICATE_LEAF", `${path}.nodePath`, "A leaf kind and node path pair must be unique.");
    } else if (pathKind !== undefined) {
      pathKinds.add(pathKind);
    }

    if (leaf.kind === "execution") {
      validateExecutionAdmissionViaV1(leaf.execution, owner, `${path}.execution`, diagnostics);
      if (nonEmptyString(leaf.leafId)) executionLeaves.set(leaf.leafId, leaf);
      const nodeId = record(leaf.execution) ? leaf.execution.nodeId : undefined;
      validatePathTail(leaf.nodePath, nodeId, `${path}.nodePath`, diagnostics);
    } else if (leaf.kind === "effect") {
      if (!record(leaf.effect)) {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.effect`, "Effect admission must be an object.");
      } else {
        exactKeys(leaf.effect, ["nodeId", "intentDigest"], `${path}.effect`, diagnostics);
        nonEmpty(leaf.effect.nodeId, `${path}.effect.nodeId`, diagnostics);
        sha(leaf.effect.intentDigest, `${path}.effect.intentDigest`, diagnostics);
        validatePathTail(leaf.nodePath, leaf.effect.nodeId, `${path}.nodePath`, diagnostics);
      }
    }
  });

  const chargedExecutions = new Set<string>();
  leaves.forEach((leaf, index) => {
    if (!record(leaf) || leaf.kind !== "charge") return;
    const path = `leaves[${index}]`;
    nonEmpty(leaf.chargeId, `${path}.chargeId`, diagnostics);
    nonEmpty(leaf.executionLeafId, `${path}.executionLeafId`, diagnostics);
    sha(leaf.bindingDigest, `${path}.bindingDigest`, diagnostics);
    if (!nonEmptyString(leaf.executionLeafId)) return;
    const executionLeaf = executionLeaves.get(leaf.executionLeafId);
    if (executionLeaf === undefined || !record(executionLeaf.execution)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.executionLeafId`, "Charge must reference an admitted execution leaf.");
      return;
    }
    if (chargedExecutions.has(leaf.executionLeafId)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_DUPLICATE_LEAF", `${path}.executionLeafId`, "An execution may have at most one charge leaf; V2 usage carries per-attempt charge lines.");
    }
    chargedExecutions.add(leaf.executionLeafId);
    if (
      typeof executionLeaf.order === "number" &&
      typeof leaf.order === "number" &&
      leaf.order <= executionLeaf.order
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.order`, "Charge leaf must follow its execution leaf.");
    }
    const execution = executionLeaf.execution;
    if (!record(execution.binding) || leaf.bindingDigest !== execution.binding.bindingDigest) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.bindingDigest`, "Charge binding must match its execution admission.");
    }
    if (!canonicalEqual(leaf.money, execution.money)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.money`, "Charge money authority must equal its execution admission.");
    }
    if (!canonicalEqual(leaf.quota, execution.quota)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.quota`, "Charge quota authority must equal its execution admission.");
    }
  });
}

function validateResolution(
  value: unknown,
  leaves: readonly unknown[],
  selections: readonly unknown[],
  owner: unknown,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): LoopEconomicsResolutionV2["status"] | "invalid" {
  if (!record(value)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "resolution", "Resolution is required.");
    return "invalid";
  }
  if (value.status === "pending") {
    exactKeys(value, ["status"], "resolution", diagnostics);
    return "pending";
  }
  if (value.status !== "settled" && value.status !== "reconciliation-required") {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "resolution.status", "Resolution must be pending, settled, or reconciliation-required.");
    return "invalid";
  }
  exactKeys(value, ["status", "outcomes"], "resolution", diagnostics);
  const outcomes = Array.isArray(value.outcomes) ? value.outcomes : [];
  if (!Array.isArray(value.outcomes)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "resolution.outcomes", "Resolved evidence must contain an outcome array.");
  }
  validateOutcomeCoverage(outcomes, leaves, selections, owner, diagnostics);
  const containsUnknown = outcomes.some(
    (outcome) => record(outcome) && outcome.status === "unknown"
  );
  if (value.status === "settled" && containsUnknown) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "resolution.status", "Settled evidence cannot contain an unknown leaf outcome.");
  }
  if (value.status === "reconciliation-required" && !containsUnknown) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "resolution.status", "Reconciliation-required evidence must contain at least one unknown leaf outcome.");
  }
  return value.status;
}

function validateOutcomeCoverage(
  outcomes: readonly unknown[],
  leaves: readonly unknown[],
  selections: readonly unknown[],
  owner: unknown,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  const leafById = new Map<string, Record<string, unknown>>();
  const outcomeCounts = new Map<string, number>();
  leaves.forEach((leaf) => {
    if (record(leaf) && nonEmptyString(leaf.leafId)) leafById.set(leaf.leafId, leaf);
  });
  outcomes.forEach((outcome, index) => {
    if (record(outcome) && nonEmptyString(outcome.leafId)) {
      outcomeCounts.set(outcome.leafId, (outcomeCounts.get(outcome.leafId) ?? 0) + 1);
      if ((outcomeCounts.get(outcome.leafId) ?? 0) > 1) {
        add(diagnostics, "LOOP_ECONOMICS_V2_DUPLICATE_LEAF", `resolution.outcomes[${index}].leafId`, "Each admitted leaf must have exactly one outcome.");
      }
    }
  });
  for (const leafId of leafById.keys()) {
    if (!outcomeCounts.has(leafId)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_MISSING_LEAF", "resolution.outcomes", `Missing outcome for admitted leaf ${leafId}.`);
    }
  }
  if (outcomes.length !== leaves.length) {
    add(diagnostics, "LOOP_ECONOMICS_V2_MISSING_LEAF", "resolution.outcomes", "Resolved evidence must cover every admitted leaf exactly once.");
  }

  outcomes.forEach((outcome, index) => {
    const path = `resolution.outcomes[${index}]`;
    if (!record(outcome)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Leaf outcome must be an object.");
      return;
    }
    nonEmpty(outcome.leafId, `${path}.leafId`, diagnostics);
    const leaf = nonEmptyString(outcome.leafId)
      ? leafById.get(outcome.leafId)
      : undefined;
    if (leaf === undefined) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.leafId`, "Outcome does not name an admitted leaf.");
    }
    const orderedLeaf = record(leaves[index]) ? leaves[index] : undefined;
    if (orderedLeaf?.leafId !== outcome.leafId) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.leafId`, "Outcome order must match admitted leaf order.");
    }
    if (leaf !== undefined && outcome.kind !== leaf.kind) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.kind`, "Outcome kind must match its admitted leaf.");
    }

    if (outcome.status === "recorded") {
      validateRecordedOutcome(outcome, leaf, leaves, owner, path, diagnostics);
    } else if (outcome.status === "released") {
      exactKeys(outcome, ["leafId", "kind", "status", "reason", "releaseDigest"], path, diagnostics);
      if (!LOOP_ECONOMICS_RELEASE_REASONS_V2.includes(outcome.reason as LoopEconomicsReleaseReasonV2)) {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.reason`, "Release reason is not canonical.");
      }
      sha(outcome.releaseDigest, `${path}.releaseDigest`, diagnostics);
    } else if (outcome.status === "unknown") {
      exactKeys(outcome, ["leafId", "kind", "status", "reason", "observationDigest"], path, diagnostics);
      if (!LOOP_ECONOMICS_UNKNOWN_REASONS_V2.includes(outcome.reason as LoopEconomicsUnknownReasonV2)) {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.reason`, "Unknown outcome reason is not canonical.");
      }
      sha(outcome.observationDigest, `${path}.observationDigest`, diagnostics);
    } else {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.status`, "Leaf outcome must be recorded, released, or unknown.");
    }
    const selected = leaf === undefined
      ? undefined
      : isLeafSelected(leaf, selections);
    if (
      selected === false &&
      (outcome.status !== "released" || outcome.reason !== "not-selected")
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", path, "A leaf outside the selected branch/catch path must be released as not-selected.");
    }
    if (
      selected === true &&
      outcome.status === "released" &&
      outcome.reason === "not-selected"
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", path, "A selected leaf cannot be released as not-selected.");
    }
  });

  for (const leaf of leafById.values()) {
    if (leaf.kind !== "charge" || !nonEmptyString(leaf.executionLeafId)) continue;
    const executionOutcome = outcomes.find(
      (candidate) => record(candidate) && candidate.leafId === leaf.executionLeafId
    );
    const chargeOutcome = outcomes.find(
      (candidate) => record(candidate) && candidate.leafId === leaf.leafId
    );
    if (
      record(executionOutcome) && executionOutcome.status === "released" &&
      record(chargeOutcome) && chargeOutcome.status !== "released"
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "resolution.outcomes", "A released execution cannot have a recorded or unknown charge dispatch.");
    }
  }
}

function validateControlRequirements(
  value: unknown,
  selections: readonly unknown[],
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!Array.isArray(value)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Leaf control requirements must be an array.");
    return;
  }
  let previous = -1;
  value.forEach((requirement, index) => {
    const requirementPath = `${path}[${index}]`;
    if (!record(requirement)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", requirementPath, "Control requirement must be an object.");
      return;
    }
    if (requirement.kind === "branch") {
      exactKeys(requirement, ["selectionIndex", "kind", "requiredBranch"], requirementPath, diagnostics);
      nonEmpty(requirement.requiredBranch, `${requirementPath}.requiredBranch`, diagnostics);
    } else if (requirement.kind === "catch") {
      exactKeys(requirement, ["selectionIndex", "kind", "requiredArm"], requirementPath, diagnostics);
      if (requirement.requiredArm !== "body" && requirement.requiredArm !== "catch") {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${requirementPath}.requiredArm`, "Required catch arm must be body or catch.");
      }
    } else {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${requirementPath}.kind`, "Control requirement must be branch or catch.");
    }
    nonNegativeSafeIntegerField(requirement.selectionIndex, `${requirementPath}.selectionIndex`, diagnostics);
    if (typeof requirement.selectionIndex === "number" && requirement.selectionIndex <= previous) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${requirementPath}.selectionIndex`, "Control requirement indexes must be unique and strictly increasing.");
    }
    if (typeof requirement.selectionIndex === "number") previous = requirement.selectionIndex;
    const selection = nonNegativeSafeInteger(requirement.selectionIndex)
      ? selections[requirement.selectionIndex]
      : undefined;
    if (!record(selection) || selection.kind !== requirement.kind) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${requirementPath}.selectionIndex`, "Control requirement must reference a selection of the same kind.");
    }
  });
}

function isLeafSelected(
  leaf: Record<string, unknown>,
  selections: readonly unknown[]
): boolean | undefined {
  if (!Array.isArray(leaf.controlRequirements)) return undefined;
  for (const requirement of leaf.controlRequirements) {
    if (!record(requirement) || !nonNegativeSafeInteger(requirement.selectionIndex)) return undefined;
    const selection = selections[requirement.selectionIndex];
    if (!record(selection) || selection.kind !== requirement.kind) return undefined;
    if (
      requirement.kind === "branch" &&
      selection.selectedBranch !== requirement.requiredBranch
    ) return false;
    if (
      requirement.kind === "catch" &&
      selection.selectedArm !== requirement.requiredArm
    ) return false;
  }
  return true;
}

function validateRecordedOutcome(
  outcome: Record<string, unknown>,
  leaf: Record<string, unknown> | undefined,
  leaves: readonly unknown[],
  owner: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (outcome.kind === "execution") {
    exactKeys(outcome, ["leafId", "kind", "status", "bindingDigest", "receiptDigest", "usage"], path, diagnostics);
    sha(outcome.bindingDigest, `${path}.bindingDigest`, diagnostics);
    sha(outcome.receiptDigest, `${path}.receiptDigest`, diagnostics);
    if (leaf?.kind !== "execution" || !record(leaf.execution)) return;
    const binding = record(leaf.execution.binding) ? leaf.execution.binding : undefined;
    if (outcome.bindingDigest !== binding?.bindingDigest) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.bindingDigest`, "Recorded execution binding must match its admission.");
    }
    validateRecordedUsageViaV1(outcome.usage, leaf.execution, owner, path, diagnostics);
  } else if (outcome.kind === "effect") {
    exactKeys(outcome, ["leafId", "kind", "status", "intentDigest", "receiptDigest"], path, diagnostics);
    sha(outcome.intentDigest, `${path}.intentDigest`, diagnostics);
    sha(outcome.receiptDigest, `${path}.receiptDigest`, diagnostics);
    if (leaf?.kind === "effect" && record(leaf.effect) && outcome.intentDigest !== leaf.effect.intentDigest) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.intentDigest`, "Recorded effect intent must match its admission.");
    }
  } else if (outcome.kind === "charge") {
    exactKeys(outcome, ["leafId", "kind", "status", "bindingDigest", "receiptDigest", "usage"], path, diagnostics);
    sha(outcome.bindingDigest, `${path}.bindingDigest`, diagnostics);
    sha(outcome.receiptDigest, `${path}.receiptDigest`, diagnostics);
    if (leaf?.kind !== "charge") return;
    if (outcome.bindingDigest !== leaf.bindingDigest) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.bindingDigest`, "Recorded charge binding must match its admission.");
    }
    const executionLeaf = leaves.find(
      (candidate) =>
        record(candidate) &&
        candidate.kind === "execution" &&
        candidate.leafId === leaf.executionLeafId
    );
    const execution = record(executionLeaf) && record(executionLeaf.execution)
      ? executionLeaf.execution
      : undefined;
    if (execution !== undefined) {
      validateRecordedUsageViaV1(outcome.usage, execution, owner, path, diagnostics);
    } else {
      for (const diagnostic of validateAiUsageTruthV2(outcome.usage).diagnostics) {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.${diagnostic.path}`, diagnostic.message);
      }
    }
  } else {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.kind`, "Recorded outcome kind must be execution, effect, or charge.");
  }
}

function validateExecutionAdmissionViaV1(
  execution: unknown,
  owner: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!record(execution) || !record(owner)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Execution admission must be an object.");
    return;
  }
  try {
    const evidence = materializeLoopEconomicsEvidence({
      schema: LOOP_ECONOMICS_EVIDENCE_SCHEMA,
      canonicalization: CANONICAL_JSON_VERSION,
      owner: owner as unknown as LoopEconomicsEvidenceOwner,
      executions: [execution as unknown as LoopEconomicsExecutionAdmission],
      effectIntents: [],
      terminal: { status: "pending" },
    });
    const result = validateLoopEconomicsEvidence(evidence);
    for (const diagnostic of result.diagnostics) {
      if (!diagnostic.path.startsWith("executions[0]")) continue;
      add(
        diagnostics,
        mapV1Code(diagnostic.code),
        `${path}${diagnostic.path.slice("executions[0]".length)}`,
        diagnostic.message
      );
    }
  } catch {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Execution admission cannot be canonically materialized.");
  }
}

function validateRecordedUsageViaV1(
  usage: unknown,
  execution: Record<string, unknown>,
  owner: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!record(owner) || !record(execution.binding)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.usage`, "Usage cannot be verified without an exact execution admission.");
    return;
  }
  try {
    const evidence = materializeLoopEconomicsEvidence({
      schema: LOOP_ECONOMICS_EVIDENCE_SCHEMA,
      canonicalization: CANONICAL_JSON_VERSION,
      owner: owner as unknown as LoopEconomicsEvidenceOwner,
      executions: [execution as unknown as LoopEconomicsExecutionAdmission],
      effectIntents: [],
      terminal: {
        status: "recorded",
        executions: [{
          nodeId: execution.nodeId as string,
          bindingDigest: execution.binding.bindingDigest as LoopEconomicsSha256DigestV2,
          receiptDigest: digest({ path, usage }),
          usage: usage as AiUsageTruthV2,
        }],
        effects: [],
      },
    });
    const result = validateLoopEconomicsEvidence(evidence);
    for (const diagnostic of result.diagnostics) {
      if (!diagnostic.path.startsWith("terminal.executions[0]")) continue;
      add(
        diagnostics,
        mapV1Code(diagnostic.code),
        `${path}${diagnostic.path.slice("terminal.executions[0]".length)}`,
        diagnostic.message
      );
    }
  } catch {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.usage`, "Recorded usage cannot be canonically verified.");
  }
}

function validateOwner(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!record(value) || !record(value.unit)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Evidence owner and unit are required.");
    return;
  }
  exactKeys(value, ["runId", "loopNodeId", "reservationId", "unit"], path, diagnostics);
  for (const key of ["runId", "loopNodeId", "reservationId"] as const) {
    nonEmpty(value[key], `${path}.${key}`, diagnostics);
  }
  let expectedReservationId: string | undefined;
  if (value.unit.kind === "iteration") {
    exactKeys(value.unit, ["kind", "iteration"], `${path}.unit`, diagnostics);
    positiveSafeIntegerField(value.unit.iteration, `${path}.unit.iteration`, diagnostics);
    if (nonEmptyString(value.runId) && nonEmptyString(value.loopNodeId) && positiveSafeInteger(value.unit.iteration)) {
      expectedReservationId = `resv:v1:${value.runId}:iteration:${value.loopNodeId}:${value.unit.iteration}`;
    }
  } else if (value.unit.kind === "item") {
    exactKeys(value.unit, ["kind", "itemIndex", "iteration", "attempt"], `${path}.unit`, diagnostics);
    nonNegativeSafeIntegerField(value.unit.itemIndex, `${path}.unit.itemIndex`, diagnostics);
    positiveSafeIntegerField(value.unit.iteration, `${path}.unit.iteration`, diagnostics);
    nonNegativeSafeIntegerField(value.unit.attempt, `${path}.unit.attempt`, diagnostics);
    if (
      nonNegativeSafeInteger(value.unit.itemIndex) &&
      positiveSafeInteger(value.unit.iteration) &&
      value.unit.iteration !== value.unit.itemIndex + 1
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_OWNER_MISMATCH", `${path}.unit.iteration`, "For-each iteration must equal itemIndex + 1.");
    }
    if (
      nonEmptyString(value.runId) &&
      nonEmptyString(value.loopNodeId) &&
      nonNegativeSafeInteger(value.unit.itemIndex) &&
      nonNegativeSafeInteger(value.unit.attempt)
    ) {
      const base = `resv:v1:${value.runId}:item:${value.loopNodeId}:${value.unit.itemIndex}`;
      expectedReservationId = value.unit.attempt > 0
        ? `${base}:attempt:${value.unit.attempt}`
        : base;
    }
  } else {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.unit.kind`, "Unit kind must be iteration or item.");
  }
  if (expectedReservationId !== undefined && value.reservationId !== expectedReservationId) {
    add(diagnostics, "LOOP_ECONOMICS_V2_OWNER_MISMATCH", `${path}.reservationId`, "Reservation id does not match its deterministic owner.");
  }
}

function admissionCore(
  value: LoopEconomicsEvidenceInputV2 | LoopEconomicsEvidenceV2
) {
  return {
    schema: value.schema,
    canonicalization: value.canonicalization,
    owner: value.owner,
    definitionDigest: value.definitionDigest,
    bodyPlanDigest: value.bodyPlanDigest,
    unitAttempt: value.unitAttempt,
    controlSelections: value.controlSelections,
    leaves: value.leaves,
  };
}

function sumPricedReservations(leaves: readonly unknown[]): number | undefined {
  let total = 0;
  for (const leaf of leaves) {
    if (!record(leaf) || leaf.kind !== "execution" || !record(leaf.execution) || !record(leaf.execution.money)) continue;
    if (leaf.execution.money.status !== "priced" || !record(leaf.execution.money.reservation)) return undefined;
    const amount = leaf.execution.money.reservation.reservedAmountMicros;
    if (!nonNegativeSafeInteger(amount)) return undefined;
    total += amount;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function sumSettledCosts(
  resolution: unknown,
  leaves: readonly unknown[]
): number | undefined {
  if (!record(resolution) || resolution.status !== "settled" || !Array.isArray(resolution.outcomes)) return undefined;
  const outcomes = new Map<string, Record<string, unknown>>();
  for (const outcome of resolution.outcomes) {
    if (record(outcome) && nonEmptyString(outcome.leafId)) outcomes.set(outcome.leafId, outcome);
  }
  let total = 0;
  for (const leaf of leaves) {
    if (!record(leaf) || leaf.kind !== "execution" || !nonEmptyString(leaf.leafId)) continue;
    const chargeLeaf = leaves.find(
      (candidate) => record(candidate) && candidate.kind === "charge" && candidate.executionLeafId === leaf.leafId
    );
    const selectedLeafId = record(chargeLeaf) && nonEmptyString(chargeLeaf.leafId)
      ? chargeLeaf.leafId
      : leaf.leafId;
    const outcome = outcomes.get(selectedLeafId);
    if (!record(outcome)) return undefined;
    if (outcome.status === "released") continue;
    if (outcome.status !== "recorded" || !record(outcome.usage) || !record(outcome.usage.cost) || outcome.usage.cost.status === "unknown") return undefined;
    const amount = outcome.usage.cost.amountMicros;
    if (!nonNegativeSafeInteger(amount)) return undefined;
    total += amount;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function validateNodePath(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!Array.isArray(value) || value.length === 0) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Node path must be a non-empty ordered array.");
    return;
  }
  value.forEach((segment, index) => nonEmpty(segment, `${path}[${index}]`, diagnostics));
}

function validatePathTail(
  nodePath: unknown,
  nodeId: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (Array.isArray(nodePath) && nodePath.length > 0 && nonEmptyString(nodeId) && nodePath.at(-1) !== nodeId) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", path, "Node path must terminate at the admitted node id.");
  }
}

function compareExpected(
  actual: unknown,
  expected: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (expected !== undefined && actual !== expected) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", path, "Evidence differs from current host authority.");
  }
}

function mapV1Code(code: string): LoopEconomicsEvidenceDiagnosticCodeV2 {
  if (code.endsWith("COST_MISMATCH")) return "LOOP_ECONOMICS_V2_COST_MISMATCH";
  if (code.endsWith("OWNER_MISMATCH")) return "LOOP_ECONOMICS_V2_OWNER_MISMATCH";
  if (code.endsWith("BINDING_MISMATCH")) return "LOOP_ECONOMICS_V2_BINDING_MISMATCH";
  return "LOOP_ECONOMICS_V2_INVALID";
}

function validation(
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[],
  resolutionStatus: LoopEconomicsEvidenceValidationV2["resolutionStatus"]
): LoopEconomicsEvidenceValidationV2 {
  const valid = diagnostics.length === 0;
  return {
    valid,
    terminalSuccess: valid && resolutionStatus === "settled",
    requiresReconciliation: valid && resolutionStatus === "reconciliation-required",
    resolutionStatus,
    diagnostics,
  };
}

function invalid(path: string, message: string): LoopEconomicsEvidenceValidationV2 {
  return validation(
    [{ code: "LOOP_ECONOMICS_V2_INVALID", path, message }],
    "invalid"
  );
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.${key}`, "Unknown V2 evidence field is not admitted.");
    }
  }
}

function add(
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[],
  code: LoopEconomicsEvidenceDiagnosticCodeV2,
  path: string,
  message: string
): void {
  diagnostics.push({ code, path, message });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonEmpty(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!nonEmptyString(value)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Field must be non-empty.");
  }
}

function sha(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(typeof value === "string" ? value : "")) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Field must be a lowercase SHA-256 digest.");
  }
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeIntegerField(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!nonNegativeSafeInteger(value)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Field must be a non-negative safe integer.");
  }
}

function positiveSafeIntegerField(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!positiveSafeInteger(value)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Field must be a positive safe integer.");
  }
}

function digest(value: unknown): LoopEconomicsSha256DigestV2 {
  return `sha256:${canonicalInputDigest(value)}`;
}

function safeDigest(value: unknown): LoopEconomicsSha256DigestV2 | undefined {
  try {
    return digest(value);
  } catch {
    return undefined;
  }
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  const leftDigest = safeDigest(left);
  return leftDigest !== undefined && leftDigest === safeDigest(right);
}

function containsCycle(value: unknown): boolean {
  const active = new WeakSet<object>();
  const visited = new WeakSet<object>();
  const visit = (candidate: unknown): boolean => {
    if (typeof candidate !== "object" || candidate === null) return false;
    if (active.has(candidate)) return true;
    if (visited.has(candidate)) return false;
    active.add(candidate);
    const children = Array.isArray(candidate)
      ? candidate
      : Object.values(candidate);
    for (const child of children) {
      if (visit(child)) return true;
    }
    active.delete(candidate);
    visited.add(candidate);
    return false;
  };
  return visit(value);
}
