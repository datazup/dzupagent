export const PIPELINE_INTERACTION_SPEC_SCHEMA =
  "dzupagent.pipeline-interaction-spec/v1" as const;
export const PIPELINE_PENDING_INTERACTION_SCHEMA =
  "dzupagent.pipeline-pending-interaction/v1" as const;
export const PIPELINE_INTERACTION_RESUME_SCHEMA =
  "dzupagent.pipeline-interaction-resume/v1" as const;

export const PIPELINE_INTERACTION_LIMITS = {
  maxChoices: 32,
  maxChoiceLength: 256,
  maxQuestionLength: 4096,
  maxTextResponseLength: 16_384,
  maxReasonLength: 4_096,
  maxBindingLength: 512,
} as const;

export type PipelineSha256Digest = `sha256:${string}`;

export interface PipelineApprovalRequestSchemaV1 {
  readonly kind: "approval";
  readonly decisions: readonly ["approved", "rejected"];
}

export interface PipelineClarificationRequestSchemaV1 {
  readonly kind: "clarification";
  readonly response: "text" | "choice";
  readonly minLength: 1;
  readonly maxLength: number;
}

export type PipelineInteractionRequestSchemaV1 =
  | PipelineApprovalRequestSchemaV1
  | PipelineClarificationRequestSchemaV1;

interface PipelineInteractionSpecBaseV1 {
  readonly schema: typeof PIPELINE_INTERACTION_SPEC_SCHEMA;
  /** Stable authored identity; compiler-generated paths are valid identities. */
  readonly authoredNodeId: string;
  readonly authoredPath: string;
  readonly question: string;
  /** Bounded display/response choices. Empty for free-text interactions. */
  readonly choices: readonly string[];
  readonly requestSchema: PipelineInteractionRequestSchemaV1;
  /** Digest of every other field in this exact interaction specification. */
  readonly requestDigest: PipelineSha256Digest;
}

export interface PipelineApprovalInteractionSpecV1
  extends PipelineInteractionSpecBaseV1 {
  readonly kind: "approval";
  /** Direct authored outcome routing; never interpreted as a boolean predicate. */
  readonly outcomeToSuccessor: {
    readonly approved: string;
    readonly rejected: string;
  };
  readonly requestSchema: PipelineApprovalRequestSchemaV1;
}

export interface PipelineClarificationInteractionSpecV1
  extends PipelineInteractionSpecBaseV1 {
  readonly kind: "clarification";
  readonly outputKey: string;
  readonly requestSchema: PipelineClarificationRequestSchemaV1;
}

export type PipelineInteractionSpecV1 =
  | PipelineApprovalInteractionSpecV1
  | PipelineClarificationInteractionSpecV1;

export type PipelineInteractionScopeV1 =
  | { readonly kind: "pipeline" }
  | {
      readonly kind: "loop";
      readonly loopNodeId: string;
      readonly iteration: number;
    };

export interface PipelinePendingInteractionV1 {
  readonly schema: typeof PIPELINE_PENDING_INTERACTION_SCHEMA;
  readonly state: "pending";
  readonly kind: PipelineInteractionSpecV1["kind"];
  readonly definitionDigest: PipelineSha256Digest;
  readonly pipelineId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly scope: PipelineInteractionScopeV1;
  readonly occurrence: number;
  readonly interactionId: string;
  readonly expectedCheckpointVersion: number;
  readonly requestDigest: PipelineSha256Digest;
  readonly expiresAt: string;
}

export interface PipelineApprovalInteractionResponseV1 {
  readonly kind: "approval";
  readonly decision: "approved" | "rejected";
  /** Optional authored option selected alongside the binary decision. */
  readonly choice?: string;
  /** Optional bounded human rationale; never interpreted as routing authority. */
  readonly reason?: string;
}

export interface PipelineClarificationInteractionResponseV1 {
  readonly kind: "clarification";
  readonly value: string;
}

export type PipelineInteractionResponseV1 =
  | PipelineApprovalInteractionResponseV1
  | PipelineClarificationInteractionResponseV1;

export interface PipelineInteractionResumeV1 {
  readonly schema: typeof PIPELINE_INTERACTION_RESUME_SCHEMA;
  readonly definitionDigest: PipelineSha256Digest;
  readonly pipelineId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly scope: PipelineInteractionScopeV1;
  readonly occurrence: number;
  readonly interactionId: string;
  readonly expectedCheckpointVersion: number;
  readonly requestDigest: PipelineSha256Digest;
  readonly receiptId: string;
  readonly submittedAt: string;
  readonly response: PipelineInteractionResponseV1;
  /** Canonical content identity of the receipt excluding this field. */
  readonly receiptHash: PipelineSha256Digest;
}

/** Dependency-neutral record exposed by HITL adapters and stores. */
export interface PipelineInteractionRecordV1 {
  readonly spec: PipelineInteractionSpecV1;
  readonly pending: PipelinePendingInteractionV1;
  readonly receipt?: PipelineInteractionResumeV1;
}

/**
 * Minimal authoritative adapter port. Implementations must make identical
 * pending/receipt writes idempotent and reject payload drift or conflicts.
 */
export interface PipelineInteractionStatePortV1 {
  ensurePending(
    spec: PipelineInteractionSpecV1,
    pending: PipelinePendingInteractionV1,
  ): Promise<PipelineInteractionRecordV1>;
  recordReceipt(
    receipt: PipelineInteractionResumeV1,
  ): Promise<PipelineInteractionRecordV1>;
  get(interactionId: string): Promise<PipelineInteractionRecordV1 | null>;
}

export interface PipelineInteractionValidationIssue {
  readonly path: string;
  readonly code:
    | "UNKNOWN_VERSION"
    | "INVALID_TYPE"
    | "INVALID_VALUE"
    | "MISSING_BINDING"
    | "UNKNOWN_FIELD"
    | "DIGEST_MISMATCH"
    | "KIND_MISMATCH"
    | "BINDING_MISMATCH"
    | "INVALID_CHOICE";
  readonly message: string;
}

export type PipelineInteractionValidationResult<T> =
  | { readonly valid: true; readonly value: T; readonly issues: readonly [] }
  | {
      readonly valid: false;
      readonly issues: readonly PipelineInteractionValidationIssue[];
    };

export type PipelineInteractionSpecInputV1 =
  | Omit<PipelineApprovalInteractionSpecV1, "schema" | "requestDigest">
  | Omit<PipelineClarificationInteractionSpecV1, "schema" | "requestDigest">;

export type PipelineInteractionResumeInputV1 = Omit<
  PipelineInteractionResumeV1,
  "schema" | "receiptHash"
>;

export type PipelinePendingInteractionInputV1 = Omit<
  PipelinePendingInteractionV1,
  "schema" | "state" | "interactionId"
>;
