import type {
  EffectClass,
  FlowDataClassification,
  FlowRedactionReceiptSchema,
  NodeIdempotencyMode,
} from "@dzupagent/flow-ast";

export type PrimitiveCategory =
  | "leaf"
  | "composite"
  | "structural"
  | "validator"
  | "transformer"
  | "governance";

export interface PrimitivePolicyDefaults {
  timeoutMs?: number;
  budgetCents?: number;
  requireApproval?: boolean;
  rawProviderOutput?: false;
}

export interface PrimitiveExpansionContext {
  kind: string;
  version: string;
}

export type PrimitiveExpansionHandler = (
  raw: unknown,
  context: PrimitiveExpansionContext
) => Array<Record<string, unknown>>;

export interface PrimitiveDefinition {
  kind: string;
  version: string;
  namespace: string;
  category: PrimitiveCategory;
  description?: string;
  schema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effectClass?: EffectClass;
  idempotency?: NodeIdempotencyMode;
  defaultPolicy?: PrimitivePolicyDefaults;
  expandsTo?: string[];
  expand?: PrimitiveExpansionHandler;
  executesWith?: string;
  supportsInlineBody?: boolean;
  supportsReferenceCall?: boolean;
}

export type PrimitiveStability =
  | "experimental"
  | "beta"
  | "stable"
  | "deprecated";

export type PrimitiveJsonSchema = Readonly<Record<string, unknown>>;
export type PrimitiveSchema = string | PrimitiveJsonSchema;

export interface PrimitiveOutputPortDefinition {
  schema: PrimitiveSchema;
  cardinality: "one" | "optional" | "many";
  classification: FlowDataClassification;
  persistence: "state" | "artifact" | "ephemeral";
}

export interface PrimitiveErrorDefinition {
  code: string;
  retryable: boolean;
  description?: string;
}

export interface PrimitiveDefinitionV2 {
  schema: "dzupagent.primitiveDefinition/v2";
  ref: `primitive://${string}@${string}`;
  namespace: string;
  name: string;
  version: string;
  owner: string;
  stability: PrimitiveStability;
  category: Exclude<PrimitiveCategory, "structural">;
  description?: string;

  requiresKernel: string;
  requiresProfiles: readonly string[];
  requiresCapabilities: readonly string[];

  inputSchema: PrimitiveSchema;
  acceptedInputClassifications: readonly FlowDataClassification[];
  /**
   * Reviewed classifications for exact or wildcard input-schema paths.
   *
   * Paths use dot notation and `*` for array/object items, for example
   * `request.customer.email` or `records.*.token`. Credential paths are
   * always projected as `secret` even when this map omits them.
   */
  inputPathClassifications?: Readonly<
    Record<string, FlowDataClassification>
  >;
  credentialInputs: "forbidden" | "handle-only" | "raw-by-policy";
  credentialInputPaths: readonly string[];
  credentialResolverCapabilityRef?: string;
  redactionRequiredAbove?: FlowDataClassification;
  outputPorts: Readonly<Record<string, PrimitiveOutputPortDefinition>>;
  errorSchema: PrimitiveSchema;
  errors: readonly PrimitiveErrorDefinition[];

  effect: {
    classes: readonly EffectClass[];
    idempotency:
      | "pure"
      | "idempotent"
      | "at-least-once"
      | "exactly-once-required";
    replay: "safe" | "deduplicated" | "not-replayable";
    compensation?: `primitive://${string}@${string}`;
  };

  execution: {
    kind: "expand" | "runtime-leaf" | "host-action";
    handlerRef?: string;
    expansionRef?: string;
    expandsTo?: readonly string[];
    delivery: readonly ("inline" | "queued" | "detached")[];
    durability: readonly ("volatile" | "checkpointed" | "durable")[];
    maySuspend: boolean;
    cancellation: "none" | "cooperative" | "required";
  };

  policy: {
    defaultRef?: string;
    allowedOverrides: readonly string[];
    requiredApprovalClasses: readonly string[];
    requiresBudgetReservation: boolean;
  };

  evidence: {
    required: readonly string[];
    rawContent: "forbidden" | "ephemeral" | "allowed-by-policy";
    redactionPolicyRef?: string;
    redactionReceiptRequired: boolean;
    redactionReceiptSchema?: FlowRedactionReceiptSchema;
  };

  compatibility: {
    semanticHash: `sha256:${string}`;
    supersedes: readonly `primitive://${string}@${string}`[];
    deprecatedAliases: readonly string[];
  };
}

export type PrimitiveDefinitionV2Input = Omit<
  PrimitiveDefinitionV2,
  "compatibility"
> & {
  compatibility: Omit<PrimitiveDefinitionV2["compatibility"], "semanticHash">;
};

export type PrimitiveExpansionHandlers = Readonly<
  Record<string, PrimitiveExpansionHandler | undefined>
>;

export interface PrimitiveRegistryV2 {
  readonly schema: "dzupagent.primitiveRegistry/v2";
  readonly registryHash: `sha256:${string}`;
  get(ref: `primitive://${string}@${string}`): PrimitiveDefinitionV2 | undefined;
  resolve(kind: string, version?: string): PrimitiveDefinitionV2 | undefined;
  resolveAlias(alias: string): PrimitiveDefinitionV2 | undefined;
  list(namespace?: string): readonly PrimitiveDefinitionV2[];
  has(ref: `primitive://${string}@${string}`): boolean;
}

export interface PrimitiveRegistryV2Options {
  /**
   * Fail registry construction when an inline-schema leaf has no reviewed
   * classification. Credential leaves are classified as secret implicitly.
   */
  requireClassifiedLeafInputs?: boolean;
}

export type PrimitiveAuthoringValueType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "credential"
  | "unknown";

export interface PrimitiveAuthoringField {
  readonly path: string;
  readonly jsonPointer: string;
  readonly valueType: PrimitiveAuthoringValueType;
  readonly required: boolean;
  readonly leaf: boolean;
  readonly classification: FlowDataClassification | "unclassified";
  readonly credential: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
}

export interface PrimitiveOutputAuthoringField {
  readonly path: string;
  readonly valueType: PrimitiveAuthoringValueType;
  readonly classification: FlowDataClassification;
  readonly cardinality: PrimitiveOutputPortDefinition["cardinality"];
  readonly persistence: PrimitiveOutputPortDefinition["persistence"];
}

export interface PrimitiveAuthoringMetadata {
  readonly schema: "dzupagent.primitiveAuthoringMetadata/v1";
  readonly primitiveRef: PrimitiveDefinitionV2["ref"];
  readonly semanticHash: PrimitiveDefinitionV2["compatibility"]["semanticHash"];
  readonly inputSchema: PrimitiveSchema;
  readonly inputFields: readonly PrimitiveAuthoringField[];
  readonly outputFields: readonly PrimitiveOutputAuthoringField[];
  readonly unclassifiedLeafPaths: readonly string[];
  readonly classificationComplete: boolean;
}

export interface PrimitiveRegistry {
  get(kind: string, version?: string): PrimitiveDefinition | undefined;
  list(namespace?: string): PrimitiveDefinition[];
  has(kind: string, version?: string): boolean;
}
