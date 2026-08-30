import type { AiBudgetReservation } from "../ai-budget-reservation.js";
import type { AiCostUnknownReason } from "../ai-economics.js";
import type { AiExecutionBinding, AiUsageTruthV2 } from "../ai-execution.js";
import type { CANONICAL_JSON_VERSION } from "../idempotency.js";

export const LOOP_ECONOMICS_EVIDENCE_SCHEMA =
  "dzupagent.loopEconomicsEvidence/v1" as const;

export type Sha256Digest = `sha256:${string}`;

export type LoopEconomicsEvidenceUnit =
  | {
      readonly kind: "iteration";
      readonly iteration: number;
    }
  | {
      readonly kind: "item";
      readonly itemIndex: number;
      readonly iteration: number;
      readonly attempt: number;
    };

/** Exact scheduler owner of one reservation attempt. */
export interface LoopEconomicsEvidenceOwner {
  readonly runId: string;
  readonly loopNodeId: string;
  readonly reservationId: string;
  readonly unit: LoopEconomicsEvidenceUnit;
}

export type LoopEconomicsMoneyBinding =
  | {
      readonly status: "priced";
      readonly reservation: AiBudgetReservation;
      /** Digest of the exact tariff bytes admitted by the host. */
      readonly tariffDigest: Sha256Digest;
    }
  | {
      readonly status: "unknown";
      readonly reason: AiCostUnknownReason;
    };

export type LoopEconomicsQuotaBinding =
  | { readonly status: "not-applicable" }
  | {
      readonly status: "bound";
      readonly policyRef: string;
      readonly policyDigest: Sha256Digest;
      readonly decisionDigest: Sha256Digest;
    };

/** One pre-dispatch execution identity covered by the loop reservation. */
export interface LoopEconomicsExecutionAdmission {
  readonly nodeId: string;
  readonly binding: AiExecutionBinding;
  readonly money: LoopEconomicsMoneyBinding;
  readonly quota: LoopEconomicsQuotaBinding;
}

export interface LoopEconomicsEffectIntentBinding {
  readonly nodeId: string;
  readonly intentDigest: Sha256Digest;
}

export interface LoopEconomicsTerminalExecution {
  readonly nodeId: string;
  readonly bindingDigest: Sha256Digest;
  /** Canonical V2 receipt digest; result bytes stay outside the checkpoint. */
  readonly receiptDigest: Sha256Digest;
  readonly usage: AiUsageTruthV2;
}

export interface LoopEconomicsTerminalEffect {
  readonly nodeId: string;
  readonly intentDigest: Sha256Digest;
  readonly receiptDigest: Sha256Digest;
}

export type LoopEconomicsTerminalEvidence =
  | { readonly status: "pending" }
  | {
      readonly status: "recorded";
      readonly executions: readonly LoopEconomicsTerminalExecution[];
      readonly effects: readonly LoopEconomicsTerminalEffect[];
    };

/**
 * Sanitized, versioned evidence retained by a strict loop checkpoint.
 *
 * The immutable reservation digest excludes terminal observations, allowing a
 * pending hold and its later settlement to prove they describe the same
 * admitted route/tariff/quota/effect intent. The full evidence digest covers
 * terminal usage and receipt identities. No raw prompt, provider payload,
 * endpoint, credential, or result is retained.
 */
export interface LoopEconomicsEvidenceV1 {
  readonly schema: typeof LOOP_ECONOMICS_EVIDENCE_SCHEMA;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly owner: LoopEconomicsEvidenceOwner;
  readonly executions: readonly LoopEconomicsExecutionAdmission[];
  readonly effectIntents: readonly LoopEconomicsEffectIntentBinding[];
  readonly terminal: LoopEconomicsTerminalEvidence;
  readonly reservationBindingDigest: Sha256Digest;
  readonly evidenceDigest: Sha256Digest;
}

export type LoopEconomicsEvidenceInput = Omit<
  LoopEconomicsEvidenceV1,
  "reservationBindingDigest" | "evidenceDigest"
>;

export interface LoopEconomicsEvidenceExpectation {
  readonly owner?: LoopEconomicsEvidenceOwner;
  readonly reservationBindingDigest?: Sha256Digest;
  readonly evidenceDigest?: Sha256Digest;
  readonly reservedCostCents?: number;
  readonly settledCostCents?: number;
  readonly terminalStatus?: LoopEconomicsTerminalEvidence["status"];
}

export type LoopEconomicsEvidenceDiagnosticCode =
  | "LOOP_ECONOMICS_INVALID"
  | "LOOP_ECONOMICS_BINDING_MISMATCH"
  | "LOOP_ECONOMICS_OWNER_MISMATCH"
  | "LOOP_ECONOMICS_COST_MISMATCH";

export interface LoopEconomicsEvidenceDiagnostic {
  readonly code: LoopEconomicsEvidenceDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface LoopEconomicsEvidenceValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly LoopEconomicsEvidenceDiagnostic[];
}
