/**
 * Dependency-neutral, checkpoint-bound pipeline interaction contracts.
 *
 * The contracts intentionally contain only bounded authored request data and
 * immutable identities. Provider payloads, credentials, sessions, and
 * arbitrary application state do not belong in this protocol.
 *
 * @module runtime-contracts/pipeline-interaction
 */

import { canonicalInputDigest } from "./idempotency.js";

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

export function createPipelineInteractionSpecV1(
  input: Omit<PipelineApprovalInteractionSpecV1, "schema" | "requestDigest">,
): PipelineApprovalInteractionSpecV1;
export function createPipelineInteractionSpecV1(
  input: Omit<PipelineClarificationInteractionSpecV1, "schema" | "requestDigest">,
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
  const core = input.kind === "approval"
    ? { ...shared, outcomeToSuccessor: input.outcomeToSuccessor }
    : { ...shared, outputKey: input.outputKey };
  return {
    ...core,
    requestDigest: digest(core),
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
  return { ...core, receiptHash: digest(core) };
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

export function digestPipelineDefinition(value: unknown): PipelineSha256Digest {
  return digest(value);
}

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
    if (value.requestDigest !== digest(core)) {
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
    if (value.receiptHash !== digest(core)) {
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

export function serializePipelineInteractionSpecV1(
  value: PipelineInteractionSpecV1,
): string {
  return serializeValidated(value, validatePipelineInteractionSpecV1);
}

export function deserializePipelineInteractionSpecV1(
  json: string,
): PipelineInteractionSpecV1 {
  return deserializeValidated(json, validatePipelineInteractionSpecV1);
}

export function serializePipelinePendingInteractionV1(
  value: PipelinePendingInteractionV1,
): string {
  return serializeValidated(value, validatePipelinePendingInteractionV1);
}

export function deserializePipelinePendingInteractionV1(
  json: string,
): PipelinePendingInteractionV1 {
  return deserializeValidated(json, validatePipelinePendingInteractionV1);
}

export function serializePipelineInteractionResumeV1(
  value: PipelineInteractionResumeV1,
): string {
  return serializeValidated(value, validatePipelineInteractionResumeV1);
}

export function deserializePipelineInteractionResumeV1(
  json: string,
): PipelineInteractionResumeV1 {
  return deserializeValidated(json, validatePipelineInteractionResumeV1);
}

function comparePendingBindings(
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

function validateResponse(
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

function validateChoices(
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

function validateScope(
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

function interactionKind(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
): void {
  if (value !== "approval" && value !== "clarification") {
    issue(issues, path, "INVALID_VALUE", "Interaction kind is invalid.");
  }
}

function exactKeys(
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

function boundedString(
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

function binding(
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

function nonNegativeInteger(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    issue(issues, path, "INVALID_VALUE", "Expected a non-negative integer.");
  }
}

function positiveInteger(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
): void {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    issue(issues, path, "INVALID_VALUE", "Expected a positive integer.");
  }
}

function sha256(
  value: unknown,
  path: string,
  issues: PipelineInteractionValidationIssue[],
  code: PipelineInteractionValidationIssue["code"] = "INVALID_VALUE",
): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    issue(issues, path, code, "Expected a lowercase SHA-256 digest binding.");
  }
}

function isoInstant(
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

function literal(
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

function invalidType<T>(
  path: string,
  label: string,
  issues: PipelineInteractionValidationIssue[],
): PipelineInteractionValidationResult<T> {
  issue(issues, path, "INVALID_TYPE", `Expected ${label}.`);
  return { valid: false, issues };
}

function finish<T>(
  value: unknown,
  issues: PipelineInteractionValidationIssue[],
): PipelineInteractionValidationResult<T> {
  return issues.length === 0
    ? { valid: true, value: value as T, issues: [] }
    : { valid: false, issues };
}

function serializeValidated<T>(
  value: T,
  validator: (candidate: unknown) => PipelineInteractionValidationResult<T>,
): string {
  const result = validator(value);
  if (!result.valid) {
    throw new Error(
      `Pipeline interaction serialization failed: ${result.issues
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("; ")}`,
    );
  }
  return JSON.stringify(result.value);
}

function deserializeValidated<T>(
  json: string,
  validator: (candidate: unknown) => PipelineInteractionValidationResult<T>,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Pipeline interaction deserialization failed: invalid JSON.");
  }
  const result = validator(parsed);
  if (!result.valid) {
    throw new Error(
      `Pipeline interaction deserialization failed: ${result.issues
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("; ")}`,
    );
  }
  return result.value;
}

function digest(value: unknown): PipelineSha256Digest {
  return `sha256:${canonicalInputDigest(value)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(
  issues: PipelineInteractionValidationIssue[],
  path: string,
  code: PipelineInteractionValidationIssue["code"],
  message: string,
): void {
  issues.push({ path, code, message });
}
