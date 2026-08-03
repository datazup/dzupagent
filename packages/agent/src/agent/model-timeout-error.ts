/**
 * Model-invocation deadline errors (ORCH-DSL-L1-C-01).
 *
 * Mirrors the tool-side shape in `tool-timeout-error.ts` rather than reusing
 * it: a stalled *model* call must not be reported as a tool timeout, because
 * callers branch on that distinction to decide whether retrying a tool or
 * failing the turn is the right recovery.
 */

export const MODEL_TIMEOUT_ERROR_CODE = "MODEL_TIMEOUT" as const;
export const MODEL_CANCELLED_ERROR_CODE = "MODEL_CANCELLED" as const;

export class ModelTimeoutError extends Error {
  readonly code = MODEL_TIMEOUT_ERROR_CODE;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Model invocation timed out after ${timeoutMs}ms`);
    this.name = "ModelTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isModelTimeoutError(err: unknown): err is ModelTimeoutError {
  if (err instanceof ModelTimeoutError) return true;
  if (err == null || typeof err !== "object") return false;
  return (err as { code?: unknown }).code === MODEL_TIMEOUT_ERROR_CODE;
}

export class ModelCancellationError extends Error {
  readonly code = MODEL_CANCELLED_ERROR_CODE;

  constructor() {
    super("Model invocation was cancelled");
    this.name = "ModelCancellationError";
  }
}

export function isModelCancellationError(
  err: unknown
): err is ModelCancellationError {
  if (err instanceof ModelCancellationError) return true;
  if (err == null || typeof err !== "object") return false;
  return (err as { code?: unknown }).code === MODEL_CANCELLED_ERROR_CODE;
}
