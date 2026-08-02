import type { BaseMessage } from "@langchain/core/messages";
import type {
  CompressionDegradation,
  HardBudgetCompliance,
  TokenMeasurementResult,
} from "@dzupagent/context";
import type { HardBudgetHostProfileProof } from "./hard-budget-host-profile.js";
import type { ProtectedTranscriptEvidence } from "./hard-budget-protection.js";

/**
 * Result contracts for the runtime hard budget.
 *
 * These live in a leaf module rather than beside the runtime so that
 * `runtime-hard-budget.ts` (which imports the telemetry emitter as a value) and
 * `runtime-hard-budget-telemetry.ts` (which needs the result shape as a type)
 * can both depend on the contract without depending on each other. Declaring
 * them next to the runtime made that pair a cycle.
 */
export interface HardBudgetReservation {
  contextWindowTokens: number;
  inputTokenLimit: number;
  contentTokenLimit: number;
  transcriptTokenLimit: number;
  outputTokens: number;
  summaryTokens: number;
  toolTokens: number;
  envelopeTokens: number;
  totalReservedTokens: number;
}

export interface RuntimeHardBudgetResult {
  /** Original transcript on unsafe results; fitted transcript otherwise. */
  messages: BaseMessage[];
  summary: string | null;
  tokenMeasurement: TokenMeasurementResult;
  hardBudget: HardBudgetCompliance;
  reservation: HardBudgetReservation;
  profile?: HardBudgetHostProfileProof;
  protection?: ProtectedTranscriptEvidence;
  degradations?: CompressionDegradation[];
}

export interface RuntimeHardBudgetTextResult {
  /** Null means the caller must keep its original text and abort the handoff. */
  text: string | null;
  tokenMeasurement: TokenMeasurementResult;
  hardBudget: HardBudgetCompliance;
  reservation: HardBudgetReservation;
  profile?: HardBudgetHostProfileProof;
  degradation?: CompressionDegradation;
}
