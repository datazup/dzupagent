/**
 * Whole-run wall-clock deadline (ORCH-DSL-L1-H-02).
 *
 * `maxIterations`, `maxTokens` and `maxCostCents` only advance when a call
 * *returns*, so none of them bound a run that is stalled rather than looping.
 * `CascadingTimeout` was implemented and unit-tested for exactly this but was
 * only ever barrel re-exported — this module is the production wiring.
 *
 * Composition rule: when the caller also supplied its own `AbortSignal`, the
 * effective signal aborts on *whichever fires first*, so an explicit cancel is
 * never delayed by a long deadline and vice versa.
 */
import { CascadingTimeout } from "../guardrails/cascading-timeout.js";

export interface RunDeadline {
  /** Signal to thread into the tool loop and model calls. */
  readonly signal: AbortSignal | undefined;
  /** Releases timers and listeners. Always call in a `finally`. */
  dispose(): void;
}

const NO_DEADLINE: RunDeadline = { signal: undefined, dispose: () => {} };

/**
 * Build the effective run signal from `guardrails.maxDurationMs` and any
 * caller-supplied signal.
 *
 * Returns the caller's signal unchanged when no duration is configured, so
 * runs that never opt in keep their previous behaviour exactly.
 */
export function createRunDeadline(
  maxDurationMs: number | undefined,
  callerSignal: AbortSignal | undefined
): RunDeadline {
  if (maxDurationMs === undefined || maxDurationMs <= 0) {
    return callerSignal
      ? { signal: callerSignal, dispose: () => {} }
      : NO_DEADLINE;
  }

  const timeout = CascadingTimeout.create(maxDurationMs);

  if (!callerSignal) {
    return { signal: timeout.signal, dispose: () => timeout.dispose() };
  }

  // Merge: abort on whichever source fires first.
  const controller = new AbortController();
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  if (callerSignal.aborted) {
    abort(callerSignal.reason);
  } else if (timeout.signal.aborted) {
    abort(timeout.signal.reason);
  }

  const onCallerAbort = () => abort(callerSignal.reason);
  const onTimeoutAbort = () => abort(timeout.signal.reason);
  callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  timeout.signal.addEventListener("abort", onTimeoutAbort, { once: true });

  return {
    signal: controller.signal,
    dispose: () => {
      callerSignal.removeEventListener("abort", onCallerAbort);
      timeout.signal.removeEventListener("abort", onTimeoutAbort);
      timeout.dispose();
    },
  };
}
