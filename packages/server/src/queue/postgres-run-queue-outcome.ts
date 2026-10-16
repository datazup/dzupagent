/**
 * Outcome persistence helpers for {@link PostgresRunQueue}
 * (DZUPAGENT-ERR-H-82): a succeeded processor's `completed` write is retried
 * on its own, and every job-scoped queue error is logged with the same
 * structured fields.
 */
import { secureLogger } from "@dzupagent/core/utils";
import type { RunJob } from "./run-queue.js";

/** Attempts at persisting `completed` after the processor succeeded. */
export const MARK_COMPLETED_ATTEMPTS = 3;
/** Linear backoff step between `completed` persistence attempts. */
export const MARK_COMPLETED_BACKOFF_MS = 100;

/** Structured log fields for a job-scoped queue error. */
export function jobErrorFields(job: RunJob, error: unknown): Record<string, unknown> {
  return {
    jobId: job.id,
    runId: job.runId,
    attempt: job.attempts,
    errorClass: error instanceof Error ? error.constructor.name : typeof error,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Persist `completed` with a bounded retry. Exhausting the attempts rejects
 * (logged by the dispatch chain); the row stays `claimed`, never `pending`.
 */
export async function markCompletedWithRetry(
  job: RunJob,
  markCompleted: (job: RunJob) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await markCompleted(job);
      return;
    } catch (error) {
      if (attempt >= MARK_COMPLETED_ATTEMPTS) throw error;
      secureLogger.warn({
        level: "warn",
        operation: "run-queue.postgres.complete",
        message: `persisting completed failed (try ${attempt}/${MARK_COMPLETED_ATTEMPTS}); retrying`,
        ...jobErrorFields(job, error),
      });
      await new Promise((resolve) => setTimeout(resolve, MARK_COMPLETED_BACKOFF_MS * attempt));
    }
  }
}
