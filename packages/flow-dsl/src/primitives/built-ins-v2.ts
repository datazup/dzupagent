import { COLLAB_REVIEW_LOOP_V2_SCHEMA } from "./collab-review-loop-v2.js";
import { definePrimitiveV2 } from "./definition-v2.js";
import type {
  PrimitiveDefinitionV2,
  PrimitiveDefinitionV2Input,
} from "./types.js";

const ALL_CLASSIFICATIONS = [
  "public",
  "internal",
  "sensitive",
  "secret",
] as const;
const SAFE_SINK_CLASSIFICATIONS = ["public", "internal"] as const;
const EMPTY_ERROR_SCHEMA = {
  type: "object",
  required: ["code", "message"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    retryable: { type: "boolean" },
  },
  additionalProperties: true,
} as const;

type DefinitionOverrides = Omit<
  PrimitiveDefinitionV2Input,
  | "schema"
  | "ref"
  | "owner"
  | "stability"
  | "requiresKernel"
  | "requiresProfiles"
  | "errorSchema"
  | "errors"
  | "credentialInputPaths"
  | "policy"
  | "evidence"
  | "compatibility"
> &
  Partial<
    Pick<
      PrimitiveDefinitionV2Input,
      | "owner"
      | "stability"
      | "requiresProfiles"
      | "errors"
      | "credentialInputPaths"
      | "policy"
      | "evidence"
      | "compatibility"
    >
  >;

function builtIn(
  overrides: DefinitionOverrides,
  authoredKind = `${overrides.namespace}.${overrides.name}`,
): PrimitiveDefinitionV2 {
  const kind = authoredKind.replace(/^\./, "");
  return definePrimitiveV2({
    schema: "dzupagent.primitiveDefinition/v2",
    ref: `primitive://${kind}@${overrides.version}`,
    owner: "dzupagent",
    stability: "beta",
    requiresKernel: ">=1 <2",
    requiresProfiles: [],
    errorSchema: EMPTY_ERROR_SCHEMA,
    errors: [],
    policy: {
      allowedOverrides: ["timeoutMs", "budgetCents", "requireApproval"],
      requiredApprovalClasses: [],
      requiresBudgetReservation: false,
    },
    evidence: {
      required: [],
      rawContent: "forbidden",
      redactionReceiptRequired: false,
    },
    compatibility: {
      supersedes: [],
      deprecatedAliases: [],
    },
    credentialInputPaths: [],
    ...overrides,
  });
}

const ADAPTER_RUN = builtIn({
  namespace: "adapter",
  name: "run",
  version: "1",
  category: "leaf",
  description: "Run one provider adapter call through the host registry.",
  requiresCapabilities: [
    "flow.runtime.adapter.run@1",
    "flow.runtime.credential.resolve@1",
  ],
  inputSchema: {
    type: "object",
    required: ["instructions", "output"],
    properties: {
      provider: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      instructions: { type: "string", minLength: 1 },
      output: { type: "string", minLength: 1 },
    },
  },
  acceptedInputClassifications: SAFE_SINK_CLASSIFICATIONS,
  credentialInputs: "handle-only",
  credentialInputPaths: ["input.credential", "input.credentials.*"],
  credentialResolverCapabilityRef: "flow.runtime.credential.resolve@1",
  outputPorts: {
    result: {
      schema: {},
      cardinality: "one",
      classification: "internal",
      persistence: "state",
    },
  },
  effect: {
    classes: ["llm"],
    idempotency: "at-least-once",
    replay: "deduplicated",
  },
  execution: {
    kind: "runtime-leaf",
    handlerRef: "adapter.run",
    delivery: ["inline", "queued"],
    durability: ["checkpointed", "durable"],
    maySuspend: false,
    cancellation: "required",
  },
  errors: [
    { code: "ADAPTER_FAILED", retryable: true },
    { code: "ADAPTER_CANCELLED", retryable: false },
  ],
  policy: {
    allowedOverrides: ["timeoutMs", "budgetCents", "requireApproval"],
    requiredApprovalClasses: [],
    requiresBudgetReservation: true,
  },
  evidence: {
    required: ["provider-attempt", "usage"],
    rawContent: "ephemeral",
    redactionReceiptRequired: false,
  },
});

const VALIDATE = builtIn({
  namespace: "validate",
  name: "validate",
  version: "1",
  category: "validator",
  description: "Run validation commands or a referenced validation suite.",
  requiresCapabilities: ["flow.runtime.validate@1"],
  inputSchema: { type: "object" },
  acceptedInputClassifications: ALL_CLASSIFICATIONS,
  credentialInputs: "forbidden",
  outputPorts: {
    result: {
      schema: { type: "object" },
      cardinality: "one",
      classification: "internal",
      persistence: "state",
    },
  },
  effect: {
    classes: ["compute"],
    idempotency: "idempotent",
    replay: "safe",
  },
  execution: {
    kind: "host-action",
    handlerRef: "validate",
    delivery: ["inline", "queued"],
    durability: ["checkpointed", "durable"],
    maySuspend: false,
    cancellation: "cooperative",
  },
  errors: [{ code: "VALIDATION_FAILED", retryable: false }],
}, "validate");

const APPROVAL = builtIn({
  namespace: "human",
  name: "approval",
  version: "1",
  category: "leaf",
  description: "Pause for a human approval decision.",
  requiresCapabilities: ["flow.runtime.approval@1"],
  inputSchema: { type: "object" },
  acceptedInputClassifications: SAFE_SINK_CLASSIFICATIONS,
  credentialInputs: "forbidden",
  outputPorts: {
    decision: {
      schema: { type: "string", enum: ["approved", "rejected"] },
      cardinality: "one",
      classification: "internal",
      persistence: "state",
    },
  },
  effect: {
    classes: ["human_decision"],
    idempotency: "exactly-once-required",
    replay: "deduplicated",
  },
  execution: {
    kind: "host-action",
    handlerRef: "approval",
    delivery: ["queued"],
    durability: ["durable"],
    maySuspend: true,
    cancellation: "required",
  },
  errors: [
    { code: "APPROVAL_REJECTED", retryable: false },
    { code: "APPROVAL_EXPIRED", retryable: false },
  ],
  policy: {
    allowedOverrides: ["timeoutMs", "requireApproval"],
    requiredApprovalClasses: ["human-decision"],
    requiresBudgetReservation: false,
  },
  evidence: {
    required: ["decision-receipt"],
    rawContent: "forbidden",
    redactionReceiptRequired: false,
  },
}, "approval");

function reviewLoop(version: "1" | "2"): PrimitiveDefinitionV2 {
  const isV2 = version === "2";
  return builtIn({
    namespace: "collab",
    name: "review_loop",
    version,
    category: "composite",
    description: isV2
      ? "Implement, validate, review, and reconcile one identity-bound packet."
      : "Propose, cross-validate, run gates, and reconcile.",
    requiresProfiles: ["dzup.adapters@1"],
    requiresCapabilities: ["flow.compile.composite-expansion@1"],
    inputSchema: isV2 ? COLLAB_REVIEW_LOOP_V2_SCHEMA : { type: "object" },
    acceptedInputClassifications: SAFE_SINK_CLASSIFICATIONS,
    credentialInputs: "forbidden",
    outputPorts: {
      result: {
        schema: { type: "object" },
        cardinality: "one",
        classification: "internal",
        persistence: "state",
      },
    },
    effect: {
      classes: ["llm", "compute"],
      idempotency: "at-least-once",
      replay: "deduplicated",
    },
    execution: {
      kind: "expand",
      expansionRef: `collab.review_loop@${version}`,
      expandsTo: isV2
        ? [
            "adapter.run",
            "evidence.write",
            "validate",
            "validate.schema",
            "if",
            "return_to",
            "complete",
          ]
        : ["adapter.run", "validate", "if", "approval", "complete"],
      delivery: ["inline"],
      durability: ["checkpointed"],
      maySuspend: !isV2,
      cancellation: "cooperative",
    },
    errors: [
      { code: "REVIEW_NOT_ACCEPTED", retryable: true },
      { code: "REVIEW_BUDGET_EXHAUSTED", retryable: false },
    ],
    policy: {
      allowedOverrides: ["timeoutMs", "budgetCents", "requireApproval"],
      requiredApprovalClasses: [],
      requiresBudgetReservation: true,
    },
    evidence: {
      required: ["proposal", "review-decision"],
      rawContent: "ephemeral",
      redactionReceiptRequired: false,
    },
    compatibility: {
      supersedes:
        version === "2" ? ["primitive://collab.review_loop@1"] : [],
      deprecatedAliases: [],
    },
  });
}

const SHELL_RUN = builtIn({
  namespace: "shell",
  name: "run",
  version: "1",
  category: "leaf",
  description: "Run a shell command through the host command port.",
  requiresCapabilities: ["flow.runtime.shell.run@1"],
  inputSchema: { type: "object" },
  acceptedInputClassifications: SAFE_SINK_CLASSIFICATIONS,
  credentialInputs: "forbidden",
  outputPorts: {
    result: {
      schema: { type: "object" },
      cardinality: "one",
      classification: "internal",
      persistence: "state",
    },
  },
  effect: {
    classes: ["code_change"],
    idempotency: "at-least-once",
    replay: "not-replayable",
  },
  execution: {
    kind: "host-action",
    handlerRef: "shell.run",
    delivery: ["inline", "queued"],
    durability: ["checkpointed", "durable"],
    maySuspend: false,
    cancellation: "required",
  },
  errors: [
    { code: "COMMAND_FAILED", retryable: false },
    { code: "COMMAND_CANCELLED", retryable: false },
  ],
  policy: {
    allowedOverrides: ["timeoutMs", "requireApproval"],
    requiredApprovalClasses: ["code-change"],
    requiresBudgetReservation: false,
  },
});

const EVIDENCE_WRITE = builtIn({
  namespace: "evidence",
  name: "write",
  version: "1",
  category: "leaf",
  description: "Write sanitized digest evidence for a state value.",
  requiresCapabilities: ["flow.runtime.evidence.write@1"],
  inputSchema: { type: "object" },
  acceptedInputClassifications: ALL_CLASSIFICATIONS,
  credentialInputs: "forbidden",
  redactionRequiredAbove: "internal",
  outputPorts: {
    receipt: {
      schema: { type: "object" },
      cardinality: "one",
      classification: "internal",
      persistence: "artifact",
    },
  },
  effect: {
    classes: ["file_write"],
    idempotency: "idempotent",
    replay: "safe",
  },
  execution: {
    kind: "host-action",
    handlerRef: "evidence.write",
    delivery: ["inline", "queued"],
    durability: ["durable"],
    maySuspend: false,
    cancellation: "cooperative",
  },
  errors: [{ code: "EVIDENCE_WRITE_FAILED", retryable: true }],
  evidence: {
    required: ["redaction-receipt"],
    rawContent: "forbidden",
    redactionPolicyRef: "policy://dzupagent/evidence-redaction@1",
    redactionReceiptRequired: true,
    redactionReceiptSchema: "dzupagent.flowRedactionReceipt/v1",
  },
});

const VALIDATE_SCHEMA = builtIn({
  namespace: "validate",
  name: "schema",
  version: "1",
  category: "validator",
  description: "Validate a state value against a schema ref or inline schema.",
  requiresCapabilities: ["flow.runtime.validate.schema@1"],
  inputSchema: { type: "object" },
  acceptedInputClassifications: ALL_CLASSIFICATIONS,
  credentialInputs: "forbidden",
  outputPorts: {
    result: {
      schema: { type: "object" },
      cardinality: "one",
      classification: "internal",
      persistence: "state",
    },
  },
  effect: {
    classes: ["compute"],
    idempotency: "idempotent",
    replay: "safe",
  },
  execution: {
    kind: "host-action",
    handlerRef: "validate.schema",
    delivery: ["inline"],
    durability: ["checkpointed", "durable"],
    maySuspend: false,
    cancellation: "none",
  },
  errors: [{ code: "SCHEMA_VALIDATION_FAILED", retryable: false }],
});

/** Serializable source of truth for every built-in primitive. */
export const BUILT_IN_PRIMITIVE_DEFINITIONS_V2: readonly PrimitiveDefinitionV2[] =
  Object.freeze([
    ADAPTER_RUN,
    VALIDATE,
    APPROVAL,
    reviewLoop("2"),
    reviewLoop("1"),
    SHELL_RUN,
    EVIDENCE_WRITE,
    VALIDATE_SCHEMA,
  ]);
