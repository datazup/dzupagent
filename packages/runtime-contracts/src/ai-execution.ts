import type {
  ExecutionArtifactRef,
  ExecutionRequest,
  ExecutionResult,
  ProviderExecutionBackend,
} from "./canonical-execution.js";

export type { ExecutionRequest } from "./canonical-execution.js";

export const AI_EXECUTION_REQUEST_SCHEMA =
  "dzupagent.aiExecutionRequest/v1" as const;
export const AI_PUBLIC_TARGET_SCHEMA =
  "dzupagent.aiPublicTarget/v1" as const;
export const AI_RESOLVED_TARGET_SCHEMA =
  "dzupagent.aiResolvedTarget/v1" as const;
export const AI_EXECUTION_EVENT_SCHEMA =
  "dzupagent.aiExecutionEvent/v1" as const;
export const AI_EXECUTION_RECEIPT_SCHEMA =
  "dzupagent.aiExecutionReceipt/v1" as const;

export const AI_EXECUTION_OPERATION_KINDS = [
  "text.generate",
  "chat.generate",
  "structured.generate",
  "embedding.create",
  "audio.transcribe",
  "speech.synthesize",
  "image.analyze",
  "token.count",
  "agent.run",
] as const;

export type AiExecutionOperationKind =
  (typeof AI_EXECUTION_OPERATION_KINDS)[number];

export const AI_TARGET_PLACEMENTS = ["server", "worker"] as const;
export type AiTargetPlacement = (typeof AI_TARGET_PLACEMENTS)[number];

export const AI_EXECUTION_STYLES = ["inline", "durable"] as const;
export type AiExecutionStyle = (typeof AI_EXECUTION_STYLES)[number];

/** Capability identifiers are stable names with an explicit major version. */
export const AI_CAPABILITY_ID_PATTERN =
  /^[a-z][a-z0-9.-]*\/v[1-9][0-9]*$/;

const AI_PUBLIC_TARGET_FORBIDDEN_KEYS = new Set([
  "apikey",
  "auth",
  "authref",
  "authsourceref",
  "backend",
  "command",
  "credential",
  "driver",
  "driverid",
  "endpoint",
  "filepath",
  "filesystempath",
  "model",
  "path",
  "profile",
  "profileref",
  "provider",
  "providerpath",
  "secret",
  "secretref",
  "token",
  "workerid",
  "workername",
  "workerref",
]);

export type AiJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AiJsonValue[]
  | { readonly [key: string]: AiJsonValue };

export interface AiTextGenerateOperation {
  readonly kind: "text.generate";
  readonly input: { readonly text: string };
  readonly output: { readonly modality: "text" };
}

export type AiChatRole = "system" | "user" | "assistant" | "tool";

export interface AiChatMessage {
  readonly role: AiChatRole;
  readonly content: string;
  readonly name?: string;
}

export interface AiChatGenerateOperation {
  readonly kind: "chat.generate";
  readonly input: { readonly messages: readonly AiChatMessage[] };
  readonly output: { readonly modality: "text" };
}

export interface AiStructuredGenerateOperation {
  readonly kind: "structured.generate";
  readonly input: { readonly prompt: string };
  readonly output: {
    readonly modality: "json";
    readonly schemaRef?: string;
    readonly schema?: Readonly<Record<string, AiJsonValue>>;
  };
}

export interface AiEmbeddingCreateOperation {
  readonly kind: "embedding.create";
  readonly input: { readonly texts: readonly string[] };
  readonly output: {
    readonly modality: "embedding";
    readonly dimensions?: number;
  };
}

export interface AiAudioTranscribeOperation {
  readonly kind: "audio.transcribe";
  readonly input: {
    readonly audio: ExecutionArtifactRef;
    readonly language?: string;
  };
  readonly output: { readonly modality: "text" };
}

export interface AiSpeechSynthesizeOperation {
  readonly kind: "speech.synthesize";
  readonly input: {
    readonly text: string;
    readonly voiceRef?: string;
  };
  readonly output: {
    readonly modality: "audio";
    readonly mediaTypes?: readonly string[];
  };
}

export interface AiImageAnalyzeOperation {
  readonly kind: "image.analyze";
  readonly input: {
    readonly images: readonly ExecutionArtifactRef[];
    readonly prompt?: string;
  };
  readonly output:
    | { readonly modality: "text" }
    | {
        readonly modality: "json";
        readonly schemaRef?: string;
        readonly schema?: Readonly<Record<string, AiJsonValue>>;
      };
}

export interface AiTokenCountOperation {
  readonly kind: "token.count";
  readonly input:
    | { readonly text: string; readonly messages?: never }
    | { readonly messages: readonly AiChatMessage[]; readonly text?: never };
  readonly output: { readonly modality: "token-count" };
}

export interface AiAgentRunOperation {
  readonly kind: "agent.run";
  readonly input: {
    readonly agentRef: string;
    readonly arguments?: Readonly<Record<string, AiJsonValue>>;
  };
  readonly output: { readonly modality: "text" | "json" | "unknown" };
}

export type AiExecutionOperation =
  | AiTextGenerateOperation
  | AiChatGenerateOperation
  | AiStructuredGenerateOperation
  | AiEmbeddingCreateOperation
  | AiAudioTranscribeOperation
  | AiSpeechSynthesizeOperation
  | AiImageAnalyzeOperation
  | AiTokenCountOperation
  | AiAgentRunOperation;

export type AiTargetSelector =
  | { readonly kind: "target-id"; readonly targetId: string }
  | { readonly kind: "task-profile"; readonly taskProfileId: string };

/**
 * Adds operation-specific input/output semantics to the existing canonical
 * ExecutionRequest. Route, policy, effect, cancellation, and evidence truth
 * remain owned by that canonical request instead of being redefined here.
 */
export interface AiExecutionRequest {
  readonly schema: typeof AI_EXECUTION_REQUEST_SCHEMA;
  readonly execution: ExecutionRequest;
  readonly operation: AiExecutionOperation;
  /** Opaque application catalog identity or app-owned task profile. */
  readonly target: AiTargetSelector;
}

export interface AiTargetHealth {
  readonly status: "healthy" | "degraded" | "unhealthy" | "unknown";
  readonly checkedAt?: string;
}

/** Safe to expose to a browser after the application has authorized listing. */
export interface AiPublicTargetDescriptor {
  readonly schema: typeof AI_PUBLIC_TARGET_SCHEMA;
  readonly targetId: string;
  readonly revision: string;
  readonly displayName: string;
  readonly operations: readonly AiExecutionOperationKind[];
  readonly capabilities: readonly string[];
  readonly placement: AiTargetPlacement;
  readonly executionStyle: AiExecutionStyle;
  readonly locality?: "local" | "private-network" | "remote";
  readonly health: AiTargetHealth;
}

/** Private immutable execution-time target projection retained in receipts. */
export interface AiResolvedTargetSnapshot {
  readonly schema: typeof AI_RESOLVED_TARGET_SCHEMA;
  readonly targetId: string;
  readonly targetRevision: string;
  readonly policyRevision: string;
  readonly operation: AiExecutionOperationKind;
  readonly placement: AiTargetPlacement;
  readonly executionStyle: AiExecutionStyle;
  readonly routeCandidateId: string;
  readonly backend: ProviderExecutionBackend;
  readonly provider?: string;
  readonly model?: string;
  readonly profileRef?: string;
  readonly workerRef?: string;
  readonly resolvedAt: string;
  readonly snapshotDigest: `sha256:${string}`;
}

export interface AiTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cachedInput?: number;
  readonly reasoning?: number;
}

export type AiCostTruth =
  | { readonly status: "unknown" }
  | {
      readonly status: "estimated" | "reconciled";
      readonly currency: string;
      readonly amountMicros: number;
    };

/** Unknown and partial usage are explicit states and are never interpreted as zero. */
export type AiUsageTruth =
  | {
      readonly measurement: "unknown";
      readonly cost: { readonly status: "unknown" };
    }
  | {
      readonly measurement: "partial";
      readonly tokens?: AiTokenUsage;
      readonly cost: AiCostTruth;
    }
  | {
      readonly measurement: "known";
      readonly tokens: AiTokenUsage;
      readonly cost: AiCostTruth;
    };

interface AiExecutionEventBase {
  readonly schema: typeof AI_EXECUTION_EVENT_SCHEMA;
  readonly requestId: string;
  readonly correlationId: string;
  readonly sequence: number;
  readonly cursor: string;
  readonly attempt: number;
  readonly emittedAt: string;
}

export type AiExecutionEvent = AiExecutionEventBase &
  (
    | { readonly type: "started" }
    | { readonly type: "output.delta"; readonly delta: string }
    | {
        readonly type: "artifact";
        readonly artifact: ExecutionArtifactRef;
      }
    | {
        readonly type: "usage";
        readonly usage: AiUsageTruth;
      }
    | {
        readonly type: "interaction.required";
        readonly interactionRef: string;
      }
    | {
        readonly type: "completed";
        readonly status: "succeeded" | "failed" | "cancelled" | "timed_out";
      }
  );

export interface AiExecutionAttemptReceipt {
  readonly attempt: number;
  readonly target: AiResolvedTargetSnapshot;
  readonly dispatch:
    | { readonly status: "not-dispatched" }
    | {
        readonly status: "accepted" | "terminal";
        readonly idempotencyKey?: string;
      }
    | {
        readonly status: "outcome-unknown";
        readonly idempotencyKey?: string;
      };
  readonly usage: AiUsageTruth;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface AiExecutionReceipt {
  readonly schema: typeof AI_EXECUTION_RECEIPT_SCHEMA;
  readonly requestId: string;
  readonly correlationId: string;
  readonly operation: AiExecutionOperationKind;
  readonly requestedTarget: AiTargetSelector;
  readonly target: AiResolvedTargetSnapshot;
  readonly attempts: readonly AiExecutionAttemptReceipt[];
  readonly result: ExecutionResult;
  readonly usage: AiUsageTruth;
  readonly terminalEventSequence: number;
  readonly completedAt: string;
}

export type AiExecutionDiagnosticCode =
  | "AI_INVALID_SCHEMA"
  | "AI_INVALID_VALUE"
  | "AI_DUPLICATE_VALUE"
  | "AI_OPERATION_KIND_MISMATCH"
  | "AI_EXECUTION_KIND_INCOMPATIBLE"
  | "AI_TARGET_OPERATION_UNSUPPORTED"
  | "AI_CAPABILITY_ID_INVALID"
  | "AI_PUBLIC_TARGET_LEAK"
  | "AI_TARGET_SNAPSHOT_INVALID"
  | "AI_IDENTITY_MISMATCH"
  | "AI_ROUTE_TARGET_MISMATCH"
  | "AI_ATTEMPT_SEQUENCE_INVALID"
  | "AI_EVENT_SEQUENCE_INVALID"
  | "AI_TERMINAL_EVENT_INVALID"
  | "AI_USAGE_TRUTH_INVALID"
  | "AI_USAGE_RESULT_MISMATCH"
  | "AI_ATTEMPT_USAGE_MISMATCH"
  | "AI_TRANSCRIPT_RECEIPT_MISMATCH"
  | "AI_RESULT_STATUS_MISMATCH";

export interface AiExecutionDiagnostic {
  readonly code: AiExecutionDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface AiExecutionValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly AiExecutionDiagnostic[];
}

export interface AiExecutionRequestProjection extends AiExecutionValidation {
  readonly request: AiExecutionRequest;
}

/**
 * Compatibility projector for existing prompt, adapter-run, agent, and Worker
 * dispatch leaves. The caller must provide the operation-specific payload;
 * the projector never guesses modality from prompt text or provider metadata.
 */
export function projectExecutionRequestToAi(
  execution: ExecutionRequest,
  operation: AiExecutionOperation,
  target: AiTargetSelector,
): AiExecutionRequestProjection {
  const request: AiExecutionRequest = {
    schema: AI_EXECUTION_REQUEST_SCHEMA,
    execution,
    operation,
    target,
  };
  return { request, ...validateAiExecutionRequest(request) };
}

export function validateAiExecutionRequest(
  value: unknown,
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (!isRecord(value)) {
    add(diagnostics, "AI_INVALID_VALUE", "$", "AI execution request must be an object.");
    return validation(diagnostics);
  }
  if (value.schema !== AI_EXECUTION_REQUEST_SCHEMA) {
    add(diagnostics, "AI_INVALID_SCHEMA", "schema", "Unsupported AI execution request schema.");
  }
  const execution = isRecord(value.execution) ? value.execution : undefined;
  nonEmpty(stringValue(execution?.requestId), "execution.requestId", diagnostics);
  nonEmpty(stringValue(execution?.correlationId), "execution.correlationId", diagnostics);
  validateTargetSelector(value.target, "target", diagnostics);
  validateOperation(value.operation, "operation", diagnostics);
  const operation = isRecord(value.operation) ? value.operation : undefined;
  validateExecutionKind(execution, stringValue(operation?.kind), diagnostics);
  return validation(diagnostics);
}

export function validateAiPublicTargetDescriptor(
  value: unknown,
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (!isRecord(value)) {
    add(diagnostics, "AI_INVALID_VALUE", "$", "Public AI target must be an object.");
    return validation(diagnostics);
  }
  if (value.schema !== AI_PUBLIC_TARGET_SCHEMA) {
    add(diagnostics, "AI_INVALID_SCHEMA", "schema", "Unsupported public AI target schema.");
  }
  nonEmpty(stringValue(value.targetId), "targetId", diagnostics);
  nonEmpty(stringValue(value.revision), "revision", diagnostics);
  nonEmpty(stringValue(value.displayName), "displayName", diagnostics);
  uniqueEnumValues(
    value.operations,
    AI_EXECUTION_OPERATION_KINDS,
    "operations",
    diagnostics,
  );
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    add(diagnostics, "AI_INVALID_VALUE", "operations", "A public target must declare at least one operation.");
  }
  uniqueStrings(value.capabilities, "capabilities", diagnostics);
  if (Array.isArray(value.capabilities)) {
    value.capabilities.forEach((capability, index) => {
      if (
        typeof capability === "string" &&
        !AI_CAPABILITY_ID_PATTERN.test(capability)
      ) {
        add(
          diagnostics,
          "AI_CAPABILITY_ID_INVALID",
          `capabilities[${index}]`,
          "Capability identifiers must use a stable lowercase name and /v<major> suffix.",
        );
      }
    });
  }
  enumValue(stringValue(value.placement), AI_TARGET_PLACEMENTS, "placement", diagnostics);
  enumValue(stringValue(value.executionStyle), AI_EXECUTION_STYLES, "executionStyle", diagnostics);
  const health = isRecord(value.health) ? value.health : undefined;
  enumValue(
    stringValue(health?.status),
    ["healthy", "degraded", "unhealthy", "unknown"] as const,
    "health.status",
    diagnostics,
  );
  for (const leakPath of collectPublicTargetLeakPaths(value)) {
    add(
      diagnostics,
      "AI_PUBLIC_TARGET_LEAK",
      leakPath,
      `Public targets cannot expose private routing field ${leakPath}.`,
    );
  }
  if (health?.checkedAt !== undefined && !isIsoDate(stringValue(health.checkedAt))) {
    add(diagnostics, "AI_INVALID_VALUE", "health.checkedAt", "Target health time must be ISO-8601.");
  }
  return validation(diagnostics);
}

export function validateAiExecutionTargetSelection(
  request: unknown,
  target: unknown,
): AiExecutionValidation {
  const diagnostics = [
    ...validateAiExecutionRequest(request).diagnostics,
    ...validateAiPublicTargetDescriptor(target).diagnostics,
  ];
  if (!isRecord(request) || !isRecord(target)) return validation(diagnostics);
  const operation = isRecord(request.operation) ? request.operation : undefined;
  const operationKind = stringValue(operation?.kind);
  const operations = Array.isArray(target.operations) ? target.operations : [];
  if (operationKind && !operations.includes(operationKind)) {
    add(
      diagnostics,
      "AI_TARGET_OPERATION_UNSUPPORTED",
      "target.operations",
      `Target ${String(target.targetId ?? "<invalid>")} does not support operation ${operationKind}.`,
    );
  }
  const selector = isRecord(request.target) ? request.target : undefined;
  if (
    selector?.kind === "target-id" &&
    selector.targetId !== target.targetId
  ) {
    add(
      diagnostics,
      "AI_IDENTITY_MISMATCH",
      "target.targetId",
      "Resolved public target differs from the requested opaque target.",
    );
  }
  return validation(diagnostics);
}

export function validateAiExecutionEvent(
  value: unknown,
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (!isRecord(value)) {
    add(diagnostics, "AI_INVALID_VALUE", "$", "AI execution event must be an object.");
    return validation(diagnostics);
  }
  if (value.schema !== AI_EXECUTION_EVENT_SCHEMA) {
    add(diagnostics, "AI_INVALID_SCHEMA", "schema", "Unsupported AI execution event schema.");
  }
  nonEmpty(stringValue(value.requestId), "requestId", diagnostics);
  nonEmpty(stringValue(value.correlationId), "correlationId", diagnostics);
  positiveInteger(numberValue(value.sequence), "sequence", diagnostics);
  positiveInteger(numberValue(value.attempt), "attempt", diagnostics);
  nonEmpty(stringValue(value.cursor), "cursor", diagnostics);
  if (!isIsoDate(stringValue(value.emittedAt))) {
    add(diagnostics, "AI_INVALID_VALUE", "emittedAt", "Event time must be ISO-8601.");
  }
  enumValue(
    stringValue(value.type),
    ["started", "output.delta", "artifact", "usage", "interaction.required", "completed"] as const,
    "type",
    diagnostics,
  );
  if (value.type === "output.delta") nonEmpty(stringValue(value.delta), "delta", diagnostics);
  if (value.type === "interaction.required") {
    nonEmpty(stringValue(value.interactionRef), "interactionRef", diagnostics);
  }
  if (value.type === "usage") validateUsage(value.usage, "usage", diagnostics);
  if (value.type === "artifact") validateArtifact(value.artifact, "artifact", diagnostics);
  if (value.type === "completed") {
    enumValue(
      stringValue(value.status),
      ["succeeded", "failed", "cancelled", "timed_out"] as const,
      "status",
      diagnostics,
    );
  }
  return validation(diagnostics);
}

export function validateAiExecutionEventSequence(
  values: unknown,
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (!Array.isArray(values) || values.length === 0) {
    add(diagnostics, "AI_EVENT_SEQUENCE_INVALID", "events", "At least one execution event is required.");
    return validation(diagnostics);
  }
  const first = isRecord(values[0]) ? values[0] : undefined;
  const cursors = new Set<string>();
  let lastAttempt = 0;
  let terminalCount = 0;
  values.forEach((candidate, index) => {
    const event = isRecord(candidate) ? candidate : undefined;
    diagnostics.push(
      ...validateAiExecutionEvent(candidate).diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: `events[${index}].${diagnostic.path}`,
      })),
    );
    if (!event || !first) return;
    if (
      event.requestId !== first.requestId ||
      event.correlationId !== first.correlationId
    ) {
      add(
        diagnostics,
        "AI_IDENTITY_MISMATCH",
        `events[${index}]`,
        "All events must share one request and correlation identity.",
      );
    }
    if (event.sequence !== index + 1) {
      add(
        diagnostics,
        "AI_EVENT_SEQUENCE_INVALID",
        `events[${index}].sequence`,
        "Event sequences must be contiguous and one-based.",
      );
    }
    const cursor = stringValue(event.cursor);
    if (cursor !== undefined && cursors.has(cursor)) {
      add(
        diagnostics,
        "AI_EVENT_SEQUENCE_INVALID",
        `events[${index}].cursor`,
        "Event cursors must be unique within an execution.",
      );
    }
    if (cursor !== undefined) cursors.add(cursor);
    const attempt = numberValue(event.attempt) ?? 0;
    if (attempt < lastAttempt) {
      add(
        diagnostics,
        "AI_EVENT_SEQUENCE_INVALID",
        `events[${index}].attempt`,
        "Event attempts cannot move backwards.",
      );
    }
    lastAttempt = attempt;
    if (event.type === "completed") {
      terminalCount += 1;
      if (index !== values.length - 1) {
        add(
          diagnostics,
          "AI_TERMINAL_EVENT_INVALID",
          `events[${index}]`,
          "The terminal event must be the final event.",
        );
      }
    }
  });
  if (terminalCount !== 1) {
    add(
      diagnostics,
      "AI_TERMINAL_EVENT_INVALID",
      "events",
      "An execution event sequence requires exactly one terminal event.",
    );
  }
  return validation(diagnostics);
}

export function validateAiExecutionReceipt(
  value: unknown,
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (!isRecord(value)) {
    add(diagnostics, "AI_INVALID_VALUE", "$", "AI execution receipt must be an object.");
    return validation(diagnostics);
  }
  if (value.schema !== AI_EXECUTION_RECEIPT_SCHEMA) {
    add(diagnostics, "AI_INVALID_SCHEMA", "schema", "Unsupported AI execution receipt schema.");
  }
  nonEmpty(stringValue(value.requestId), "requestId", diagnostics);
  nonEmpty(stringValue(value.correlationId), "correlationId", diagnostics);
  enumValue(stringValue(value.operation), AI_EXECUTION_OPERATION_KINDS, "operation", diagnostics);
  validateTargetSelector(value.requestedTarget, "requestedTarget", diagnostics);
  validateTargetSnapshot(value.target, "target", diagnostics);
  const requestedTarget = isRecord(value.requestedTarget) ? value.requestedTarget : undefined;
  const target = isRecord(value.target) ? value.target : undefined;
  if (
    requestedTarget?.kind === "target-id" &&
    requestedTarget.targetId !== target?.targetId
  ) {
    add(
      diagnostics,
      "AI_IDENTITY_MISMATCH",
      "target.targetId",
      "Resolved target differs from the requested logical target.",
    );
  }
  if (target?.operation !== value.operation) {
    add(
      diagnostics,
      "AI_OPERATION_KIND_MISMATCH",
      "target.operation",
      "Resolved target operation must match the receipt operation.",
    );
  }
  if (!Array.isArray(value.attempts) || value.attempts.length === 0) {
    add(diagnostics, "AI_INVALID_VALUE", "attempts", "An execution receipt requires at least one attempt.");
  }
  const attempts = Array.isArray(value.attempts) ? value.attempts : [];
  attempts.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      add(diagnostics, "AI_INVALID_VALUE", `attempts[${index}]`, "Execution attempt must be an object.");
      return;
    }
    const attempt = candidate;
    if (attempt.attempt !== index + 1) {
      add(
        diagnostics,
        "AI_ATTEMPT_SEQUENCE_INVALID",
        `attempts[${index}].attempt`,
        "Attempts must be contiguous and one-based.",
      );
    }
    validateTargetSnapshot(attempt.target, `attempts[${index}].target`, diagnostics);
    const attemptTarget = isRecord(attempt.target) ? attempt.target : undefined;
    if (attemptTarget?.operation !== value.operation) {
      add(
        diagnostics,
        "AI_OPERATION_KIND_MISMATCH",
        `attempts[${index}].target.operation`,
        "Attempt target operation must match the receipt operation.",
      );
    }
    validateUsage(attempt.usage, `attempts[${index}].usage`, diagnostics);
    validateOptionalTime(stringValue(attempt.startedAt), `attempts[${index}].startedAt`, diagnostics);
    validateOptionalTime(stringValue(attempt.completedAt), `attempts[${index}].completedAt`, diagnostics);
    validateDispatch(attempt.dispatch, `attempts[${index}].dispatch`, diagnostics);
  });
  const lastAttempt = attempts.at(-1);
  const lastTarget = isRecord(lastAttempt) && isRecord(lastAttempt.target)
    ? lastAttempt.target
    : undefined;
  if (
    attempts.length > 0 &&
    lastTarget?.snapshotDigest !== target?.snapshotDigest
  ) {
    add(
      diagnostics,
      "AI_TARGET_SNAPSHOT_INVALID",
      "target.snapshotDigest",
      "Receipt target must be the final attempt target snapshot.",
    );
  }
  const result = isRecord(value.result) ? value.result : undefined;
  if (result?.requestId !== value.requestId) {
    add(diagnostics, "AI_IDENTITY_MISMATCH", "result.requestId", "Result requestId differs from the receipt.");
  }
  if (result?.correlationId !== value.correlationId) {
    add(
      diagnostics,
      "AI_IDENTITY_MISMATCH",
      "result.correlationId",
      "Result correlationId differs from the receipt.",
    );
  }
  const routeDecision = isRecord(result?.routeDecision) ? result.routeDecision : undefined;
  if (
    routeDecision?.selectedCandidateId !== target?.routeCandidateId
  ) {
    add(
      diagnostics,
      "AI_ROUTE_TARGET_MISMATCH",
      "target.routeCandidateId",
      "Receipt target must match the canonical route decision.",
    );
  }
  validateUsage(value.usage, "usage", diagnostics);
  validateCanonicalUsageAlignment(result?.usage, value.usage, diagnostics);
  validateAttemptUsageAlignment(attempts, value.usage, diagnostics);
  positiveInteger(numberValue(value.terminalEventSequence), "terminalEventSequence", diagnostics);
  if (!isIsoDate(stringValue(value.completedAt))) {
    add(diagnostics, "AI_INVALID_VALUE", "completedAt", "Receipt completion time must be ISO-8601.");
  }
  if (
    result?.status === "succeeded" &&
    (!isRecord(lastAttempt) ||
      !isRecord(lastAttempt.dispatch) ||
      lastAttempt.dispatch.status !== "terminal")
  ) {
    add(
      diagnostics,
      "AI_RESULT_STATUS_MISMATCH",
      "attempts",
      "A successful result requires a terminal final dispatch attempt.",
    );
  }
  return validation(diagnostics);
}

/** Validates one retained event transcript against its terminal receipt. */
export function validateAiExecutionTranscript(
  receipt: unknown,
  events: unknown,
): AiExecutionValidation {
  const diagnostics = [
    ...validateAiExecutionReceipt(receipt).diagnostics,
    ...validateAiExecutionEventSequence(events).diagnostics,
  ];
  if (!isRecord(receipt) || !Array.isArray(events) || events.length === 0) {
    return validation(diagnostics);
  }
  const terminal = isRecord(events.at(-1)) ? events.at(-1) : undefined;
  const result = isRecord(receipt.result) ? receipt.result : undefined;
  if (
    terminal?.requestId !== receipt.requestId ||
    terminal?.correlationId !== receipt.correlationId
  ) {
    add(
      diagnostics,
      "AI_TRANSCRIPT_RECEIPT_MISMATCH",
      "events",
      "Transcript and receipt identities must match.",
    );
  }
  if (terminal?.sequence !== receipt.terminalEventSequence) {
    add(
      diagnostics,
      "AI_TRANSCRIPT_RECEIPT_MISMATCH",
      "terminalEventSequence",
      "Receipt terminal sequence must match the final event.",
    );
  }
  if (terminal?.type !== "completed" || terminal.status !== result?.status) {
    add(
      diagnostics,
      "AI_TRANSCRIPT_RECEIPT_MISMATCH",
      "events",
      "Final event status must match the canonical result status.",
    );
  }
  const latestUsage = [...events]
    .reverse()
    .find((event) => isRecord(event) && event.type === "usage");
  if (
    isRecord(latestUsage) &&
    isRecord(receipt.usage) &&
    !jsonEqual(latestUsage.usage, receipt.usage)
  ) {
    add(
      diagnostics,
      "AI_TRANSCRIPT_RECEIPT_MISMATCH",
      "usage",
      "Latest transcript usage truth must match the terminal receipt.",
    );
  }
  return validation(diagnostics);
}

function validateOperation(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!isRecord(value)) {
    add(diagnostics, "AI_INVALID_VALUE", path, "AI execution operation must be an object.");
    return;
  }
  const kind = value.kind;
  if (!(AI_EXECUTION_OPERATION_KINDS as readonly unknown[]).includes(kind)) {
    add(diagnostics, "AI_INVALID_VALUE", `${path}.kind`, "Unsupported AI execution operation.");
    return;
  }
  const input = isRecord(value.input) ? value.input : {};
  const output = isRecord(value.output) ? value.output : {};
  switch (kind) {
    case "text.generate":
      nonEmpty(stringValue(input.text), `${path}.input.text`, diagnostics);
      enumValue(stringValue(output.modality), ["text"] as const, `${path}.output.modality`, diagnostics);
      break;
    case "chat.generate":
      validateMessages(input.messages, `${path}.input.messages`, diagnostics);
      enumValue(stringValue(output.modality), ["text"] as const, `${path}.output.modality`, diagnostics);
      break;
    case "structured.generate":
      nonEmpty(stringValue(input.prompt), `${path}.input.prompt`, diagnostics);
      enumValue(stringValue(output.modality), ["json"] as const, `${path}.output.modality`, diagnostics);
      if (!output.schemaRef && !output.schema) {
        add(diagnostics, "AI_INVALID_VALUE", `${path}.output`, "Structured output requires a schemaRef or inline schema.");
      }
      break;
    case "embedding.create":
      nonEmptyStrings(input.texts, `${path}.input.texts`, diagnostics);
      enumValue(stringValue(output.modality), ["embedding"] as const, `${path}.output.modality`, diagnostics);
      if (output.dimensions !== undefined) {
        positiveInteger(numberValue(output.dimensions), `${path}.output.dimensions`, diagnostics);
      }
      break;
    case "audio.transcribe":
      validateArtifact(input.audio, `${path}.input.audio`, diagnostics);
      enumValue(stringValue(output.modality), ["text"] as const, `${path}.output.modality`, diagnostics);
      break;
    case "speech.synthesize":
      nonEmpty(stringValue(input.text), `${path}.input.text`, diagnostics);
      enumValue(stringValue(output.modality), ["audio"] as const, `${path}.output.modality`, diagnostics);
      if (input.voiceRef !== undefined) nonEmpty(stringValue(input.voiceRef), `${path}.input.voiceRef`, diagnostics);
      if (output.mediaTypes !== undefined) {
        nonEmptyStrings(output.mediaTypes, `${path}.output.mediaTypes`, diagnostics);
      }
      break;
    case "image.analyze":
      if (!Array.isArray(input.images) || input.images.length === 0) {
        add(diagnostics, "AI_INVALID_VALUE", `${path}.input.images`, "Image analysis requires at least one image artifact.");
      }
      (Array.isArray(input.images) ? input.images : []).forEach((artifact, index) =>
        validateArtifact(artifact, `${path}.input.images[${index}]`, diagnostics),
      );
      enumValue(stringValue(output.modality), ["text", "json"] as const, `${path}.output.modality`, diagnostics);
      if (output.modality === "json" && !output.schemaRef && !output.schema) {
        add(diagnostics, "AI_INVALID_VALUE", `${path}.output`, "JSON image analysis requires a schemaRef or inline schema.");
      }
      break;
    case "token.count":
      if (Object.hasOwn(input, "text")) nonEmpty(stringValue(input.text), `${path}.input.text`, diagnostics);
      else validateMessages(input.messages, `${path}.input.messages`, diagnostics);
      enumValue(stringValue(output.modality), ["token-count"] as const, `${path}.output.modality`, diagnostics);
      break;
    case "agent.run":
      nonEmpty(stringValue(input.agentRef), `${path}.input.agentRef`, diagnostics);
      enumValue(stringValue(output.modality), ["text", "json", "unknown"] as const, `${path}.output.modality`, diagnostics);
      break;
  }
}

function validateExecutionKind(
  execution: unknown,
  operation: string | undefined,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!isRecord(execution) || !operation) return;
  const executionKind = stringValue(execution.kind);
  const compatible =
    operation === "agent.run"
      ? executionKind === "agent" ||
        executionKind === "adapter.run" ||
        executionKind === "worker.dispatch"
      : executionKind === "prompt" ||
        executionKind === "adapter.run" ||
        executionKind === "worker.dispatch";
  if (!compatible) {
    add(
      diagnostics,
      "AI_EXECUTION_KIND_INCOMPATIBLE",
      "execution.kind",
      `Canonical execution kind ${String(executionKind)} cannot host operation ${operation}.`,
    );
  }
}

function validateTargetSnapshot(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!isRecord(value) || value.schema !== AI_RESOLVED_TARGET_SCHEMA) {
    add(diagnostics, "AI_INVALID_SCHEMA", `${path}.schema`, "Unsupported resolved AI target schema.");
    return;
  }
  nonEmpty(stringValue(value.targetId), `${path}.targetId`, diagnostics);
  nonEmpty(stringValue(value.targetRevision), `${path}.targetRevision`, diagnostics);
  nonEmpty(stringValue(value.policyRevision), `${path}.policyRevision`, diagnostics);
  nonEmpty(stringValue(value.routeCandidateId), `${path}.routeCandidateId`, diagnostics);
  enumValue(stringValue(value.operation), AI_EXECUTION_OPERATION_KINDS, `${path}.operation`, diagnostics);
  enumValue(stringValue(value.placement), AI_TARGET_PLACEMENTS, `${path}.placement`, diagnostics);
  enumValue(stringValue(value.executionStyle), AI_EXECUTION_STYLES, `${path}.executionStyle`, diagnostics);
  if (!/^sha256:[a-f0-9]{64}$/.test(stringValue(value.snapshotDigest) ?? "")) {
    add(
      diagnostics,
      "AI_TARGET_SNAPSHOT_INVALID",
      `${path}.snapshotDigest`,
      "Target snapshot identity must be a lowercase SHA-256 digest.",
    );
  }
  if (!isIsoDate(value.resolvedAt)) {
    add(diagnostics, "AI_INVALID_VALUE", `${path}.resolvedAt`, "Target resolution time must be ISO-8601.");
  }
}

function collectPublicTargetLeakPaths(
  value: unknown,
  path = "$",
  seen = new WeakSet<object>(),
): string[] {
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectPublicTargetLeakPaths(item, `${path}[${index}]`, seen),
    );
  }
  return Object.entries(value).flatMap(([key, nested]) => {
    const nestedPath = path === "$" ? key : `${path}.${key}`;
    const normalized = key.replaceAll(/[-_]/g, "").toLowerCase();
    return [
      ...(AI_PUBLIC_TARGET_FORBIDDEN_KEYS.has(normalized) ? [nestedPath] : []),
      ...collectPublicTargetLeakPaths(nested, nestedPath, seen),
    ];
  });
}

function validateTargetSelector(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!isRecord(value)) {
    add(diagnostics, "AI_INVALID_VALUE", `${path}.kind`, "Target selector must use target-id or task-profile.");
  } else if (value.kind === "target-id") {
    nonEmpty(stringValue(value.targetId), `${path}.targetId`, diagnostics);
  } else if (value.kind === "task-profile") {
    nonEmpty(stringValue(value.taskProfileId), `${path}.taskProfileId`, diagnostics);
  } else {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      `${path}.kind`,
      "Target selector must use target-id or task-profile.",
    );
  }
}

function validateUsage(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!isRecord(value) || !isRecord(value.cost)) {
    add(diagnostics, "AI_USAGE_TRUTH_INVALID", path, "Usage truth is required.");
    return;
  }
  enumValue(
    stringValue(value.measurement),
    ["unknown", "partial", "known"] as const,
    `${path}.measurement`,
    diagnostics,
  );
  enumValue(
    stringValue(value.cost.status),
    ["unknown", "estimated", "reconciled"] as const,
    `${path}.cost.status`,
    diagnostics,
  );
  if (value.measurement === "unknown") {
    if (value.cost.status !== "unknown" || Object.hasOwn(value, "tokens")) {
      add(
        diagnostics,
        "AI_USAGE_TRUTH_INVALID",
        path,
        "Unknown usage cannot carry token or monetary values.",
      );
    }
    return;
  }
  if (isRecord(value.tokens)) {
    for (const [key, amount] of Object.entries(value.tokens)) {
      const numeric = numberValue(amount);
      if (!Number.isSafeInteger(numeric) || (numeric ?? -1) < 0) {
        add(
          diagnostics,
          "AI_USAGE_TRUTH_INVALID",
          `${path}.tokens.${key}`,
          "Token counts must be non-negative safe integers.",
        );
      }
    }
  } else if (value.measurement === "known") {
    add(diagnostics, "AI_USAGE_TRUTH_INVALID", `${path}.tokens`, "Known usage requires token measurements.");
  }
  if (value.cost.status !== "unknown") {
    if (!/^[A-Z]{3}$/.test(stringValue(value.cost.currency) ?? "")) {
      add(diagnostics, "AI_USAGE_TRUTH_INVALID", `${path}.cost.currency`, "Cost currency must be an uppercase ISO-style code.");
    }
    const amountMicros = numberValue(value.cost.amountMicros);
    if (!Number.isSafeInteger(amountMicros) || (amountMicros ?? -1) < 0) {
      add(diagnostics, "AI_USAGE_TRUTH_INVALID", `${path}.cost.amountMicros`, "Cost must use non-negative integer micro-units.");
    }
  }
  if (value.measurement === "partial" && !isRecord(value.tokens) && value.cost.status === "unknown") {
    add(
      diagnostics,
      "AI_USAGE_TRUTH_INVALID",
      path,
      "Partial usage requires at least one measured token or monetary value.",
    );
  }
}

function validateCanonicalUsageAlignment(
  canonical: unknown,
  usage: unknown,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!isRecord(canonical)) return;
  if (!isRecord(usage) || usage.measurement === "unknown") {
    add(
      diagnostics,
      "AI_USAGE_RESULT_MISMATCH",
      "result.usage",
      "Canonical result usage cannot carry measured values when receipt usage is unknown.",
    );
    return;
  }
  if (
    canonical.inputTokens !== undefined &&
    canonical.inputTokens !== (isRecord(usage.tokens) ? usage.tokens.input : undefined)
  ) {
    add(diagnostics, "AI_USAGE_RESULT_MISMATCH", "result.usage.inputTokens", "Canonical and receipt input-token usage differ.");
  }
  if (
    canonical.outputTokens !== undefined &&
    canonical.outputTokens !== (isRecord(usage.tokens) ? usage.tokens.output : undefined)
  ) {
    add(diagnostics, "AI_USAGE_RESULT_MISMATCH", "result.usage.outputTokens", "Canonical and receipt output-token usage differ.");
  }
  if (
    numberValue(canonical.costCents) !== undefined &&
    (!isRecord(usage.cost) ||
      usage.cost.status === "unknown" ||
      (numberValue(canonical.costCents) ?? 0) * 10_000 !== usage.cost.amountMicros)
  ) {
    add(diagnostics, "AI_USAGE_RESULT_MISMATCH", "result.usage.costCents", "Canonical and receipt monetary usage differ.");
  }
}

function validateDispatch(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!isRecord(value)) {
    add(diagnostics, "AI_INVALID_VALUE", path, "Dispatch outcome must be an object.");
    return;
  }
  enumValue(
    stringValue(value.status),
    ["not-dispatched", "accepted", "terminal", "outcome-unknown"] as const,
    `${path}.status`,
    diagnostics,
  );
  if (value.idempotencyKey !== undefined) {
    nonEmpty(stringValue(value.idempotencyKey), `${path}.idempotencyKey`, diagnostics);
  }
}

function validateAttemptUsageAlignment(
  attempts: readonly unknown[],
  aggregate: unknown,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!isRecord(aggregate)) return;
  const usage = attempts
    .map((attempt) => (isRecord(attempt) ? attempt.usage : undefined))
    .filter(isRecord);
  if (usage.length !== attempts.length || usage.length === 0) return;

  if (aggregate.measurement === "unknown") {
    if (usage.every((item) => item.measurement === "known")) {
      add(
        diagnostics,
        "AI_ATTEMPT_USAGE_MISMATCH",
        "usage",
        "Aggregate usage cannot be unknown when every attempt has known usage.",
      );
    }
    return;
  }
  if (aggregate.measurement !== "known") return;
  if (!usage.every((item) => item.measurement === "known" && isRecord(item.tokens))) {
    add(
      diagnostics,
      "AI_ATTEMPT_USAGE_MISMATCH",
      "usage",
      "Known aggregate usage requires known usage for every attempt.",
    );
    return;
  }

  const expectedTokens = sumTokens(usage.map((item) => item.tokens));
  if (!isRecord(aggregate.tokens) || !jsonEqual(expectedTokens, aggregate.tokens)) {
    add(
      diagnostics,
      "AI_ATTEMPT_USAGE_MISMATCH",
      "usage.tokens",
      "Aggregate token usage must equal the sum of attempt usage.",
    );
  }

  if (!isRecord(aggregate.cost) || aggregate.cost.status === "unknown") return;
  const attemptCosts = usage.map((item) => item.cost).filter(isRecord);
  const currency = stringValue(aggregate.cost.currency);
  if (
    attemptCosts.length !== usage.length ||
    attemptCosts.some(
      (cost) =>
        cost.status === "unknown" ||
        cost.currency !== currency ||
        !Number.isSafeInteger(cost.amountMicros),
    )
  ) {
    add(
      diagnostics,
      "AI_ATTEMPT_USAGE_MISMATCH",
      "usage.cost",
      "Measured aggregate cost requires compatible measured cost for every attempt.",
    );
    return;
  }
  const amountMicros = attemptCosts.reduce(
    (total, cost) => total + (numberValue(cost.amountMicros) ?? 0),
    0,
  );
  if (amountMicros !== numberValue(aggregate.cost.amountMicros)) {
    add(
      diagnostics,
      "AI_ATTEMPT_USAGE_MISMATCH",
      "usage.cost.amountMicros",
      "Aggregate cost must equal the sum of attempt costs.",
    );
  }
}

function sumTokens(values: readonly unknown[]): Record<string, number> {
  const total: Record<string, number> = { input: 0, output: 0 };
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const key of ["input", "output", "cachedInput", "reasoning"] as const) {
      const amount = numberValue(value[key]);
      if (amount !== undefined) total[key] = (total[key] ?? 0) + amount;
    }
  }
  return total;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function validateMessages(
  messages: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    add(diagnostics, "AI_INVALID_VALUE", path, "At least one chat message is required.");
    return;
  }
  messages.forEach((message, index) => {
    const item = isRecord(message) ? message : {};
    enumValue(stringValue(item.role), ["system", "user", "assistant", "tool"] as const, `${path}[${index}].role`, diagnostics);
    nonEmpty(stringValue(item.content), `${path}[${index}].content`, diagnostics);
  });
}

function validateArtifact(
  artifact: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  const value = isRecord(artifact) ? artifact : {};
  nonEmpty(stringValue(value.uri), `${path}.uri`, diagnostics);
  nonEmpty(stringValue(value.digest), `${path}.digest`, diagnostics);
  nonEmpty(stringValue(value.contentClass), `${path}.contentClass`, diagnostics);
}

function uniqueEnumValues<T extends string>(
  values: unknown,
  allowed: readonly T[],
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!Array.isArray(values)) {
    add(diagnostics, "AI_INVALID_VALUE", path, "Value must be an array.");
    return;
  }
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const string = stringValue(value);
    enumValue(string, allowed, `${path}[${index}]`, diagnostics);
    if (string !== undefined && seen.has(string)) {
      add(diagnostics, "AI_DUPLICATE_VALUE", `${path}[${index}]`, `Duplicate value ${string}.`);
    }
    if (string !== undefined) seen.add(string);
  });
}

function uniqueStrings(
  values: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!Array.isArray(values)) {
    add(diagnostics, "AI_INVALID_VALUE", path, "Value must be an array.");
    return;
  }
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const string = stringValue(value);
    nonEmpty(string, `${path}[${index}]`, diagnostics);
    if (string !== undefined && seen.has(string)) {
      add(diagnostics, "AI_DUPLICATE_VALUE", `${path}[${index}]`, `Duplicate value ${string}.`);
    }
    if (string !== undefined) seen.add(string);
  });
}

function nonEmptyStrings(
  values: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!Array.isArray(values) || values.length === 0) {
    add(diagnostics, "AI_INVALID_VALUE", path, "At least one value is required.");
    return;
  }
  values.forEach((value, index) => nonEmpty(stringValue(value), `${path}[${index}]`, diagnostics));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function enumValue<T extends string>(
  value: T | undefined,
  allowed: readonly T[],
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!allowed.includes(value as T)) {
    add(diagnostics, "AI_INVALID_VALUE", path, `Value must be one of: ${allowed.join(", ")}.`);
  }
}

function nonEmpty(
  value: string | undefined,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    add(diagnostics, "AI_INVALID_VALUE", path, "Value must be a non-empty string.");
  }
}

function positiveInteger(
  value: number | undefined,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    add(diagnostics, "AI_INVALID_VALUE", path, "Value must be a positive safe integer.");
  }
}

function validateOptionalTime(
  value: string | undefined,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (value !== undefined && !isIsoDate(value)) {
    add(diagnostics, "AI_INVALID_VALUE", path, "Value must be an ISO-8601 timestamp.");
  }
}

function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validation(
  diagnostics: AiExecutionDiagnostic[],
): AiExecutionValidation {
  return { valid: diagnostics.length === 0, diagnostics };
}

function add(
  diagnostics: AiExecutionDiagnostic[],
  code: AiExecutionDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}
