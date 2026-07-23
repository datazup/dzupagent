import type { SanitizedEvidenceRef } from "./canonical-execution.js";

export const CONTINUATION_KINDS = [
  "input",
  "approval",
  "timer",
  "event",
  "task",
  "authentication",
] as const;

export type ContinuationKind = (typeof CONTINUATION_KINDS)[number];

export interface ContinuationRequest {
  readonly schema: "dzupagent.continuationRequest/v1";
  readonly continuationId: string;
  readonly correlationId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly kind: ContinuationKind;
  readonly subjectRef: string;
  readonly requestedAt: string;
  readonly expiresAt?: string;
  readonly response: {
    readonly required: boolean;
    readonly schemaRef?: string;
    readonly schema?: Readonly<Record<string, unknown>>;
  };
}

export type ContinuationResultStatus =
  | "resumed"
  | "denied"
  | "cancelled"
  | "expired"
  | "invalid";

export interface ContinuationResult {
  readonly schema: "dzupagent.continuationResult/v1";
  readonly continuationId: string;
  readonly correlationId: string;
  readonly generation: number;
  readonly status: ContinuationResultStatus;
  readonly decidedAt: string;
  readonly actorRef?: string;
  readonly payload?: unknown;
  readonly evidence: readonly SanitizedEvidenceRef[];
  readonly reason?: string;
}

export type ContinuationResultDiagnosticCode =
  | "CONTINUATION_ID_MISMATCH"
  | "CORRELATION_ID_MISMATCH"
  | "CONTINUATION_GENERATION_MISMATCH"
  | "MISSING_CONTINUATION_PAYLOAD"
  | "UNEXPECTED_CONTINUATION_PAYLOAD"
  | "MISSING_CONTINUATION_REASON";

export interface ContinuationResultDiagnostic {
  readonly code: ContinuationResultDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ContinuationResultValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly ContinuationResultDiagnostic[];
}

/**
 * Fail-closed continuation admission.
 *
 * A response is bound to the exact request identity and generation. Required
 * payloads are accepted only for resumed results; non-resume terminal results
 * must explain why no continuation occurred.
 */
export function validateContinuationResult(
  request: ContinuationRequest,
  result: ContinuationResult,
): ContinuationResultValidation {
  const diagnostics: ContinuationResultDiagnostic[] = [];

  if (result.continuationId !== request.continuationId) {
    diagnostics.push({
      code: "CONTINUATION_ID_MISMATCH",
      path: "continuationId",
      message: "Continuation result is bound to a different request.",
    });
  }
  if (result.correlationId !== request.correlationId) {
    diagnostics.push({
      code: "CORRELATION_ID_MISMATCH",
      path: "correlationId",
      message: "Continuation result correlationId does not match the request.",
    });
  }
  if (result.generation !== request.generation) {
    diagnostics.push({
      code: "CONTINUATION_GENERATION_MISMATCH",
      path: "generation",
      message: "Continuation result generation does not match the request.",
    });
  }

  if (
    result.status === "resumed" &&
    request.response.required &&
    result.payload === undefined
  ) {
    diagnostics.push({
      code: "MISSING_CONTINUATION_PAYLOAD",
      path: "payload",
      message: "A resumed continuation requires a response payload.",
    });
  }

  if (result.status !== "resumed" && result.payload !== undefined) {
    diagnostics.push({
      code: "UNEXPECTED_CONTINUATION_PAYLOAD",
      path: "payload",
      message: "Only a resumed continuation may carry a response payload.",
    });
  }

  if (
    result.status !== "resumed" &&
    (result.reason === undefined || result.reason.trim().length === 0)
  ) {
    diagnostics.push({
      code: "MISSING_CONTINUATION_REASON",
      path: "reason",
      message: `Continuation result "${result.status}" requires a reason.`,
    });
  }

  return {
    valid: diagnostics.length === 0,
    diagnostics,
  };
}
