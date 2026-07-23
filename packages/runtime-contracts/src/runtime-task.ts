import type {
  ExecutionArtifactRef,
  ExecutionCancellationPolicy,
  ExecutionCapabilityRequirement,
  ExecutionEvidenceRequirement,
  ExecutionPolicy,
  SanitizedEvidenceRef,
} from "./canonical-execution.js";

export const RUNTIME_TASK_KINDS = [
  "queued-work",
  "mcp-task",
  "a2a-task",
  "child-flow",
  "external-task",
] as const;

export type RuntimeTaskKind = (typeof RUNTIME_TASK_KINDS)[number];

export const RUNTIME_TASK_STATES = [
  "requested",
  "queued",
  "running",
  "input-required",
  "auth-required",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;

export type RuntimeTaskState = (typeof RUNTIME_TASK_STATES)[number];
export type RuntimeTaskTerminalState =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface RuntimeTaskRef {
  readonly schema: "dzupagent.runtimeTaskRef/v1";
  readonly taskId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly kind: RuntimeTaskKind;
  readonly owner: string;
  readonly externalTaskId?: string;
  readonly contextId?: string;
}

export interface RuntimeTaskDelivery {
  readonly mode: "at-most-once" | "at-least-once";
  readonly idempotencyKey: string;
  readonly duplicateResult: "ignore-equal" | "reject";
}

export interface RuntimeTaskRequest {
  readonly schema: "dzupagent.runtimeTaskRequest/v1";
  readonly requestId: string;
  readonly correlationId: string;
  readonly task: RuntimeTaskRef;
  readonly operationRef: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly delivery: RuntimeTaskDelivery;
  readonly policy: ExecutionPolicy;
  readonly cancellation: ExecutionCancellationPolicy;
  readonly capabilityRequirements: readonly ExecutionCapabilityRequirement[];
  readonly evidenceRequirements: readonly ExecutionEvidenceRequirement[];
}

export interface RuntimeTaskError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

interface RuntimeTaskResultBase {
  readonly schema: "dzupagent.runtimeTaskResult/v1";
  readonly requestId: string;
  readonly correlationId: string;
  readonly task: RuntimeTaskRef;
  readonly evidence: readonly SanitizedEvidenceRef[];
  readonly artifacts: readonly ExecutionArtifactRef[];
}

export type RuntimeTaskResult =
  | (RuntimeTaskResultBase & {
      readonly state: "requested" | "queued" | "running";
    })
  | (RuntimeTaskResultBase & {
      readonly state: "input-required" | "auth-required";
      readonly continuationId: string;
    })
  | (RuntimeTaskResultBase & {
      readonly state: "succeeded";
      readonly output: unknown;
    })
  | (RuntimeTaskResultBase & {
      readonly state: "failed";
      readonly error: RuntimeTaskError;
    })
  | (RuntimeTaskResultBase & {
      readonly state: "cancelled" | "expired";
      readonly reason: string;
    });

const RUNTIME_TASK_TRANSITIONS: Readonly<
  Record<RuntimeTaskState, readonly RuntimeTaskState[]>
> = Object.freeze({
  requested: ["queued", "running", "cancelled", "expired"],
  queued: ["running", "cancelled", "expired"],
  running: [
    "input-required",
    "auth-required",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ],
  "input-required": ["running", "cancelled", "expired"],
  "auth-required": ["running", "cancelled", "expired"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
});

export type RuntimeTaskTransitionDiagnosticCode =
  | "TASK_ID_MISMATCH"
  | "ATTEMPT_ID_MISMATCH"
  | "GENERATION_MISMATCH"
  | "KIND_MISMATCH"
  | "OWNER_MISMATCH"
  | "INVALID_TASK_TRANSITION";

export interface RuntimeTaskTransitionDiagnostic {
  readonly code: RuntimeTaskTransitionDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface RuntimeTaskTransitionValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly RuntimeTaskTransitionDiagnostic[];
}

export function isRuntimeTaskTerminalState(
  state: RuntimeTaskState,
): state is RuntimeTaskTerminalState {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "expired"
  );
}

/**
 * Validate one persisted task-state transition.
 *
 * Retries use a new attempt/ref. This validator therefore rejects identity or
 * generation changes inside a single task history and all transitions out of
 * terminal states.
 */
export function validateRuntimeTaskTransition(
  previous: Pick<RuntimeTaskResult, "task" | "state">,
  next: Pick<RuntimeTaskResult, "task" | "state">,
): RuntimeTaskTransitionValidation {
  const diagnostics: RuntimeTaskTransitionDiagnostic[] = [];
  compareTaskIdentity(previous.task, next.task, diagnostics);

  if (!RUNTIME_TASK_TRANSITIONS[previous.state].includes(next.state)) {
    diagnostics.push({
      code: "INVALID_TASK_TRANSITION",
      path: "state",
      message: `Runtime task cannot transition from "${previous.state}" to "${next.state}".`,
    });
  }

  return {
    valid: diagnostics.length === 0,
    diagnostics,
  };
}

function compareTaskIdentity(
  previous: RuntimeTaskRef,
  next: RuntimeTaskRef,
  diagnostics: RuntimeTaskTransitionDiagnostic[],
): void {
  compare(
    previous.taskId,
    next.taskId,
    "TASK_ID_MISMATCH",
    "task.taskId",
    diagnostics,
  );
  compare(
    previous.attemptId,
    next.attemptId,
    "ATTEMPT_ID_MISMATCH",
    "task.attemptId",
    diagnostics,
  );
  if (previous.generation !== next.generation) {
    diagnostics.push({
      code: "GENERATION_MISMATCH",
      path: "task.generation",
      message: "Runtime task generation cannot change within one task history.",
    });
  }
  compare(
    previous.kind,
    next.kind,
    "KIND_MISMATCH",
    "task.kind",
    diagnostics,
  );
  compare(
    previous.owner,
    next.owner,
    "OWNER_MISMATCH",
    "task.owner",
    diagnostics,
  );
}

function compare(
  previous: string,
  next: string,
  code: RuntimeTaskTransitionDiagnosticCode,
  path: string,
  diagnostics: RuntimeTaskTransitionDiagnostic[],
): void {
  if (previous === next) return;
  diagnostics.push({
    code,
    path,
    message: `${path} cannot change within one task history.`,
  });
}
