/**
 * `ai-execution` usage, event and receipt contracts.
 *
 * Everything describing what an execution actually did: token usage, charge
 * attribution, the cost/usage truth unions and their V2 successors, the
 * lifecycle event shape, attempt and execution receipts, and the diagnostic /
 * validation result types the validators report through.
 *
 * A leaf module by the same rule as `ai-execution-types.ts`, which declares the
 * request/target/binding half this one refers to.
 *
 * @module ai-execution-receipt-types
 */

import type {
  ExecutionArtifactRef,
  ExecutionResult,
} from "./canonical-execution.js";
import type { AiCostUnknownReason, AiPriceProvenance, AiQuotaTruth } from "./ai-economics.js";
import type {
  AI_EXECUTION_EVENT_SCHEMA,
  AI_EXECUTION_RECEIPT_SCHEMA,
  AI_EXECUTION_RECEIPT_V2_SCHEMA,
  AiExecutionBinding,
  AiExecutionOperationKind,
  AiJsonValue,
  AiModelIdentity,
  AiExecutionRequest,
  AiResolvedTargetSnapshot,
  AiTargetPlacement,
  AiTargetSelector,
} from "./ai-execution-types.js";

export interface AiTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cachedInput?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
}

/** One attempt's immutable price attribution. */
export interface AiChargeAttribution {
  readonly attempt: number;
  readonly offerRef: string;
  readonly tariffRef: string;
  readonly amountMicros: number;
  readonly provenance: AiPriceProvenance;
}

/** Monetary truth with mandatory offer/tariff provenance for priced values. */
export type AiCostTruth =
  | {
      readonly status: "unknown";
      readonly reason?: AiCostUnknownReason;
    }
  | {
      readonly status: "estimated" | "reconciled";
      readonly currency: string;
      readonly amountMicros: number;
      /** @deprecated V1-only; V2 uses per-attempt `charges`. */
      readonly tariffRef?: string;
      /** @deprecated V1-only; V2 uses per-attempt `charges`. */
      readonly provenance?: AiPriceProvenance;
      /** Required by V2 receipts; optional only while reading legacy V1 data. */
      readonly charges?: readonly AiChargeAttribution[];
    };

export type AiCostTruthV2 =
  | Extract<AiCostTruth, { readonly status: "unknown" }>
  | (Omit<
      Extract<AiCostTruth, { readonly status: "estimated" | "reconciled" }>,
      "charges" | "tariffRef" | "provenance"
    > & { readonly charges: readonly AiChargeAttribution[] });

/**
 * Unknown and partial usage are explicit states and are never interpreted as zero.
 *
 * `quota` is independent of `cost`: a subscription-billed call reports
 * `cost.status: "unknown"` with `reason: "subscription"` while still carrying a
 * measured quota draw. Money being unknown never implies nothing was consumed.
 */
export type AiUsageTruth =
  | {
      readonly measurement: "unknown";
      readonly cost: {
        readonly status: "unknown";
        readonly reason?: AiCostUnknownReason;
      };
      readonly quota?: AiQuotaTruth;
    }
  | {
      readonly measurement: "partial";
      readonly tokens?: AiTokenUsage;
      readonly cost: AiCostTruth;
      readonly quota?: AiQuotaTruth;
    }
  | {
      readonly measurement: "known";
      readonly tokens: AiTokenUsage;
      readonly cost: AiCostTruth;
      readonly quota?: AiQuotaTruth;
    };

export type AiUsageTruthV2 =
  | Extract<AiUsageTruth, { readonly measurement: "unknown" }>
  | (Omit<Extract<AiUsageTruth, { readonly measurement: "partial" }>, "cost"> & {
      readonly cost: AiCostTruthV2;
    })
  | (Omit<Extract<AiUsageTruth, { readonly measurement: "known" }>, "cost"> & {
      readonly cost: AiCostTruthV2;
    });

interface AiExecutionEventBase {
  readonly schema: typeof AI_EXECUTION_EVENT_SCHEMA;
  readonly requestId: string;
  readonly correlationId: string;
  readonly sequence: number;
  readonly cursor: string;
  readonly attempt: number;
  readonly emittedAt: string;
}

export type AiExecutionEvent = AiExecutionEventBase &
  (
    | { readonly type: "started" }
    | { readonly type: "output.delta"; readonly delta: string }
    | {
        readonly type: "artifact";
        readonly artifact: ExecutionArtifactRef;
      }
    | {
        readonly type: "usage";
        readonly usage: AiUsageTruth;
      }
    | {
        readonly type: "interaction.required";
        readonly interactionRef: string;
      }
    | {
        readonly type: "completed";
        readonly status: "succeeded" | "failed" | "cancelled" | "timed_out";
      }
  );

export interface AiExecutionAttemptReceipt {
  readonly attempt: number;
  readonly target: AiResolvedTargetSnapshot;
  readonly dispatch:
    | { readonly status: "not-dispatched" }
    | {
        readonly status: "accepted" | "terminal";
        readonly idempotencyKey?: string;
      }
    | {
        readonly status: "outcome-unknown";
        readonly idempotencyKey?: string;
      };
  readonly usage: AiUsageTruth;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface AiExecutionReceipt {
  readonly schema: typeof AI_EXECUTION_RECEIPT_SCHEMA;
  readonly requestId: string;
  readonly correlationId: string;
  readonly operation: AiExecutionOperationKind;
  readonly requestedTarget: AiTargetSelector;
  readonly target: AiResolvedTargetSnapshot;
  readonly attempts: readonly AiExecutionAttemptReceipt[];
  readonly result: ExecutionResult;
  readonly usage: AiUsageTruth;
  readonly terminalEventSequence: number;
  readonly completedAt: string;
}

export interface AiExecutionAttemptReceiptV2
  extends Omit<AiExecutionAttemptReceipt, "target" | "usage"> {
  readonly binding: AiExecutionBinding;
  /** Alias retained for query compatibility; must equal `binding.target`. */
  readonly target: AiResolvedTargetSnapshot;
  readonly usage: AiUsageTruthV2;
}

/**
 * Production-grade receipt identity. V1 remains readable for existing hosts;
 * new hosts use V2 so every attempt and every priced charge is immutable and
 * independently attributable.
 */
export interface AiExecutionReceiptV2
  extends Omit<AiExecutionReceipt, "schema" | "attempts" | "usage"> {
  readonly schema: typeof AI_EXECUTION_RECEIPT_V2_SCHEMA;
  readonly binding: AiExecutionBinding;
  readonly attempts: readonly AiExecutionAttemptReceiptV2[];
  readonly usage: AiUsageTruthV2;
}

export type AiExecutionDiagnosticCode =
  | "AI_INVALID_SCHEMA"
  | "AI_INVALID_VALUE"
  | "AI_DUPLICATE_VALUE"
  | "AI_OPERATION_KIND_MISMATCH"
  | "AI_EXECUTION_KIND_INCOMPATIBLE"
  | "AI_TARGET_OPERATION_UNSUPPORTED"
  | "AI_CAPABILITY_ID_INVALID"
  | "AI_PUBLIC_TARGET_LEAK"
  | "AI_TARGET_SNAPSHOT_INVALID"
  | "AI_EXECUTION_OFFER_INVALID"
  | "AI_EXECUTION_BINDING_INVALID"
  | "AI_EXECUTION_BINDING_MISMATCH"
  | "AI_EXECUTION_BOUNDARY_INVALID"
  | "AI_CHARGE_BINDING_MISMATCH"
  | "AI_IDENTITY_MISMATCH"
  | "AI_ROUTE_TARGET_MISMATCH"
  | "AI_ATTEMPT_SEQUENCE_INVALID"
  | "AI_EVENT_SEQUENCE_INVALID"
  | "AI_TERMINAL_EVENT_INVALID"
  | "AI_USAGE_TRUTH_INVALID"
  | "AI_USAGE_RESULT_MISMATCH"
  | "AI_ATTEMPT_USAGE_MISMATCH"
  | "AI_TRANSCRIPT_RECEIPT_MISMATCH"
  | "AI_RESULT_STATUS_MISMATCH";

export interface AiExecutionDiagnostic {
  readonly code: AiExecutionDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface AiExecutionValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly AiExecutionDiagnostic[];
}

export interface AiExecutionRequestProjection extends AiExecutionValidation {
  readonly request: AiExecutionRequest;
}

/**
 * Compatibility projector for existing prompt, adapter-run, agent, and Worker
 * dispatch leaves. The caller must provide the operation-specific payload;
 * the projector never guesses modality from prompt text or provider metadata.
 */
