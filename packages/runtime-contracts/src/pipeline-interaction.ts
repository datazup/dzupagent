/**
 * Dependency-neutral, checkpoint-bound pipeline interaction contracts.
 *
 * This compatibility module intentionally exposes the same API while the
 * implementation is separated by type, construction, validation, replay,
 * serialization, and digest concern.
 *
 * @module runtime-contracts/pipeline-interaction
 */

export {
  PIPELINE_INTERACTION_LIMITS,
  PIPELINE_INTERACTION_RESUME_SCHEMA,
  PIPELINE_INTERACTION_SPEC_SCHEMA,
  PIPELINE_PENDING_INTERACTION_SCHEMA,
} from "./pipeline-interaction/types.js";
export type {
  PipelineApprovalInteractionResponseV1,
  PipelineApprovalInteractionSpecV1,
  PipelineApprovalRequestSchemaV1,
  PipelineClarificationInteractionResponseV1,
  PipelineClarificationInteractionSpecV1,
  PipelineClarificationRequestSchemaV1,
  PipelineInteractionRecordV1,
  PipelineInteractionRequestSchemaV1,
  PipelineInteractionResponseV1,
  PipelineInteractionResumeInputV1,
  PipelineInteractionResumeV1,
  PipelineInteractionScopeV1,
  PipelineInteractionSpecInputV1,
  PipelineInteractionSpecV1,
  PipelineInteractionStatePortV1,
  PipelineInteractionValidationIssue,
  PipelineInteractionValidationResult,
  PipelinePendingInteractionInputV1,
  PipelinePendingInteractionV1,
  PipelineSha256Digest,
} from "./pipeline-interaction/types.js";
export {
  createPipelineInteractionId,
  createPipelineInteractionResumeV1,
  createPipelineInteractionSpecV1,
  createPipelinePendingInteractionV1,
  digestPipelineDefinition,
} from "./pipeline-interaction/construction.js";
export { validatePipelineInteractionSpecV1 } from "./pipeline-interaction/spec-validation.js";
export { validatePipelinePendingInteractionV1 } from "./pipeline-interaction/record-validation.js";
export { validatePipelineInteractionResumeV1 } from "./pipeline-interaction/resume-validation.js";
export {
  deserializePipelineInteractionResumeV1,
  deserializePipelineInteractionSpecV1,
  deserializePipelinePendingInteractionV1,
  serializePipelineInteractionResumeV1,
  serializePipelineInteractionSpecV1,
  serializePipelinePendingInteractionV1,
} from "./pipeline-interaction/serialization.js";
