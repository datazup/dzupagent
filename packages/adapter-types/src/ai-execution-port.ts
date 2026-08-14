import {
  validateAiExecutionEvent,
  validateAiExecutionTranscript,
  type AiExecutionEvent,
  type AiExecutionReceipt,
  type AiExecutionReceiptV2,
  type AiExecutionRequest,
  type AiJsonValue,
} from "@dzupagent/runtime-contracts/ai-execution";

/** Read-compatible terminal receipt during the explicit V1-to-V2 migration. */
export type AiExecutionTerminalReceipt = AiExecutionReceipt | AiExecutionReceiptV2;

export type AiExecutionTerminalStatus = Extract<
  AiExecutionEvent,
  { readonly type: "completed" }
>["status"];

export interface AiExecutionCancellationRequest {
  readonly cancellationId: string;
  readonly executionId: string;
  readonly requestedAt: string;
  readonly reason?: string;
}

/** Cancellation acknowledgement is not terminal completion. */
export type AiExecutionCancellationAcknowledgement =
  | {
      readonly cancellationId: string;
      readonly executionId: string;
      readonly status: "requested" | "acknowledged";
      readonly acknowledgedAt: string;
    }
  | {
      readonly cancellationId: string;
      readonly executionId: string;
      readonly status: "already-terminal";
      readonly acknowledgedAt: string;
      readonly terminalStatus: AiExecutionTerminalStatus;
    }
  | {
      readonly cancellationId: string;
      readonly executionId: string;
      readonly status: "rejected";
      readonly acknowledgedAt: string;
      readonly reason: string;
    };

export interface AiExecutionInteractionSubmission {
  readonly executionId: string;
  readonly interactionRef: string;
  readonly submissionId: string;
  readonly submittedAt: string;
  readonly payload: AiJsonValue;
}

export type AiExecutionInteractionAcknowledgement =
  | {
      readonly executionId: string;
      readonly interactionRef: string;
      readonly submissionId: string;
      readonly status: "accepted" | "duplicate";
      readonly acknowledgedAt: string;
    }
  | {
      readonly executionId: string;
      readonly interactionRef: string;
      readonly submissionId: string;
      readonly status: "rejected";
      readonly acknowledgedAt: string;
      readonly reason: string;
    };

export interface AiExecutionStartOptions {
  readonly signal?: AbortSignal;
}

export interface InlineAiExecutionHandle {
  readonly executionId: string;
  readonly events: AsyncIterable<AiExecutionEvent>;
  /** The only terminal completion authority for this inline execution. */
  readonly completion: Promise<AiExecutionTerminalReceipt>;
  cancel(
    request: AiExecutionCancellationRequest,
  ): Promise<AiExecutionCancellationAcknowledgement>;
  submitInteraction(
    submission: AiExecutionInteractionSubmission,
  ): Promise<AiExecutionInteractionAcknowledgement>;
}

export interface InlineAiExecutionPort {
  start(
    request: AiExecutionRequest,
    options?: AiExecutionStartOptions,
  ): InlineAiExecutionHandle;
}

export interface AiDurableExecutionSubmission {
  readonly executionId: string;
  readonly acceptedAt: string;
  /** Opaque cursor from which a consumer may begin replay. */
  readonly replayCursor: string | null;
}

export type AiDurableExecutionStatus =
  | {
      readonly executionId: string;
      readonly terminal: false;
      readonly status:
        | "queued"
        | "running"
        | "interaction-required"
        | "cancellation-requested";
      readonly observedAt: string;
    }
  | {
      readonly executionId: string;
      readonly terminal: true;
      readonly status: AiExecutionTerminalStatus;
      readonly observedAt: string;
      /** The only terminal completion authority for this durable execution. */
      readonly receipt: AiExecutionTerminalReceipt;
    };

export interface AiExecutionEventPage {
  readonly executionId: string;
  /** Cursor supplied by the consumer; null starts at the first retained event. */
  readonly fromCursor: string | null;
  /** Sequence immediately before this page. Zero starts a full replay. */
  readonly afterSequence: number;
  readonly events: readonly AiExecutionEvent[];
  /** Cursor for the final event in this page, or fromCursor for an empty page. */
  readonly nextCursor: string | null;
  /** True only when the page ends with the execution's terminal event. */
  readonly terminal: boolean;
}

export interface AiExecutionEventPageOptions {
  readonly afterCursor?: string | null;
  readonly afterSequence?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface AiExecutionResumeRequest {
  readonly executionId: string;
  readonly resumeId: string;
  readonly requestedAt: string;
  readonly afterCursor?: string | null;
}

export type AiExecutionResumeAcknowledgement =
  | {
      readonly executionId: string;
      readonly resumeId: string;
      readonly status: "accepted" | "already-running";
      readonly acknowledgedAt: string;
    }
  | {
      readonly executionId: string;
      readonly resumeId: string;
      readonly status: "already-terminal";
      readonly acknowledgedAt: string;
      readonly terminalStatus: AiExecutionTerminalStatus;
    }
  | {
      readonly executionId: string;
      readonly resumeId: string;
      readonly status: "rejected";
      readonly acknowledgedAt: string;
      readonly reason: string;
    };

export interface DurableAiExecutionPort {
  submit(
    request: AiExecutionRequest,
    options?: AiExecutionStartOptions,
  ): Promise<AiDurableExecutionSubmission>;
  status(executionId: string): Promise<AiDurableExecutionStatus>;
  events(
    executionId: string,
    options?: AiExecutionEventPageOptions,
  ): Promise<AiExecutionEventPage>;
  cancel(
    request: AiExecutionCancellationRequest,
  ): Promise<AiExecutionCancellationAcknowledgement>;
  submitInteraction(
    submission: AiExecutionInteractionSubmission,
  ): Promise<AiExecutionInteractionAcknowledgement>;
  resume(
    request: AiExecutionResumeRequest,
  ): Promise<AiExecutionResumeAcknowledgement>;
}

export type AiExecutionProjectionDiagnosticCode =
  | "AI_PROJECTION_UNSUPPORTED"
  | "AI_PROJECTION_INVALID_SOURCE";

export interface AiExecutionProjectionDiagnostic {
  readonly code: AiExecutionProjectionDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly sourceKind?: string;
  readonly targetKind?: string;
}

export type AiExecutionProjection<T> =
  | {
      readonly supported: true;
      readonly value: T;
      readonly diagnostics: readonly [];
    }
  | {
      readonly supported: false;
      readonly diagnostics: readonly [
        AiExecutionProjectionDiagnostic,
        ...AiExecutionProjectionDiagnostic[],
      ];
    };

export function unsupportedAiExecutionProjection(
  sourceKind: string,
  targetKind: string,
  message = `Cannot project ${sourceKind} to ${targetKind}.`,
): AiExecutionProjection<never> {
  return {
    supported: false,
    diagnostics: [{
      code: "AI_PROJECTION_UNSUPPORTED",
      path: "$",
      message,
      sourceKind,
      targetKind,
    }],
  };
}

export type AiExecutionLifecycleDiagnosticCode =
  | "AI_LIFECYCLE_INVALID_PAGE"
  | "AI_LIFECYCLE_EVENT_INVALID"
  | "AI_LIFECYCLE_SEQUENCE_INVALID"
  | "AI_LIFECYCLE_CURSOR_INVALID"
  | "AI_LIFECYCLE_TERMINAL_CONFLICT"
  | "AI_LIFECYCLE_CANCELLATION_INVALID";

export interface AiExecutionLifecycleDiagnostic {
  readonly code: AiExecutionLifecycleDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface AiExecutionLifecycleValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly AiExecutionLifecycleDiagnostic[];
}

function lifecycleDiagnostic(
  diagnostics: AiExecutionLifecycleDiagnostic[],
  code: AiExecutionLifecycleDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

/** Validate an independently replayable event page without requiring terminality. */
export function validateAiExecutionEventPage(
  value: unknown,
): AiExecutionLifecycleValidation {
  const diagnostics: AiExecutionLifecycleDiagnostic[] = [];
  if (!isRecord(value) || !Array.isArray(value.events)) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_INVALID_PAGE", "$", "Event page must be an object with an events array.");
    return { valid: false, diagnostics };
  }
  const executionId = typeof value.executionId === "string" ? value.executionId : "";
  const afterSequence = typeof value.afterSequence === "number" ? value.afterSequence : Number.NaN;
  const terminal = value.terminal === true;
  const events = value.events;
  if (!executionId || !Number.isInteger(afterSequence) || afterSequence < 0) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_INVALID_PAGE", "afterSequence", "Event page identity and non-negative sequence are required.");
  }
  if (value.fromCursor !== null && !isNonEmptyString(value.fromCursor)) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_CURSOR_INVALID", "fromCursor", "fromCursor must be null or a non-empty opaque cursor.");
  }
  if (value.nextCursor !== null && !isNonEmptyString(value.nextCursor)) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_CURSOR_INVALID", "nextCursor", "nextCursor must be null or a non-empty opaque cursor.");
  }

  let terminalCount = 0;
  let requestId: unknown;
  let correlationId: unknown;
  const cursors = new Set<string>();
  events.forEach((event, index) => {
    const validation = validateAiExecutionEvent(event);
    if (!validation.valid) {
      lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_EVENT_INVALID", `events[${index}]`, validation.diagnostics.map(({ code }) => code).join(", "));
    }
    if (!isRecord(event)) return;
    if (index === 0) {
      requestId = event.requestId;
      correlationId = event.correlationId;
    } else if (event.requestId !== requestId || event.correlationId !== correlationId) {
      lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_EVENT_INVALID", `events[${index}]`, "Page events must share request and correlation identity.");
    }
    if (event.sequence !== afterSequence + index + 1) {
      lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_SEQUENCE_INVALID", `events[${index}].sequence`, "Page events must be contiguous from afterSequence.");
    }
    if (typeof event.cursor === "string") {
      if (cursors.has(event.cursor)) {
        lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_CURSOR_INVALID", `events[${index}].cursor`, "Page event cursors must be unique.");
      }
      cursors.add(event.cursor);
    }
    if (event.type === "completed") {
      terminalCount += 1;
      if (index !== events.length - 1) {
        lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_TERMINAL_CONFLICT", `events[${index}]`, "A terminal event must be the final event in a page.");
      }
    }
  });
  if (terminalCount > 1 || terminal !== (terminalCount === 1)) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_TERMINAL_CONFLICT", "terminal", "Page terminal state must correspond to exactly one final completed event.");
  }
  const finalEvent = events.at(-1);
  const expectedCursor = isRecord(finalEvent) && typeof finalEvent.cursor === "string"
    ? finalEvent.cursor
    : value.fromCursor ?? null;
  if (value.nextCursor !== expectedCursor) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_CURSOR_INVALID", "nextCursor", "nextCursor must identify the final event, or retain fromCursor for an empty page.");
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export interface AiExecutionTerminalObservation {
  readonly status: AiDurableExecutionStatus;
  readonly events: readonly AiExecutionEvent[];
}

/** Bind durable terminal status to the canonical transcript and receipt. */
export function validateAiExecutionTerminalObservation(
  value: unknown,
): AiExecutionLifecycleValidation {
  const diagnostics: AiExecutionLifecycleDiagnostic[] = [];
  if (!isRecord(value) || !isRecord(value.status) || !Array.isArray(value.events)) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_INVALID_PAGE", "$", "Terminal observation must include status and events.");
    return { valid: false, diagnostics };
  }
  if (value.status.terminal !== true || !isRecord(value.status.receipt)) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_TERMINAL_CONFLICT", "status", "Terminal observation requires one terminal status and receipt.");
    return { valid: false, diagnostics };
  }
  const transcript = validateAiExecutionTranscript(value.status.receipt, value.events);
  if (!transcript.valid) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_TERMINAL_CONFLICT", "events", transcript.diagnostics.map(({ code }) => code).join(", "));
  }
  const finalEvent = value.events.at(-1);
  if (!isRecord(finalEvent) || finalEvent.type !== "completed" || finalEvent.status !== value.status.status) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_TERMINAL_CONFLICT", "status.status", "Durable status must match the single terminal event.");
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function validateAiExecutionCancellationAcknowledgement(
  value: unknown,
): AiExecutionLifecycleValidation {
  const diagnostics: AiExecutionLifecycleDiagnostic[] = [];
  if (!isRecord(value)) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_CANCELLATION_INVALID", "$", "Cancellation acknowledgement must be an object.");
    return { valid: false, diagnostics };
  }
  for (const key of ["cancellationId", "executionId"] as const) {
    if (!isNonEmptyString(value[key])) {
      lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_CANCELLATION_INVALID", key, `${key} must be a non-empty string.`);
    }
  }
  if (!isIsoDate(value.acknowledgedAt)) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_CANCELLATION_INVALID", "acknowledgedAt", "Cancellation acknowledgement time must be ISO-8601.");
  }
  const statuses = new Set(["requested", "acknowledged", "already-terminal", "rejected"]);
  if (!statuses.has(String(value.status))) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_CANCELLATION_INVALID", "status", "Cancellation acknowledgement status is invalid.");
  }
  if (value.status === "already-terminal") {
    const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
    if (!terminal.has(String(value.terminalStatus))) {
      lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_CANCELLATION_INVALID", "terminalStatus", "An already-terminal cancellation race must disclose terminal status.");
    }
  } else if (value.terminalStatus !== undefined) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_CANCELLATION_INVALID", "terminalStatus", "Only an already-terminal acknowledgement may carry terminal status.");
  }
  if (value.status === "rejected" && (typeof value.reason !== "string" || value.reason.length === 0)) {
    lifecycleDiagnostic(diagnostics, "AI_LIFECYCLE_CANCELLATION_INVALID", "reason", "A rejected cancellation requires a reason.");
  }
  return { valid: diagnostics.length === 0, diagnostics };
}
