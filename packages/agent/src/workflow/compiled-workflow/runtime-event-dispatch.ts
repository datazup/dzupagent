/**
 * Pipeline → workflow runtime-event translation for compiled workflows.
 *
 * Extracted from `compiled-workflow.ts` (DZUPAGENT-ARCH-M-06). Maps the
 * low-level {@link PipelineRuntimeEvent}s emitted by {@link PipelineRuntime}
 * onto the public {@link WorkflowEvent} stream, and extracts a failure message
 * from per-node results.
 *
 *  - `handleRuntimeEvent` — translate one runtime event, emitting the matching
 *    workflow event and notifying the failure sink on `pipeline:failed`.
 *  - `extractFailure` — pull the first node-level error out of a results map.
 *
 * Behaviour is byte-for-byte identical to the original in-class implementation.
 *
 * @module workflow/compiled-workflow/runtime-event-dispatch
 */
import type { PipelineRuntimeEvent } from "../../pipeline/pipeline-runtime-types.js";
import type { WorkflowEvent } from "../workflow-types.js";

/**
 * Translate a {@link PipelineRuntimeEvent} into the workflow-level event
 * stream. `suspendReasons` maps node IDs to human-readable suspension reasons
 * (from the compilation); `onFailure` is notified with the error string on a
 * `pipeline:failed` event so the caller can surface the real cause.
 */
export function handleRuntimeEvent(
  event: PipelineRuntimeEvent,
  suspendReasons: ReadonlyMap<string, string>,
  emit: (event: WorkflowEvent) => void,
  onFailure: (error: string) => void
): void {
  switch (event.type) {
    case "pipeline:completed":
      emit({ type: "workflow:completed", durationMs: event.totalDurationMs });
      break;
    case "pipeline:failed":
      onFailure(event.error);
      emit({ type: "workflow:failed", error: event.error });
      break;
    case "pipeline:suspended": {
      const reason = suspendReasons.get(event.nodeId) ?? "suspended";
      emit({ type: "suspended", reason });
      break;
    }
    case "pipeline:stuck_detected":
      // Translate the pipeline-level stuck event into a workflow-level warning.
      // The executor will also abort the run via a pipeline:failed event when
      // suggestedAction === 'abort', so this event is informational (emit before
      // the failure lands so subscribers can react with context).
      emit({
        type: "workflow:stuck",
        nodeId: event.nodeId,
        reason: event.reason,
      });
      break;
    default:
      break;
  }
}

/** Return the first node-level error message in `nodeResults`, or `null`. */
export function extractFailure(
  nodeResults: Map<string, { error?: string }>
): string | null {
  for (const result of nodeResults.values()) {
    if (result.error) return result.error;
  }
  return null;
}
