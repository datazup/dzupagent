/**
 * Best-effort run-journal recording for compiled workflows.
 *
 * Extracted from `compiled-workflow.ts` (DZUPAGENT-ARCH-M-06). Holds the
 * ERR-H-10 journal-write concern: a journal-backend outage must NOT crash the
 * run or mask the real run outcome. On failure these helpers surface a
 * `workflow:journal_degraded` event on the caller's own channel and log a
 * structured line — they never re-append to the same (failed) journal.
 *
 *  - `journalAppendGuarded` — append a run-lifecycle entry directly, guarded.
 *  - `journalWrite` — map a step/suspend WorkflowEvent to a journal append.
 *  - `makeJournalEmit` — wrap the caller's `emit` so every emitted event is
 *    also mirrored to the journal without letting a journal issue crash the run.
 *
 * Behaviour is byte-for-byte identical to the original in-class implementation.
 *
 * @module workflow/compiled-workflow/journal-recorder
 */
import type { RunJournal } from "@dzupagent/core/persistence";
import { defaultLogger } from "@dzupagent/core/utils";
import type { WorkflowEvent } from "../workflow-types.js";

/**
 * ERR-H-10: append a run-lifecycle entry (run_started/completed/failed/
 * resumed) directly, but treat the journal as best-effort: a journal-backend
 * outage must NOT crash the run or mask the real run outcome. On failure we
 * surface `workflow:journal_degraded` on the caller's event channel and log a
 * structured line — we never re-append to the same (failed) journal.
 */
export async function journalAppendGuarded(
  journal: RunJournal,
  runId: string,
  entry: Parameters<RunJournal["append"]>[1],
  emit: (event: WorkflowEvent) => void
): Promise<void> {
  try {
    await journal.append(runId, entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    defaultLogger.error("[compiled-workflow] run journal write failed", {
      operation: "workflow.journal.write",
      runId,
      eventType: entry.type,
      error: msg,
    });
    try {
      emit({ type: "workflow:journal_degraded", error: msg });
    } catch {
      // A throwing consumer channel must not escalate a journal degradation.
    }
  }
}

/**
 * Map a WorkflowEvent to a RunJournal entry append.
 * Fires asynchronously — errors are surfaced via `workflow:journal_degraded`
 * (ERR-H-10) rather than swallowed, but never break workflow execution.
 */
export async function journalWrite(
  journal: RunJournal,
  runId: string,
  event: WorkflowEvent,
  emit: (event: WorkflowEvent) => void
): Promise<void> {
  try {
    switch (event.type) {
      case "step:started":
        await journal.append(runId, {
          type: "step_started",
          data: { stepId: event.stepId },
        });
        break;
      case "step:completed":
        await journal.append(runId, {
          type: "step_completed",
          data: { stepId: event.stepId, durationMs: event.durationMs },
        });
        break;
      case "step:failed":
        await journal.append(runId, {
          type: "step_failed",
          data: { stepId: event.stepId, error: event.error },
        });
        break;
      case "suspended":
        await journal.append(runId, {
          type: "run_suspended",
          data: { stepId: "suspend", reason: event.reason },
        });
        break;
      // run_started, run_completed, run_failed are written directly in run()
      // to ensure correct ordering — skip them here.
      default:
        break;
    }
  } catch (err) {
    // ERR-H-10: journal writes must not break the workflow, but the failure
    // must be OBSERVABLE. Surface degradation on the caller's own event
    // channel (never re-append to the same journal that just failed — the
    // one failure mode that matters is the backend being unavailable, where
    // the error record would vanish too) and log a structured line.
    const msg = err instanceof Error ? err.message : String(err);
    defaultLogger.error("[compiled-workflow] run journal write failed", {
      operation: "workflow.journal.write",
      runId,
      eventType: event.type,
      error: msg,
    });
    try {
      emit({ type: "workflow:journal_degraded", error: msg });
    } catch {
      // A throwing consumer channel must not escalate a journal degradation.
    }
  }
}

/**
 * Build the `emit` wrapper used by {@link run} and {@link resume}.
 *
 * When a journal is configured, every emitted {@link WorkflowEvent} is also
 * mirrored to the journal via {@link journalWrite}. The mirror fires
 * asynchronously and any unexpected rejection is logged — a journal issue must
 * never crash the run. When no journal is configured the caller's `emit` is
 * returned unchanged.
 */
export function makeJournalEmit(
  journal: RunJournal | undefined,
  runId: string,
  emit: (event: WorkflowEvent) => void
): (event: WorkflowEvent) => void {
  if (!journal) return emit;
  return (event) => {
    emit(event);
    journalWrite(journal, runId, event, emit).catch((err: unknown) => {
      // journalWrite handles its own failures; this guards against an
      // unexpected rejection so a journal issue never crashes the run.
      defaultLogger.error(
        "[compiled-workflow] unexpected journal-write rejection",
        {
          operation: "workflow.journal.write",
          runId,
          error: err instanceof Error ? err.message : String(err),
        }
      );
    });
  };
}
