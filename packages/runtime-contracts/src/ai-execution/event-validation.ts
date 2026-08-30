import {
  add,
  enumValue,
  isIsoDate,
  isRecord,
  nonEmpty,
  numberValue,
  positiveInteger,
  stringValue,
  validateArtifact,
  validation,
} from "../ai-execution-validation-primitives.js";
import {
  AI_EXECUTION_EVENT_SCHEMA,
} from "../ai-execution-types.js";
import type {
  AiExecutionDiagnostic,
  AiExecutionValidation,
} from "../ai-execution-receipt-types.js";
import {
  validateUsage,
} from "./usage-validation.js";

export function validateAiExecutionEvent(
  value: unknown
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (!isRecord(value)) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      "$",
      "AI execution event must be an object."
    );
    return validation(diagnostics);
  }
  if (value.schema !== AI_EXECUTION_EVENT_SCHEMA) {
    add(
      diagnostics,
      "AI_INVALID_SCHEMA",
      "schema",
      "Unsupported AI execution event schema."
    );
  }
  nonEmpty(stringValue(value.requestId), "requestId", diagnostics);
  nonEmpty(stringValue(value.correlationId), "correlationId", diagnostics);
  positiveInteger(numberValue(value.sequence), "sequence", diagnostics);
  positiveInteger(numberValue(value.attempt), "attempt", diagnostics);
  nonEmpty(stringValue(value.cursor), "cursor", diagnostics);
  if (!isIsoDate(stringValue(value.emittedAt))) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      "emittedAt",
      "Event time must be ISO-8601."
    );
  }
  enumValue(
    stringValue(value.type),
    [
      "started",
      "output.delta",
      "artifact",
      "usage",
      "interaction.required",
      "completed",
    ] as const,
    "type",
    diagnostics
  );
  if (value.type === "output.delta")
    nonEmpty(stringValue(value.delta), "delta", diagnostics);
  if (value.type === "interaction.required") {
    nonEmpty(stringValue(value.interactionRef), "interactionRef", diagnostics);
  }
  if (value.type === "usage") validateUsage(value.usage, "usage", diagnostics);
  if (value.type === "artifact")
    validateArtifact(value.artifact, "artifact", diagnostics);
  if (value.type === "completed") {
    enumValue(
      stringValue(value.status),
      ["succeeded", "failed", "cancelled", "timed_out"] as const,
      "status",
      diagnostics
    );
  }
  return validation(diagnostics);
}

export function validateAiExecutionEventSequence(
  values: unknown
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (!Array.isArray(values) || values.length === 0) {
    add(
      diagnostics,
      "AI_EVENT_SEQUENCE_INVALID",
      "events",
      "At least one execution event is required."
    );
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
      }))
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
        "All events must share one request and correlation identity."
      );
    }
    if (event.sequence !== index + 1) {
      add(
        diagnostics,
        "AI_EVENT_SEQUENCE_INVALID",
        `events[${index}].sequence`,
        "Event sequences must be contiguous and one-based."
      );
    }
    const cursor = stringValue(event.cursor);
    if (cursor !== undefined && cursors.has(cursor)) {
      add(
        diagnostics,
        "AI_EVENT_SEQUENCE_INVALID",
        `events[${index}].cursor`,
        "Event cursors must be unique within an execution."
      );
    }
    if (cursor !== undefined) cursors.add(cursor);
    const attempt = numberValue(event.attempt) ?? 0;
    if (attempt < lastAttempt) {
      add(
        diagnostics,
        "AI_EVENT_SEQUENCE_INVALID",
        `events[${index}].attempt`,
        "Event attempts cannot move backwards."
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
          "The terminal event must be the final event."
        );
      }
    }
  });
  if (terminalCount !== 1) {
    add(
      diagnostics,
      "AI_TERMINAL_EVENT_INVALID",
      "events",
      "An execution event sequence requires exactly one terminal event."
    );
  }
  return validation(diagnostics);
}
