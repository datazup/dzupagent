import type {
  ExecutionRequest,
} from "../canonical-execution.js";
import {
  add,
  enumValue,
  isIsoDate,
  isRecord,
  nonEmpty,
  stringValue,
  uniqueEnumValues,
  uniqueStrings,
  validation,
} from "../ai-execution-validation-primitives.js";
import {
  AI_CAPABILITY_ID_PATTERN,
  AI_EXECUTION_OPERATION_KINDS,
  AI_EXECUTION_REQUEST_SCHEMA,
  AI_EXECUTION_STYLES,
  AI_PUBLIC_TARGET_SCHEMA,
  AI_TARGET_PLACEMENTS,
} from "../ai-execution-types.js";
import type {
  AiExecutionOperation,
  AiExecutionRequest,
  AiTargetSelector,
} from "../ai-execution-types.js";
import type {
  AiExecutionDiagnostic,
  AiExecutionRequestProjection,
  AiExecutionValidation,
} from "../ai-execution-receipt-types.js";
import {
  collectPublicTargetLeakPaths,
  validateExecutionBoundary,
  validateExecutionKind,
  validateOperation,
  validateTargetSelector,
} from "./target-validation.js";

/**
 * Compatibility projector for existing prompt, adapter-run, agent, and Worker
 * dispatch leaves. The caller must provide the operation-specific payload;
 * the projector never guesses modality from prompt text or provider metadata.
 */
export function projectExecutionRequestToAi(
  execution: ExecutionRequest,
  operation: AiExecutionOperation,
  target: AiTargetSelector
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
  value: unknown
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (!isRecord(value)) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      "$",
      "AI execution request must be an object."
    );
    return validation(diagnostics);
  }
  if (value.schema !== AI_EXECUTION_REQUEST_SCHEMA) {
    add(
      diagnostics,
      "AI_INVALID_SCHEMA",
      "schema",
      "Unsupported AI execution request schema."
    );
  }
  const execution = isRecord(value.execution) ? value.execution : undefined;
  nonEmpty(
    stringValue(execution?.requestId),
    "execution.requestId",
    diagnostics
  );
  nonEmpty(
    stringValue(execution?.correlationId),
    "execution.correlationId",
    diagnostics
  );
  validateTargetSelector(value.target, "target", diagnostics);
  validateOperation(value.operation, "operation", diagnostics);
  validateExecutionBoundary(execution, diagnostics);
  const operation = isRecord(value.operation) ? value.operation : undefined;
  validateExecutionKind(execution, stringValue(operation?.kind), diagnostics);
  return validation(diagnostics);
}

export function validateAiPublicTargetDescriptor(
  value: unknown
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (!isRecord(value)) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      "$",
      "Public AI target must be an object."
    );
    return validation(diagnostics);
  }
  if (value.schema !== AI_PUBLIC_TARGET_SCHEMA) {
    add(
      diagnostics,
      "AI_INVALID_SCHEMA",
      "schema",
      "Unsupported public AI target schema."
    );
  }
  nonEmpty(stringValue(value.targetId), "targetId", diagnostics);
  nonEmpty(stringValue(value.revision), "revision", diagnostics);
  nonEmpty(stringValue(value.displayName), "displayName", diagnostics);
  uniqueEnumValues(
    value.operations,
    AI_EXECUTION_OPERATION_KINDS,
    "operations",
    diagnostics
  );
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      "operations",
      "A public target must declare at least one operation."
    );
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
          "Capability identifiers must use a stable lowercase name and /v<major> suffix."
        );
      }
    });
  }
  enumValue(
    stringValue(value.placement),
    AI_TARGET_PLACEMENTS,
    "placement",
    diagnostics
  );
  enumValue(
    stringValue(value.executionStyle),
    AI_EXECUTION_STYLES,
    "executionStyle",
    diagnostics
  );
  const health = isRecord(value.health) ? value.health : undefined;
  enumValue(
    stringValue(health?.status),
    ["healthy", "degraded", "unhealthy", "unknown"] as const,
    "health.status",
    diagnostics
  );
  for (const leakPath of collectPublicTargetLeakPaths(value)) {
    add(
      diagnostics,
      "AI_PUBLIC_TARGET_LEAK",
      leakPath,
      `Public targets cannot expose private routing field ${leakPath}.`
    );
  }
  if (
    health?.checkedAt !== undefined &&
    !isIsoDate(stringValue(health.checkedAt))
  ) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      "health.checkedAt",
      "Target health time must be ISO-8601."
    );
  }
  return validation(diagnostics);
}

export function validateAiExecutionTargetSelection(
  request: unknown,
  target: unknown
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
      `Target ${String(
        target.targetId ?? "<invalid>"
      )} does not support operation ${operationKind}.`
    );
  }
  const selector = isRecord(request.target) ? request.target : undefined;
  if (selector?.kind === "target-id" && selector.targetId !== target.targetId) {
    add(
      diagnostics,
      "AI_IDENTITY_MISMATCH",
      "target.targetId",
      "Resolved public target differs from the requested opaque target."
    );
  }
  return validation(diagnostics);
}
