export type FlowPrimitive = string | number | boolean | null;
export type FlowValue =
  | FlowPrimitive
  | FlowValue[]
  | { [key: string]: FlowValue };

/**
 * Portable data-classification vocabulary for authored flow values.
 *
 * The order is monotonic: derived values may retain or increase their
 * classification, but may only decrease it through an explicit reviewed
 * redaction/declassification primitive.
 */
export type FlowDataClassification =
  | "public"
  | "internal"
  | "sensitive"
  | "secret";

/** Runtime-stable list of {@link FlowDataClassification} values. */
export const FLOW_DATA_CLASSIFICATIONS: readonly FlowDataClassification[] = [
  "public",
  "internal",
  "sensitive",
  "secret",
] as const;

export type FlowDiagnosticCategory =
  | "shape"
  | "resolution"
  | "registry"
  | "policy"
  | "artifact"
  | "provenance"
  | "control"
  | "condition"
  | "resume"
  | "mutation"
  | "lowering"
  | "internal";

export interface FlowArtifactContract {
  path?: string;
  kind?: string;
  required?: boolean;
  description?: string;
}

export interface FlowReviewGateMetadata {
  gate?: string;
  reviewerRole?: string;
  decisionNeeded?: string;
  artifactRef?: string;
}

export interface FlowResumeMetadata {
  mode?: "manual" | "event" | "condition";
  condition?: string;
  checkpointRef?: string;
  /**
   * P0 durability contract: marks this node as a safe resume frontier — the
   * runtime may restart the flow from here without replaying prior nodes.
   * Defaults to false (the node is not a guaranteed resume point).
   */
  safeToReplayFrom?: boolean;
  /** State keys to restore when resuming from this point. */
  restoreStateKeys?: string[];
}

export interface FlowMutationMetadata {
  policy?: "read-only" | "idempotent" | "mutating";
  idempotencyKey?: string;
}

/**
 * P0 durability contract — replay governance shared across side-effecting
 * nodes. Promoted from the per-node string literal that `adapter.*` nodes
 * already declared, so all nodes use one type (see the 2026-06-17
 * durability-contract reconciliation decision).
 */
export type NodeIdempotencyMode =
  | "idempotent"
  | "at-least-once"
  | "exactly-once-required";

/** Runtime-stable list of {@link NodeIdempotencyMode} values. */
export const NODE_IDEMPOTENCY_MODES: readonly NodeIdempotencyMode[] = [
  "idempotent",
  "at-least-once",
  "exactly-once-required",
] as const;

/**
 * P0 durability contract — fine-grained side-effect classification (spec §5.5).
 * Refines the coarse {@link FlowMutationMetadata} `policy`; drives compiler
 * diagnostic D1 (mutating effect without idempotency).
 */
export type EffectClass =
  | "read"
  | "compute"
  | "llm"
  | "file_write"
  | "code_change"
  | "network_write"
  | "db_write"
  | "human_decision"
  | "queue_publish";

/** Runtime-stable list of {@link EffectClass} values. */
export const EFFECT_CLASSES: readonly EffectClass[] = [
  "read",
  "compute",
  "llm",
  "file_write",
  "code_change",
  "network_write",
  "db_write",
  "human_decision",
  "queue_publish",
] as const;

/** Effect classes that mutate external state and therefore require an
 * idempotency declaration (compiler diagnostic D1). */
export const MUTATING_EFFECT_CLASSES: readonly EffectClass[] = [
  "file_write",
  "code_change",
  "network_write",
  "db_write",
  "queue_publish",
] as const;

/**
 * Map the coarse {@link FlowMutationMetadata} `policy` onto an
 * {@link EffectClass}. `read-only → read`, `idempotent → compute`,
 * `mutating → db_write` (the generic write class). Returns `undefined` when
 * no policy is declared.
 */
export function effectClassFromMutationPolicy(
  policy: FlowMutationMetadata["policy"] | undefined
): EffectClass | undefined {
  switch (policy) {
    case "read-only":
      return "read";
    case "idempotent":
      return "compute";
    case "mutating":
      return "db_write";
    default:
      return undefined;
  }
}

/**
 * P0 durability contract — top-level crash-safety profile for a flow run
 * (spec §5.1). Entirely additive: absent ⇒ `volatile`. The DSL declares
 * recoverable *intent*; the runtime supplies stores/queues/leases.
 */
export interface FlowDurabilityPolicy {
  /** `volatile` (default) | `checkpointed` | `durable`. */
  mode?: "volatile" | "checkpointed" | "durable";
  checkpoint?: {
    strategy?:
      | "explicit"
      | "after_each_node"
      | "after_each_effect"
      | "after_each_branch";
    /** Reference to a configured checkpoint store (resolved at runtime). */
    storeRef?: string;
    includeEvents?: boolean;
    includeProviderSessionRefs?: boolean;
    retention?: {
      ttlMs?: number;
      maxVersions?: number;
    };
  };
  resume?: {
    onProcessRestart?:
      | "fail_running"
      | "resume_from_checkpoint"
      | "redeliver_running";
    requireResumePoint?: boolean;
    maxReplayNodes?: number;
  };
  executionLog?: {
    storeRef?: string;
    eventHistory?: "none" | "compact" | "full";
  };
}

export type FlowNodeMetadata = Record<string, unknown> & {
  invocation?: Record<string, unknown>;
  requires?: FlowValue;
  produces?: FlowValue;
  updates?: FlowValue;
  artifacts?: FlowArtifactContract[] | FlowValue;
  evidence?: FlowValue;
  provenance?: FlowValue;
  review?: FlowReviewGateMetadata | FlowValue;
  approval?: FlowReviewGateMetadata | FlowValue;
  resume?: FlowResumeMetadata | FlowValue;
  idempotency?: FlowValue;
  mutation?: FlowMutationMetadata | FlowValue;
  conditions?: Record<string, string> | FlowValue;
};

export interface FlowNodeBase {
  /**
   * Stable node identifier. Optional at the low-level AST layer for backward
   * compatibility with existing compiler fixtures; required by
   * `FlowDocumentV1` validation for canonical authored flows.
   */
  id?: string;
  name?: string;
  description?: string;
  meta?: FlowNodeMetadata;
  /**
   * P0 durability contract (node-field follow-up): fine-grained side-effect
   * classification, driving compiler diagnostic D1. Optional and additive —
   * absent ⇒ unclassified (no D1). Refines the coarse `meta.mutation.policy`;
   * map via `effectClassFromMutationPolicy`.
   */
  effectClass?: EffectClass;
  /**
   * P0 durability contract (node-field follow-up): replay governance for a
   * side-effecting node. Shared with `adapter.*` nodes. Absent ⇒ runtime
   * default (`at-least-once`). Drives diagnostics D1/D2.
   */
  idempotency?: NodeIdempotencyMode;
  /**
   * P0 durability contract: declares this node as a safe resume frontier for
   * flows that require explicit resume points. Checkpoint nodes are treated as
   * resume points even when this field is absent.
   */
  resumePoint?: boolean;
}

export interface FlowInputSpec {
  type: "string" | "number" | "boolean" | "object" | "array" | "any";
  required?: boolean;
  description?: string;
  default?: FlowValue;
  /** Optional compile-time classification propagated to dependent values. */
  classification?: FlowDataClassification;
}

export interface FlowDefaults {
  personaRef?: string;
  timeoutMs?: number;
  retry?: {
    attempts: number;
    delayMs?: number;
  };
}
