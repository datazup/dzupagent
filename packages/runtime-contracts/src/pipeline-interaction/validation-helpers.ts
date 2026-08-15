import { canonicalInputDigest } from "../idempotency.js";

import {
  PIPELINE_INTERACTION_LIMITS,
  type PipelineInteractionSpecV1,
  type PipelineInteractionValidationIssue,
  type PipelineInteractionValidationResult,
  type PipelinePendingInteractionV1,
} from "./types.js";

export function comparePendingBindings(
  resume: Record<string, unknown>,
  pending: PipelinePendingInteractionV1,
  issues: PipelineInteractionValidationIssue[],
): void {
  const bindings = [
    "definitionDigest",
    "pipelineId",
    "runId",
    "nodeId",
    "occurrence",
    "interactionId",
    "expectedCheckpointVersion",
    "requestDigest",
  ] as const;
  for (const key of bindings) {
    if (resume[key] !== pending[key]) {
      issue(
        issues,
        `$.${key}`,
        "BINDING_MISMATCH",
        `${key} does not match the pending interaction.`,
      );
    }
  }
  if (canonicalInputDigest(resume.scope) !== canonicalInputDigest(pending.scope)) {
    issue(
      issues,
      "$.scope",
      "BINDING_MISMATCH",
      "Interaction scope does not match the pending interaction.",
    );
  }
  if (record(resume.response) && resume.response.kind !== pending.kind) {
    issue(
      issues,
      "$.response.kind",
      "KIND_MISMATCH",
      "Response kind does not match the pending interaction.",
    );
  }
}

export function validateResponse(
  value: unknown,
  spec: PipelineInteractionSpecV1 | undefined,
  issues: PipelineInteractionValidationIssue[],
): void {
  if (!record(value)) {
    invalidType("$.response", "interaction response", issues);
    return;
  }
  if (value.kind === "approval") {
    exactKeys(
      value,
      ["kind", "decision", "choice", "reason"],
      "$.response",
      issues,
      ["choice", "reason"],
    );
    if (value.decision !== "approved" && value.decision !== "rejected") {
      issue(
        issues,
        "$.response.decision",
        "INVALID_VALUE",
        "Approval decision must be approved or rejected.",
      );
    }
    if (value.choice !== undefined) {
      boundedString(
        value.choice,
        "$.response.choice",
        PIPELINE_INTERACTION_LIMITS.maxChoiceLength,
        issues,
        true,
      );
      if (
        spec?.kind === "approval" &&
        typeof value.choice === "string" &&
        !spec.choices.includes(value.choice)
      ) {
        issue(
          issues,
          "$.response.choice",
          "INVALID_CHOICE",
          "Approval choice is not one of the authored choices.",
        );
      }
    }
    if (value.reason !== undefined) {
      boundedString(
        value.reason,
        "$.response.reason",
        PIPELINE_INTERACTION_LIMITS.maxReasonLength,
        issues,
        true,
      );
    }
    return;
  }
  if (value.kind === "clarification") {
    exactKeys(value, ["kind", "value"], "$.response", issues);
    boundedString(
      value.value,
      "$.response.value",
      spec?.kind === "clarification"
        ? spec.requestSchema.maxLength
        : PIPELINE_INTERACTION_LIMITS.maxTextResponseLength,
      issues,
      true,
    );
    if (
      spec?.kind === "clarification" &&
      spec.requestSchema.response === "choice" &&
      typeof value.value === "string" &&
      !spec.choices.includes(value.value)
    ) {
      issue(
        issues,
        "$.response.value",
        "INVALID_CHOICE",
        "Clarification value is not one of the authored choices.",
      );
    }
    return;
  }
  issue(
    issues,
    "$.response.kind",
    "INVALID_VALUE",
    "Interaction response kind is invalid.",
  );
}

export function validateChoices(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    invalidType(path, "choices array", issues);
    return;
  }
  if (value.length > PIPELINE_INTERACTION_LIMITS.maxChoices) {
    issue(issues, path, "INVALID_CHOICE", "Interaction choices exceed the bounded limit.");
  }
  const seen = new Set<string>();
  value.forEach((choice, index) => {
    boundedString(
      choice,
      `${path}[${index}]`,
      PIPELINE_INTERACTION_LIMITS.maxChoiceLength,
      issues,
      true,
    );
    if (typeof choice === "string") {
      if (choice.length === 0) {
        issue(
          issues,
          `${path}[${index}]`,
          "INVALID_CHOICE",
          "Interaction choices must be non-empty.",
        );
      }
      if (seen.has(choice)) {
        issue(
          issues,
          `${path}[${index}]`,
          "INVALID_CHOICE",
          "Interaction choices must be unique.",
        );
      }
      seen.add(choice);
    }
  });
}

export function validateScope(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
): void {
  if (!record(value)) {
    invalidType(path, "interaction scope", issues);
    return;
  }
  if (value.kind === "pipeline") {
    exactKeys(value, ["kind"], path, issues);
    return;
  }
  if (value.kind === "loop") {
    exactKeys(value, ["kind", "loopNodeId", "iteration"], path, issues);
    binding(value.loopNodeId, `${path}.loopNodeId`, issues);
    nonNegativeInteger(value.iteration, `${path}.iteration`, issues);
    return;
  }
  issue(issues, `${path}.kind`, "INVALID_VALUE", "Interaction scope is invalid.");
}

export function validateCanonicalOccurrence(
  scope: unknown,
  occurrence: unknown,
  issues: PipelineInteractionValidationIssue[],
): void {
  if (!record(scope) || !Number.isInteger(occurrence)) return;
  const expected = scope.kind === "pipeline"
    ? 0
    : scope.kind === "loop" && Number.isInteger(scope.iteration)
      ? scope.iteration
      : undefined;
  if (expected !== undefined && occurrence !== expected) {
    issue(
      issues,
      "$.occurrence",
      "BINDING_MISMATCH",
      "Interaction occurrence does not match its canonical scope occurrence.",
    );
  }
}

export function interactionKind(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
): void {
  if (value !== "approval" && value !== "clarification") {
    issue(issues, path, "INVALID_VALUE", "Interaction kind is invalid.");
  }
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: PipelineInteractionValidationIssue[],
  optionalKeys: readonly string[] = [],
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issue(issues, `${path}.${key}`, "UNKNOWN_FIELD", "Unknown interaction field.");
    }
  }
  const optional = new Set(optionalKeys);
  const required = keys.filter((key) => !optional.has(key));
  for (const key of required) {
    if (!(key in value)) {
      issue(
        issues,
        `${path}.${key}`,
        "MISSING_BINDING",
        "Required interaction field is missing.",
      );
    }
  }
}

export function boundedString(
  value: unknown,
  path: string,
  maxLength: number,
  issues: PipelineInteractionValidationIssue[],
  nonEmpty = false,
): void {
  if (
    typeof value !== "string" ||
    (nonEmpty && value.length === 0) ||
    value.length > maxLength
  ) {
    issue(
      issues,
      path,
      "INVALID_VALUE",
      `Expected ${nonEmpty ? "a non-empty" : "a"} string of at most ${maxLength} characters.`,
    );
  }
}

export function binding(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
  digestBinding = false,
): void {
  if (digestBinding) {
    sha256(value, path, issues, "MISSING_BINDING");
  } else if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PIPELINE_INTERACTION_LIMITS.maxBindingLength
  ) {
    issue(issues, path, "MISSING_BINDING", "Required interaction binding is missing.");
  }
}

export function nonNegativeInteger(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    issue(issues, path, "INVALID_VALUE", "Expected a non-negative integer.");
  }
}

export function positiveInteger(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
): void {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    issue(issues, path, "INVALID_VALUE", "Expected a positive integer.");
  }
}

export function sha256(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
  code: PipelineInteractionValidationIssue["code"] = "INVALID_VALUE",
): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    issue(issues, path, code, "Expected a lowercase SHA-256 digest binding.");
  }
}

export function isoInstant(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
): void {
  if (typeof value !== "string") {
    issue(issues, path, "INVALID_VALUE", "Expected an ISO-8601 UTC instant.");
    return;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    issue(issues, path, "INVALID_VALUE", "Expected an ISO-8601 UTC instant.");
    return;
  }
  const canonical = new Date(timestamp).toISOString();
  const canonicalWithoutMilliseconds = `${canonical.slice(0, 19)}Z`;
  if (value !== canonical && value !== canonicalWithoutMilliseconds) {
    issue(issues, path, "INVALID_VALUE", "Expected an ISO-8601 UTC instant.");
  }
}

export function literal(
  value: unknown,
  expected: string,
  path: string,
  code: PipelineInteractionValidationIssue["code"],
  issues: PipelineInteractionValidationIssue[],
): void {
  if (value !== expected) {
    issue(issues, path, code, `Expected ${JSON.stringify(expected)}.`);
  }
}

export function invalidType<T>(
  path: string,
  label: string,
  issues: PipelineInteractionValidationIssue[],
): PipelineInteractionValidationResult<T> {
  issue(issues, path, "INVALID_TYPE", `Expected ${label}.`);
  return { valid: false, issues };
}

export function finish<T>(
  value: unknown,
  issues: PipelineInteractionValidationIssue[],
): PipelineInteractionValidationResult<T> {
  return issues.length === 0
    ? { valid: true, value: value as T, issues: [] }
    : { valid: false, issues };
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function issue(
  issues: PipelineInteractionValidationIssue[],
  path: string,
  code: PipelineInteractionValidationIssue["code"],
  message: string,
): void {
  issues.push({ path, code, message });
}
