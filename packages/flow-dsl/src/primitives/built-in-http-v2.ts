import { definePrimitiveV2 } from "./definition-v2.js";

/** Strict handle-only HTTP primitive security and execution contract. */
export const HTTP_PRIMITIVE_DEFINITION_V2 = definePrimitiveV2({
  schema: "dzupagent.primitiveDefinition/v2",
  ref: "primitive://http@1",
  namespace: "",
  name: "http",
  version: "1",
  owner: "dzupagent",
  stability: "beta",
  category: "leaf",
  description:
    "Call one reviewed HTTP endpoint with optional host-injected credential auth.",
  requiresKernel: ">=1 <2",
  requiresProfiles: [],
  requiresCapabilities: [
    "flow.runtime.http@1",
    "flow.runtime.credential.resolve@1",
  ],
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", minLength: 1 },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      headers: { type: "object" },
      body: { type: "object" },
      auth: {
        type: "object",
        required: ["scheme", "credential", "provider", "scopes"],
        properties: {
          scheme: {
            type: "string",
            enum: ["bearer", "basic", "api-key-header"],
          },
          credential: {},
          provider: { type: "string", minLength: 1 },
          scopes: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true,
          },
          headerName: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  acceptedInputClassifications: ["public", "internal"],
  credentialInputs: "handle-only",
  credentialInputPaths: ["auth.credential"],
  credentialResolverCapabilityRef: "flow.runtime.credential.resolve@1",
  outputPorts: {
    response: {
      schema: { type: "object" },
      cardinality: "one",
      classification: "sensitive",
      persistence: "state",
    },
  },
  errorSchema: {
    type: "object",
    required: ["code", "message"],
    properties: {
      code: { type: "string" },
      message: { type: "string" },
      retryable: { type: "boolean" },
    },
    additionalProperties: true,
  },
  errors: [
    { code: "HTTP_REQUEST_FAILED", retryable: true },
    { code: "HTTP_AUTH_DENIED", retryable: false },
  ],
  effect: {
    classes: ["network_write"],
    idempotency: "at-least-once",
    replay: "deduplicated",
  },
  execution: {
    kind: "host-action",
    handlerRef: "http",
    delivery: ["inline", "queued"],
    durability: ["checkpointed", "durable"],
    maySuspend: false,
    cancellation: "required",
  },
  policy: {
    allowedOverrides: ["timeoutMs", "requireApproval"],
    requiredApprovalClasses: ["network-write"],
    requiresBudgetReservation: false,
  },
  evidence: {
    required: ["http-request-outcome"],
    rawContent: "ephemeral",
    redactionReceiptRequired: false,
  },
  compatibility: {
    supersedes: [],
    deprecatedAliases: [],
  },
});
