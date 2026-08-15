import { digestPipelineInteractionValue } from "./digest.js";
import {
  PIPELINE_INTERACTION_LIMITS,
  PIPELINE_INTERACTION_SPEC_SCHEMA,
  type PipelineInteractionSpecV1,
  type PipelineInteractionValidationIssue,
  type PipelineInteractionValidationResult,
} from "./types.js";
import {
  boundedString,
  exactKeys,
  finish,
  invalidType,
  issue,
  literal,
  positiveInteger,
  record,
  sha256,
  validateChoices,
} from "./validation-helpers.js";

export function validatePipelineInteractionSpecV1(
  value: unknown,
): PipelineInteractionValidationResult<PipelineInteractionSpecV1> {
  const issues: PipelineInteractionValidationIssue[] = [];
  if (!record(value)) return invalidType("$", "interaction spec", issues);
  exactKeys(
    value,
    value.kind === "approval"
      ? [
          "schema",
          "kind",
          "authoredNodeId",
          "authoredPath",
          "question",
          "choices",
          "outcomeToSuccessor",
          "requestSchema",
          "requestDigest",
        ]
      : [
          "schema",
          "kind",
          "authoredNodeId",
          "authoredPath",
          "question",
          "choices",
          "outputKey",
          "requestSchema",
          "requestDigest",
        ],
    "$",
    issues,
  );
  literal(
    value.schema,
    PIPELINE_INTERACTION_SPEC_SCHEMA,
    "$.schema",
    "UNKNOWN_VERSION",
    issues,
  );
  const kind = value.kind;
  if (kind !== "approval" && kind !== "clarification") {
    issue(issues, "$.kind", "INVALID_VALUE", "Interaction kind is invalid.");
  }
  boundedString(value.authoredNodeId, "$.authoredNodeId", 512, issues, true);
  boundedString(value.authoredPath, "$.authoredPath", 4096, issues, true);
  boundedString(
    value.question,
    "$.question",
    PIPELINE_INTERACTION_LIMITS.maxQuestionLength,
    issues,
    true,
  );
  validateChoices(value.choices, "$.choices", issues);

  if (!record(value.requestSchema)) {
    invalidType("$.requestSchema", "request schema", issues);
  } else {
    if (value.requestSchema.kind !== kind) {
      issue(
        issues,
        "$.requestSchema.kind",
        "KIND_MISMATCH",
        "Request schema kind must match the interaction kind.",
      );
    }
    if (kind === "approval") {
      exactKeys(value.requestSchema, ["kind", "decisions"], "$.requestSchema", issues);
      if (
        !Array.isArray(value.requestSchema.decisions) ||
        value.requestSchema.decisions.length !== 2 ||
        value.requestSchema.decisions[0] !== "approved" ||
        value.requestSchema.decisions[1] !== "rejected"
      ) {
        issue(
          issues,
          "$.requestSchema.decisions",
          "INVALID_VALUE",
          "Approval decisions must be exactly [approved, rejected].",
        );
      }
    } else if (kind === "clarification") {
      exactKeys(
        value.requestSchema,
        ["kind", "response", "minLength", "maxLength"],
        "$.requestSchema",
        issues,
      );
      if (
        value.requestSchema.response !== "text" &&
        value.requestSchema.response !== "choice"
      ) {
        issue(
          issues,
          "$.requestSchema.response",
          "INVALID_VALUE",
          "Clarification response must be text or choice.",
        );
      }
      if (value.requestSchema.minLength !== 1) {
        issue(
          issues,
          "$.requestSchema.minLength",
          "INVALID_VALUE",
          "Clarification minimum length must be one.",
        );
      }
      positiveInteger(
        value.requestSchema.maxLength,
        "$.requestSchema.maxLength",
        issues,
      );
      if (
        typeof value.requestSchema.maxLength === "number" &&
        value.requestSchema.maxLength > PIPELINE_INTERACTION_LIMITS.maxTextResponseLength
      ) {
        issue(
          issues,
          "$.requestSchema.maxLength",
          "INVALID_VALUE",
          `Clarification maximum length cannot exceed ${PIPELINE_INTERACTION_LIMITS.maxTextResponseLength}.`,
        );
      }
      if (
        value.requestSchema.response === "choice" &&
        (!Array.isArray(value.choices) || value.choices.length === 0)
      ) {
        issue(
          issues,
          "$.choices",
          "INVALID_CHOICE",
          "Choice clarification requires at least one bounded choice.",
        );
      }
      if (
        value.requestSchema.response === "text" &&
        Array.isArray(value.choices) &&
        value.choices.length > 0
      ) {
        issue(
          issues,
          "$.choices",
          "INVALID_CHOICE",
          "Text clarification cannot declare choices.",
        );
      }
    }
  }

  if (kind === "approval") {
    if (!record(value.outcomeToSuccessor)) {
      invalidType("$.outcomeToSuccessor", "approval branch map", issues);
    } else {
      exactKeys(
        value.outcomeToSuccessor,
        ["approved", "rejected"],
        "$.outcomeToSuccessor",
        issues,
      );
      boundedString(
        value.outcomeToSuccessor.approved,
        "$.outcomeToSuccessor.approved",
        512,
        issues,
        true,
      );
      boundedString(
        value.outcomeToSuccessor.rejected,
        "$.outcomeToSuccessor.rejected",
        512,
        issues,
        true,
      );
    }
  } else if (kind === "clarification") {
    boundedString(value.outputKey, "$.outputKey", 512, issues, true);
  }

  sha256(value.requestDigest, "$.requestDigest", issues);
  if (issues.length === 0) {
    const { requestDigest: _requestDigest, ...core } = value;
    if (value.requestDigest !== digestPipelineInteractionValue(core)) {
      issue(
        issues,
        "$.requestDigest",
        "DIGEST_MISMATCH",
        "Interaction request digest does not match canonical content.",
      );
    }
  }
  return finish(value, issues);
}
