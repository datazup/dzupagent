import type { AiUsageTruthV2 } from "../ai-execution.js";
import type { CANONICAL_JSON_VERSION } from "../idempotency.js";
import type {
  LoopEconomicsEffectIntentBinding,
  LoopEconomicsEvidenceOwner,
  LoopEconomicsExecutionAdmission,
  LoopEconomicsMoneyBinding,
  LoopEconomicsQuotaBinding,
} from "../loop-economics-evidence.js";

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
      /** Null until the branch decision is durably known. */
      readonly selectedBranch: string | null;
    }
  | {
      readonly kind: "catch";
      readonly nodePath: readonly string[];
      /** Null until body success or catch activation is durably known. */
      readonly selectedArm: "body" | "catch" | null;
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
  | "LOOP_ECONOMICS_V2_DUPLICATE_IDENTITY"
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
