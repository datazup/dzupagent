import { digestPipelineInteractionValue } from "./digest.js";
import {
  PIPELINE_INTERACTION_RESUME_SCHEMA,
  type PipelineInteractionResumeV1,
  type PipelineInteractionSpecV1,
  type PipelineInteractionValidationIssue,
  type PipelineInteractionValidationResult,
  type PipelinePendingInteractionV1,
} from "./types.js";
import {
  binding,
  comparePendingBindings,
  exactKeys,
  finish,
  invalidType,
  isoInstant,
  issue,
  literal,
  nonNegativeInteger,
  record,
  sha256,
  validateCanonicalOccurrence,
  validateResponse,
  validateScope,
} from "./validation-helpers.js";

export function validatePipelineInteractionResumeV1(
  value: unknown,
  context: {
    readonly spec?: PipelineInteractionSpecV1;
    readonly pending?: PipelinePendingInteractionV1;
  } = {},
): PipelineInteractionValidationResult<PipelineInteractionResumeV1> {
  const issues: PipelineInteractionValidationIssue[] = [];
  if (!record(value)) return invalidType("$", "interaction resume", issues);
  exactKeys(
    value,
    [
      "schema",
      "definitionDigest",
      "pipelineId",
      "runId",
      "nodeId",
      "scope",
      "occurrence",
      "interactionId",
      "expectedCheckpointVersion",
      "requestDigest",
      "receiptId",
      "submittedAt",
      "response",
      "receiptHash",
    ],
    "$",
    issues,
  );
  literal(
    value.schema,
    PIPELINE_INTERACTION_RESUME_SCHEMA,
    "$.schema",
    "UNKNOWN_VERSION",
    issues,
  );
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
  binding(value.receiptId, "$.receiptId", issues);
  isoInstant(value.submittedAt, "$.submittedAt", issues);
  validateResponse(value.response, context.spec, issues);
  sha256(value.receiptHash, "$.receiptHash", issues);
  if (issues.length === 0) {
    const { receiptHash: _receiptHash, ...core } = value;
    if (value.receiptHash !== digestPipelineInteractionValue(core)) {
      issue(
        issues,
        "$.receiptHash",
        "DIGEST_MISMATCH",
        "Interaction receipt hash does not match canonical content.",
      );
    }
  }
  if (context.pending !== undefined) {
    comparePendingBindings(value, context.pending, issues);
  }
  if (
    context.spec !== undefined &&
    record(value.response) &&
    value.response.kind !== context.spec.kind
  ) {
    issue(
      issues,
      "$.response.kind",
      "KIND_MISMATCH",
      "Response kind must match the authored interaction specification.",
    );
  }
  return finish(value, issues);
}
