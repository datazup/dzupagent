import { createPipelineInteractionId } from "./construction.js";
import {
  PIPELINE_PENDING_INTERACTION_SCHEMA,
  type PipelineInteractionScopeV1,
  type PipelineInteractionValidationIssue,
  type PipelineInteractionValidationResult,
  type PipelinePendingInteractionV1,
  type PipelineSha256Digest,
} from "./types.js";
import {
  binding,
  exactKeys,
  finish,
  interactionKind,
  invalidType,
  isoInstant,
  issue,
  literal,
  nonNegativeInteger,
  record,
  sha256,
  validateCanonicalOccurrence,
  validateScope,
} from "./validation-helpers.js";

export function validatePipelinePendingInteractionV1(
  value: unknown,
): PipelineInteractionValidationResult<PipelinePendingInteractionV1> {
  const issues: PipelineInteractionValidationIssue[] = [];
  if (!record(value)) return invalidType("$", "pending interaction", issues);
  exactKeys(
    value,
    [
      "schema",
      "state",
      "kind",
      "definitionDigest",
      "pipelineId",
      "runId",
      "nodeId",
      "scope",
      "occurrence",
      "interactionId",
      "expectedCheckpointVersion",
      "requestDigest",
      "expiresAt",
    ],
    "$",
    issues,
  );
  literal(
    value.schema,
    PIPELINE_PENDING_INTERACTION_SCHEMA,
    "$.schema",
    "UNKNOWN_VERSION",
    issues,
  );
  literal(value.state, "pending", "$.state", "INVALID_VALUE", issues);
  interactionKind(value.kind, "$.kind", issues);
  binding(value.definitionDigest, "$.definitionDigest", issues, true);
  binding(value.pipelineId, "$.pipelineId", issues);
  binding(value.runId, "$.runId", issues);
  binding(value.nodeId, "$.nodeId", issues);
  validateScope(value.scope, "$.scope", issues);
  nonNegativeInteger(value.occurrence, "$.occurrence", issues);
  validateCanonicalOccurrence(value.scope, value.occurrence, issues);
  binding(value.interactionId, "$.interactionId", issues);
  nonNegativeInteger(
    value.expectedCheckpointVersion,
    "$.expectedCheckpointVersion",
    issues,
  );
  sha256(value.requestDigest, "$.requestDigest", issues);
  isoInstant(value.expiresAt, "$.expiresAt", issues);
  if (
    typeof value.definitionDigest === "string" &&
    typeof value.pipelineId === "string" &&
    typeof value.runId === "string" &&
    typeof value.nodeId === "string" &&
    record(value.scope) &&
    (value.scope.kind === "pipeline" || value.scope.kind === "loop") &&
    Number.isInteger(value.occurrence) &&
    typeof value.requestDigest === "string"
  ) {
    const expected = createPipelineInteractionId({
      definitionDigest: value.definitionDigest as PipelineSha256Digest,
      pipelineId: value.pipelineId,
      runId: value.runId,
      nodeId: value.nodeId,
      scope: value.scope as PipelineInteractionScopeV1,
      occurrence: value.occurrence as number,
      requestDigest: value.requestDigest as PipelineSha256Digest,
    });
    if (value.interactionId !== expected) {
      issue(
        issues,
        "$.interactionId",
        "BINDING_MISMATCH",
        "Interaction ID does not match its canonical bindings.",
      );
    }
  }
  return finish(value, issues);
}
