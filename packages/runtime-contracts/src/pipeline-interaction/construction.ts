import { canonicalInputDigest } from "../idempotency.js";

import { digestPipelineInteractionValue } from "./digest.js";
import {
  PIPELINE_INTERACTION_RESUME_SCHEMA,
  PIPELINE_INTERACTION_SPEC_SCHEMA,
  PIPELINE_PENDING_INTERACTION_SCHEMA,
  type PipelineApprovalInteractionSpecV1,
  type PipelineClarificationInteractionSpecV1,
  type PipelineInteractionResumeInputV1,
  type PipelineInteractionResumeV1,
  type PipelineInteractionScopeV1,
  type PipelineInteractionSpecInputV1,
  type PipelineInteractionSpecV1,
  type PipelinePendingInteractionInputV1,
  type PipelinePendingInteractionV1,
  type PipelineSha256Digest,
} from "./types.js";

export function createPipelineInteractionSpecV1(
  input: Omit<PipelineApprovalInteractionSpecV1, "schema" | "requestDigest">,
): PipelineApprovalInteractionSpecV1;
export function createPipelineInteractionSpecV1(
  input: Omit<
    PipelineClarificationInteractionSpecV1,
    "schema" | "requestDigest"
  >,
): PipelineClarificationInteractionSpecV1;
export function createPipelineInteractionSpecV1(
  input: PipelineInteractionSpecInputV1,
): PipelineInteractionSpecV1 {
  const shared = {
    schema: PIPELINE_INTERACTION_SPEC_SCHEMA,
    kind: input.kind,
    authoredNodeId: input.authoredNodeId,
    authoredPath: input.authoredPath,
    question: input.question,
    choices: input.choices,
    requestSchema: input.requestSchema,
  } as const;
  const core =
    input.kind === "approval"
      ? { ...shared, outcomeToSuccessor: input.outcomeToSuccessor }
      : { ...shared, outputKey: input.outputKey };
  return {
    ...core,
    requestDigest: digestPipelineInteractionValue(core),
  } as PipelineInteractionSpecV1;
}

export function createPipelineInteractionResumeV1(
  input: PipelineInteractionResumeInputV1,
): PipelineInteractionResumeV1 {
  const core = {
    schema: PIPELINE_INTERACTION_RESUME_SCHEMA,
    definitionDigest: input.definitionDigest,
    pipelineId: input.pipelineId,
    runId: input.runId,
    nodeId: input.nodeId,
    scope: input.scope,
    occurrence: input.occurrence,
    interactionId: input.interactionId,
    expectedCheckpointVersion: input.expectedCheckpointVersion,
    requestDigest: input.requestDigest,
    receiptId: input.receiptId,
    submittedAt: input.submittedAt,
    response: input.response,
  } as Omit<PipelineInteractionResumeV1, "receiptHash">;
  return {
    ...core,
    receiptHash: digestPipelineInteractionValue(core),
  };
}

export function createPipelinePendingInteractionV1(
  input: PipelinePendingInteractionInputV1,
): PipelinePendingInteractionV1 {
  const binding = {
    definitionDigest: input.definitionDigest,
    pipelineId: input.pipelineId,
    runId: input.runId,
    nodeId: input.nodeId,
    scope: input.scope,
    occurrence: input.occurrence,
    requestDigest: input.requestDigest,
  };
  return {
    schema: PIPELINE_PENDING_INTERACTION_SCHEMA,
    state: "pending",
    kind: input.kind,
    definitionDigest: input.definitionDigest,
    pipelineId: input.pipelineId,
    runId: input.runId,
    nodeId: input.nodeId,
    scope: input.scope,
    occurrence: input.occurrence,
    expectedCheckpointVersion: input.expectedCheckpointVersion,
    requestDigest: input.requestDigest,
    expiresAt: input.expiresAt,
    interactionId: createPipelineInteractionId(binding),
  };
}

export function createPipelineInteractionId(input: {
  readonly definitionDigest: PipelineSha256Digest;
  readonly pipelineId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly scope: PipelineInteractionScopeV1;
  readonly occurrence: number;
  readonly requestDigest: PipelineSha256Digest;
}): string {
  return `interaction:${canonicalInputDigest(input)}`;
}
