import { generateRunId } from "../pipeline-runtime/run-id.js";

export function resolvePipelineRunId(injected: string | undefined): string {
  if (injected === undefined) {
    return generateRunId();
  }
  if (
    injected.length < 1 ||
    injected.length > 200 ||
    injected.trim() !== injected ||
    /[\u0000-\u001f\u007f]/.test(injected)
  ) {
    throw new TypeError(
      "Pipeline runId must be a non-empty, trimmed identifier of at most 200 characters without control characters.",
    );
  }
  return injected;
}
