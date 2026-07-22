/**
 * Shared PipelineRuntime construction + terminal-result handling for compiled
 * workflows.
 *
 * Extracted from `compiled-workflow.ts` (DZUPAGENT-ARCH-M-06). Both the `run`
 * and `resume` lifecycles build an identical {@link PipelineRuntime} (same
 * definition, node executor, predicates, checkpoint store, and runtime-event
 * → workflow-event translation) and then share the same terminal cascade:
 * failed → journal `run_failed` + throw, suspended → return snapshot,
 * completed → journal `run_completed` + return.
 *
 * This module factors that duplicated machinery into one place. The two
 * lifecycles differ only in (a) the runtime entry call (`execute` vs `resume`)
 * and (b) the default failure message — both injected by the caller. Behaviour
 * is byte-for-byte identical to the original in-class implementation.
 *
 * @module workflow/compiled-workflow/execution-driver
 */
import type { PipelineCheckpointStore } from "@dzupagent/core/pipeline";
import type { RunJournal } from "@dzupagent/core/persistence";
import { PipelineRuntime } from "../../pipeline/pipeline-runtime.js";
import type {
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeEvent,
} from "../../pipeline/pipeline-runtime-types.js";
import type { PipelineStuckDetector } from "../../self-correction/pipeline-stuck-detector.js";
import { omitUndefined } from "../../utils/exact-optional.js";
import type { WorkflowCompilation } from "../workflow-compiler.js";
import type { WorkflowEvent } from "../workflow-types.js";
import { journalAppendGuarded } from "./journal-recorder.js";
import {
  extractFailure,
  handleRuntimeEvent,
} from "./runtime-event-dispatch.js";

/** Inputs shared by both the run and resume execution paths. */
export interface ExecutionDriverContext {
  compilation: WorkflowCompilation;
  journal: RunJournal | undefined;
  checkpointStore: PipelineCheckpointStore | undefined;
  runId: string;
  /** Raw caller channel (journal-degraded events go here). */
  emit: (event: WorkflowEvent) => void;
  /** Journal-mirroring wrapper around `emit`, passed to the runtime. */
  journalEmit: (event: WorkflowEvent) => void;
  /** Accessor for the latest observed state, mutated by the node executor. */
  getLatestState: () => Record<string, unknown>;
}

/**
 * Build a {@link PipelineRuntime} wired for a compiled-workflow run/resume.
 *
 * `onLatestState` is invoked by the compiled node executor with each new state
 * snapshot; `onFailure` records the first pipeline-level failure so the
 * terminal cascade can surface the real cause. `signal`, `stuckDetector`, and
 * `checkpointStore` are all optional (omitted when undefined).
 */
export function buildRuntime(params: {
  compilation: WorkflowCompilation;
  checkpointStore: PipelineCheckpointStore | undefined;
  journalEmit: (event: WorkflowEvent) => void;
  onLatestState: (state: Record<string, unknown>) => void;
  onFailure: (error: string) => void;
  signal?: AbortSignal | undefined;
  stuckDetector?: PipelineStuckDetector | undefined;
}): PipelineRuntime {
  const { compilation } = params;
  return new PipelineRuntime(
    omitUndefined({
      definition: compilation.definition,
      nodeExecutor: compilation.createNodeExecutor(
        params.journalEmit,
        params.onLatestState
      ),
      // Runtime implementation supports non-boolean branch keys, but the public
      // config type currently narrows predicates to boolean.
      predicates: compilation.predicates as Record<
        string,
        (state: Record<string, unknown>) => boolean
      >,
      signal: params.signal,
      checkpointStore: params.checkpointStore,
      stuckDetector: params.stuckDetector,
      onEvent: (event: PipelineRuntimeEvent) =>
        handleRuntimeEvent(
          event,
          compilation.suspendReasons,
          params.journalEmit,
          params.onFailure
        ),
    })
  );
}

/**
 * Drive the runtime to a terminal state and apply the shared journal + return
 * cascade used by both `run` and `resume`:
 *
 *  - `failed`   → journal `run_failed` (best-effort) then throw the error.
 *  - `suspended`→ return the latest observed state snapshot.
 *  - completed  → journal `run_completed` (best-effort) then return the state.
 *
 * On a thrown error, emits `workflow:failed` unless a pipeline-level failure was
 * already recorded. Always deletes the run from `deleteActiveRun` in `finally`.
 *
 * @param entry — the runtime entry call (`() => runtime.execute(state)` or
 *   `() => runtime.resume(checkpoint, additionalState)`).
 * @param getPipelineFailure — reads the recorded pipeline-level failure (if any).
 * @param defaultFailureMessage — fallback when no failure string is available.
 */
export async function driveToTerminal(
  ctx: ExecutionDriverContext,
  entry: () => Promise<PipelineRunResult>,
  getPipelineFailure: () => string | null,
  defaultFailureMessage: string,
  deleteActiveRun: () => void
): Promise<Record<string, unknown>> {
  const { journal, runId, emit, journalEmit, getLatestState } = ctx;
  try {
    const result = await entry();
    if (result.state === "failed") {
      const errorMsg =
        getPipelineFailure() ??
        extractFailure(result.nodeResults as Map<string, NodeResult>) ??
        defaultFailureMessage;
      if (journal) {
        await journalAppendGuarded(
          journal,
          runId,
          { type: "run_failed", data: { error: errorMsg } },
          emit
        );
      }
      throw new Error(errorMsg);
    }
    if (result.state === "suspended") {
      // Journal entry for suspension is already written via journalEmit when
      // the runtime emits the 'pipeline:suspended' event handler → 'suspended'
      // workflow event → journal 'run_suspended' append.
      return { ...getLatestState() };
    }
    if (journal) {
      await journalAppendGuarded(
        journal,
        runId,
        { type: "run_completed", data: { output: getLatestState() } },
        emit
      );
    }
    return { ...getLatestState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!getPipelineFailure()) {
      journalEmit({ type: "workflow:failed", error: message });
    }
    throw err;
  } finally {
    deleteActiveRun();
  }
}
