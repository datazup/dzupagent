/**
 * Recovery feedback — persists recovery outcomes as lessons to memory
 * so the system can learn from past successes and failures.
 *
 * Uses `BaseStore` from `@langchain/langgraph` for persistence.
 * When no store is provided, all operations are no-ops, allowing
 * the feedback module to be optional.
 *
 * This module is the thin composition root for the recovery-feedback
 * concern. Public type contracts live in
 * `./recovery-feedback/recovery-feedback-types.js` and serialization
 * helpers live in `./recovery-feedback/recovery-feedback-serialization.js`;
 * both are re-exported here so existing consumers importing from this module
 * continue to work unchanged.
 *
 * @module self-correction/recovery-feedback
 */

import type { BaseStore } from "@langchain/langgraph";
import type { RecoveryLesson } from "./recovery-lesson-types.js";
import {
  type LearningCandidate,
  type LearningCandidateStore,
  type AuditEntry,
  type CandidatePromotionPolicy,
  DEFAULT_PROMOTION_POLICY,
  InMemoryLearningCandidateStore,
  appendAuditEntry,
} from "./learning-candidate.js";
import type {
  RecoveryFeedbackConfig,
  CandidateValidationOutcome,
  ValidationOutcomeResult,
} from "./recovery-feedback/recovery-feedback-types.js";
import {
  isLessonRecord,
  hydrateLesson,
  serializeLesson,
} from "./recovery-feedback/recovery-feedback-serialization.js";

// ---------------------------------------------------------------------------
// Re-exports (preserve the public surface after decomposition)
// ---------------------------------------------------------------------------

// Re-export RecoveryLesson so existing consumers importing it from this module
// continue to work after the type was extracted to break a circular import.
export type { RecoveryLesson } from "./recovery-lesson-types.js";

export type {
  RecoveryFeedbackConfig,
  CandidateValidationOutcome,
  ValidationOutcomeResult,
} from "./recovery-feedback/recovery-feedback-types.js";

// ---------------------------------------------------------------------------
// RecoveryFeedback
// ---------------------------------------------------------------------------

/**
 * Persists recovery outcomes (lessons) to a BaseStore and retrieves
 * similar past lessons to inform future recovery strategy selection.
 *
 * When no store is configured, durable writes and success-rate aggregation
 * gracefully no-op while in-memory learning candidates remain available for
 * review and same-process retrieval.
 */
export class RecoveryFeedback {
  private readonly store: BaseStore | undefined;
  private readonly namespace: string[];
  private readonly candidateStore: LearningCandidateStore;
  private readonly defaultPromotionPolicy: CandidatePromotionPolicy;
  private lessonCounter = 0;
  private candidateCounter = 0;

  constructor(config: RecoveryFeedbackConfig = {}) {
    this.store = config.store;
    this.namespace = config.namespace ?? ["recovery", "lessons"];
    this.candidateStore =
      config.candidateStore ?? new InMemoryLearningCandidateStore();
    this.defaultPromotionPolicy =
      config.promotionPolicy ?? DEFAULT_PROMOTION_POLICY;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Stage a recovery outcome as a LearningCandidate pending operator review.
   * The lesson is NOT written to the durable store until `promoteCandidate()` is called.
   * Returns the candidate ID so callers can include it in audit chains.
   */
  async recordOutcome(lesson: RecoveryLesson): Promise<string> {
    return this.stageCandidate(
      lesson,
      "system",
      `Staged from run ${lesson.id}`
    );
  }

  /**
   * Stage a lesson as a LearningCandidate with an explicit audit reason.
   * Returns the new candidate's ID.
   */
  stageCandidate(
    lesson: RecoveryLesson,
    actor: "system" | "operator" = "system",
    detail = "Recovery outcome staged for review"
  ): string {
    this.candidateCounter++;
    const candidateId = `cand_${Date.now()}_${this.candidateCounter}`;
    const now = new Date();
    const auditEntry: Omit<AuditEntry, "candidateId"> = {
      runId: lesson.id,
      nodeId: lesson.nodeId,
      event: "staged",
      actor,
      detail,
      timestamp: now,
    };
    const candidate: LearningCandidate = {
      id: candidateId,
      lesson,
      status: "pending",
      createdAt: now,
      auditTrail: [],
    };
    appendAuditEntry(candidate, auditEntry);
    this.candidateStore.add(candidate);
    return candidateId;
  }

  /**
   * Promote a pending candidate to durable memory.
   * No-op (returns false) if candidate not found or already reviewed.
   */
  async promoteCandidate(
    candidateId: string,
    reviewedBy = "operator"
  ): Promise<boolean> {
    const candidate = this.candidateStore.get(candidateId);
    if (!candidate || candidate.status !== "pending") return false;

    const now = new Date();
    candidate.status = "promoted";
    candidate.reviewedAt = now;
    candidate.reviewedBy = reviewedBy;
    appendAuditEntry(candidate, {
      runId: candidate.lesson.id,
      nodeId: candidate.lesson.nodeId,
      event: "promoted",
      actor: "operator",
      detail: `Promoted by ${reviewedBy}`,
      timestamp: now,
    });
    this.candidateStore.update(candidate);

    if (this.store) {
      const serialized = serializeLesson(candidate.lesson);
      await this.store.put(this.namespace, candidate.lesson.id, serialized);
    }

    return true;
  }

  /**
   * Reject a pending candidate. The lesson is NOT written to the durable store.
   * Returns false if candidate not found or already reviewed.
   */
  rejectCandidate(candidateId: string, reviewedBy = "operator"): boolean {
    const candidate = this.candidateStore.get(candidateId);
    if (!candidate || candidate.status !== "pending") return false;

    const now = new Date();
    candidate.status = "rejected";
    candidate.reviewedAt = now;
    candidate.reviewedBy = reviewedBy;
    appendAuditEntry(candidate, {
      runId: candidate.lesson.id,
      nodeId: candidate.lesson.nodeId,
      event: "rejected",
      actor: "operator",
      detail: `Rejected by ${reviewedBy}`,
      timestamp: now,
    });
    this.candidateStore.update(candidate);
    return true;
  }

  /**
   * Record a validation outcome against a staged candidate.
   *
   * Updates the candidate's running success/failure counters and average
   * score, then auto-promotes (if `successRunCount >= policy.minSuccessRuns`
   * AND `avgValidationScore >= policy.minScore`) or auto-rejects (if
   * `failureRunCount >= policy.maxFailureRuns`).
   *
   * Returns the new state. Returns `autoActioned: false` and current state
   * when the candidate is no longer pending or doesn't exist.
   */
  async recordValidationOutcome(
    outcome: CandidateValidationOutcome
  ): Promise<ValidationOutcomeResult> {
    const candidate = this.candidateStore.get(outcome.candidateId);
    if (!candidate) {
      return {
        candidateId: outcome.candidateId,
        status: "pending",
        autoActioned: false,
        successRunCount: 0,
        failureRunCount: 0,
        avgValidationScore: 0,
      };
    }

    const policy = candidate.promotionPolicy ?? this.defaultPromotionPolicy;
    const priorAvg = candidate.avgValidationScore ?? 0;
    const priorRuns =
      (candidate.successRunCount ?? 0) + (candidate.failureRunCount ?? 0);
    const newAvg =
      priorRuns === 0
        ? outcome.score
        : (priorAvg * priorRuns + outcome.score) / (priorRuns + 1);

    const isSuccess = outcome.score >= policy.minScore;
    candidate.latestValidationScore = outcome.score;
    candidate.avgValidationScore = newAvg;
    candidate.successRunCount =
      (candidate.successRunCount ?? 0) + (isSuccess ? 1 : 0);
    candidate.failureRunCount =
      (candidate.failureRunCount ?? 0) + (isSuccess ? 0 : 1);

    appendAuditEntry(candidate, {
      runId: outcome.runId,
      nodeId: candidate.lesson.nodeId,
      event: "validation_recorded",
      actor: "system",
      detail:
        outcome.note ??
        `Validation ${
          isSuccess ? "passed" : "failed"
        } (score ${outcome.score.toFixed(1)}, avg ${newAvg.toFixed(1)})`,
      timestamp: new Date(),
    });

    if (candidate.status !== "pending") {
      this.candidateStore.update(candidate);
      return {
        candidateId: candidate.id,
        status: candidate.status,
        autoActioned: false,
        successRunCount: candidate.successRunCount,
        failureRunCount: candidate.failureRunCount,
        avgValidationScore: newAvg,
      };
    }

    let autoActioned = false;
    if (
      candidate.successRunCount >= policy.minSuccessRuns &&
      newAvg >= policy.minScore
    ) {
      this.candidateStore.update(candidate);
      const ok = await this.promoteCandidate(candidate.id, "auto-validator");
      if (ok) {
        const promoted = this.candidateStore.get(candidate.id);
        if (promoted) {
          appendAuditEntry(promoted, {
            runId: outcome.runId,
            nodeId: promoted.lesson.nodeId,
            event: "auto_promoted",
            actor: "system",
            detail: `Auto-promoted: ${
              candidate.successRunCount
            } successful runs at avg ${newAvg.toFixed(1)} (>= ${
              policy.minScore
            })`,
            timestamp: new Date(),
          });
          this.candidateStore.update(promoted);
          autoActioned = true;
        }
      }
    } else if (candidate.failureRunCount >= policy.maxFailureRuns) {
      this.candidateStore.update(candidate);
      const ok = this.rejectCandidate(candidate.id, "auto-validator");
      if (ok) {
        const rejected = this.candidateStore.get(candidate.id);
        if (rejected) {
          appendAuditEntry(rejected, {
            runId: outcome.runId,
            nodeId: rejected.lesson.nodeId,
            event: "auto_rejected",
            actor: "system",
            detail: `Auto-rejected: ${candidate.failureRunCount} failed runs (>= ${policy.maxFailureRuns})`,
            timestamp: new Date(),
          });
          this.candidateStore.update(rejected);
          autoActioned = true;
        }
      }
    } else {
      this.candidateStore.update(candidate);
    }

    const finalCandidate = this.candidateStore.get(candidate.id);
    return {
      candidateId: candidate.id,
      status: finalCandidate?.status ?? "pending",
      autoActioned,
      successRunCount: candidate.successRunCount,
      failureRunCount: candidate.failureRunCount,
      avgValidationScore: newAvg,
    };
  }

  /**
   * List all pending LearningCandidates awaiting operator review.
   */
  listPendingCandidates(): LearningCandidate[] {
    return this.candidateStore.listByStatus("pending");
  }

  /**
   * Get a specific LearningCandidate by ID.
   */
  getCandidate(candidateId: string): LearningCandidate | undefined {
    return this.candidateStore.get(candidateId);
  }

  /**
   * Append an audit entry to a candidate's trail.
   * No-op if the candidate does not exist.
   */
  appendCandidateAuditEntry(
    candidateId: string,
    entry: Omit<AuditEntry, "candidateId">
  ): void {
    const candidate = this.candidateStore.get(candidateId);
    if (!candidate) return;
    appendAuditEntry(candidate, entry);
    this.candidateStore.update(candidate);
  }

  /**
   * Retrieve past recovery lessons for similar errors.
   *
   * Searches both the durable store (promoted lessons) and the candidate store
   * (pending/promoted candidates) by errorType and nodeId.
   * Returns up to `limit` results, sorted by most recent first.
   */
  async retrieveSimilar(
    errorType: string,
    nodeId: string,
    limit = 5
  ): Promise<RecoveryLesson[]> {
    const lessons: RecoveryLesson[] = [];
    const seen = new Set<string>();

    // Search durable store first (promoted lessons)
    if (this.store) {
      const results = await this.store.search(this.namespace, {
        filter: { errorType },
        limit: limit * 3, // over-fetch to filter by nodeId client-side
      });

      for (const item of results) {
        if (!isLessonRecord(item.value)) continue;
        if (
          typeof item.value.id !== "string" ||
          typeof item.value.errorType !== "string"
        ) {
          continue;
        }
        seen.add(item.value.id);
        lessons.push(hydrateLesson(item.value));
      }
    }

    // Also include lessons from the candidate store (any status — staged lessons
    // are immediately useful for decision-making even before promotion)
    for (const candidate of this.candidateStore.listByStatus("pending")) {
      const lesson = candidate.lesson;
      if (lesson.errorType !== errorType) continue;
      if (seen.has(lesson.id)) continue;
      seen.add(lesson.id);
      lessons.push(lesson);
    }
    for (const candidate of this.candidateStore.listByStatus("promoted")) {
      const lesson = candidate.lesson;
      if (lesson.errorType !== errorType) continue;
      if (seen.has(lesson.id)) continue;
      seen.add(lesson.id);
      lessons.push(lesson);
    }

    // Sort: same-node first, then by timestamp descending
    lessons.sort((a, b) => {
      const aMatchesNode = a.nodeId === nodeId ? 0 : 1;
      const bMatchesNode = b.nodeId === nodeId ? 0 : 1;
      if (aMatchesNode !== bMatchesNode) return aMatchesNode - bMatchesNode;
      return b.timestamp.getTime() - a.timestamp.getTime();
    });

    return lessons.slice(0, limit);
  }

  /**
   * Get the durable success rate for a given error type.
   * Returns `{ total: 0, successes: 0, rate: 0 }` if no store or no data.
   */
  async getSuccessRate(errorType: string): Promise<{
    total: number;
    successes: number;
    rate: number;
  }> {
    if (!this.store) return { total: 0, successes: 0, rate: 0 };

    const results = await this.store.search(this.namespace, {
      filter: { errorType },
      limit: 1000, // fetch all for this error type
    });

    let total = 0;
    let successes = 0;

    for (const item of results) {
      if (!isLessonRecord(item.value)) continue;
      if (
        item.value.outcome !== "success" &&
        item.value.outcome !== "failure"
      ) {
        continue;
      }
      total++;
      if (item.value.outcome === "success") successes++;
    }

    return {
      total,
      successes,
      rate: total > 0 ? successes / total : 0,
    };
  }

  /**
   * Generate a unique lesson ID.
   */
  generateLessonId(): string {
    this.lessonCounter++;
    return `lesson_${Date.now()}_${this.lessonCounter}`;
  }
}
