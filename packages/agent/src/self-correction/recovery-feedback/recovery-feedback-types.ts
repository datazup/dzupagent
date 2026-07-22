/**
 * Public type contracts for the recovery-feedback module.
 *
 * Extracted from `recovery-feedback.ts` as part of the god-module
 * decomposition (DZUPAGENT-ARCH-M-06). The composition root re-exports
 * these so existing consumers importing them from `recovery-feedback.js`
 * continue to work unchanged.
 *
 * @module self-correction/recovery-feedback/recovery-feedback-types
 */

import type { BaseStore } from "@langchain/langgraph";
import type {
  LearningCandidateStore,
  CandidatePromotionPolicy,
} from "../learning-candidate.js";

/** Configuration for the RecoveryFeedback module. */
export interface RecoveryFeedbackConfig {
  /** Memory store for persisting lessons. Optional — if not provided, feedback is no-op. */
  store?: BaseStore;
  /** Namespace prefix for lesson storage (default: ['recovery', 'lessons']). */
  namespace?: string[];
  /**
   * Candidate store for the staging layer. When provided, lessons are staged
   * as LearningCandidates and must be explicitly promoted before being written
   * to the durable store. Defaults to an InMemoryLearningCandidateStore.
   */
  candidateStore?: LearningCandidateStore;
  /**
   * Default promotion policy applied to all candidates that don't carry a
   * per-candidate `promotionPolicy`. Used by
   * {@link RecoveryFeedback.recordValidationOutcome} to decide when to
   * auto-promote a candidate. Defaults to {@link DEFAULT_PROMOTION_POLICY}.
   */
  promotionPolicy?: CandidatePromotionPolicy;
}

/**
 * Outcome of a single validation run against a staged candidate.
 *
 * `score` is on a 0-100 scale where >= policy.minScore counts as a successful
 * run. `runId` is included in the audit trail so operators can trace which
 * downstream run validated (or invalidated) the candidate.
 */
export interface CandidateValidationOutcome {
  candidateId: string;
  runId: string;
  score: number;
  /** Optional human-readable note appended to the audit entry. */
  note?: string;
}

/** Result of `recordValidationOutcome`. */
export interface ValidationOutcomeResult {
  candidateId: string;
  /** New status after the outcome was applied (may be `pending` if no threshold reached). */
  status: "pending" | "promoted" | "rejected";
  /** True when this outcome triggered an auto-promote / auto-reject transition. */
  autoActioned: boolean;
  successRunCount: number;
  failureRunCount: number;
  avgValidationScore: number;
}
