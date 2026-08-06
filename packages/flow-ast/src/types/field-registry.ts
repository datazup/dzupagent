import type { FlowNodeBase } from "./primitives.js";
import { EFFECT_CLASSES, NODE_IDEMPOTENCY_MODES } from "./primitives.js";

/**
 * Field-level codec registry (doc 14 §6.1, packet F-R1).
 *
 * `FLOW_NODE_KIND_REGISTRY` pins the kind set; this table pins the FIELDS the
 * authoring codec must carry through every stage. Each stage historically
 * hand-wrote its own field list (normalize `COMMON_NODE_KEYS`, parse
 * `parseCommonNodeFields`, validate `validateCommonNodeFields`, format
 * `pushCommon`), and the lists drifted: `effectClass` was parseable but not
 * normalizable, `idempotency` normalized into `meta` while parse put it on the
 * typed position, and `resumePoint` survived every stage except the formatter.
 *
 * This registry is the single source the drifting lists derive from. flow-dsl
 * normalize and format consume it directly; parse/validate agreement is pinned
 * by tests until those stages are migrated onto the table (F-R1 follow-up).
 */

/** Stages of the authoring codec that must agree on a registered field. */
export type FlowFieldStage = "normalize" | "parse" | "validate" | "format";

/** Value shape a registered field admits, interpretable by every stage. */
export type FlowFieldValueSpec =
  | { readonly kind: "string" }
  | { readonly kind: "boolean" }
  | { readonly kind: "object" }
  | { readonly kind: "enum"; readonly values: readonly string[] };

export interface FlowCommonFieldSpec {
  /** Typed position on {@link FlowNodeBase}. */
  readonly field: keyof FlowNodeBase & string;
  readonly value: FlowFieldValueSpec;
  /**
   * Structural fields (`id`/`name`/`description`/`meta`) have bespoke
   * normalize/format handling (id diagnostics, text blocks, the meta object
   * walk). Non-structural fields — the execution contract — are admitted and
   * emitted generically, driven by {@link value} alone.
   */
  readonly structural: boolean;
}

export const FLOW_COMMON_FIELD_REGISTRY = [
  { field: "id", value: { kind: "string" }, structural: true },
  { field: "name", value: { kind: "string" }, structural: true },
  { field: "description", value: { kind: "string" }, structural: true },
  { field: "meta", value: { kind: "object" }, structural: true },
  {
    field: "effectClass",
    value: { kind: "enum", values: EFFECT_CLASSES },
    structural: false,
  },
  {
    field: "idempotency",
    value: { kind: "enum", values: NODE_IDEMPOTENCY_MODES },
    structural: false,
  },
  { field: "resumePoint", value: { kind: "boolean" }, structural: false },
] as const satisfies readonly FlowCommonFieldSpec[];

type RegisteredCommonField = (typeof FLOW_COMMON_FIELD_REGISTRY)[number]["field"];

/**
 * Compile-time exhaustiveness in the direction `satisfies` cannot check:
 * every {@link FlowNodeBase} key must appear in the registry. (The reverse —
 * every registry entry names a real key — is enforced by the
 * `keyof FlowNodeBase` constraint on {@link FlowCommonFieldSpec}.)
 */
type AssertRegistryCoversFlowNodeBase = [keyof FlowNodeBase] extends [
  RegisteredCommonField,
]
  ? true
  : never;
const _registryCoversFlowNodeBase: AssertRegistryCoversFlowNodeBase = true;
void _registryCoversFlowNodeBase;

/** Names of every registered common field, in registry order. */
export const FLOW_COMMON_FIELD_NAMES: readonly (keyof FlowNodeBase & string)[] =
  FLOW_COMMON_FIELD_REGISTRY.map((spec) => spec.field);

/**
 * The non-structural slice: the execution-contract fields
 * (`effectClass`/`idempotency`/`resumePoint`) every kind admits and emits
 * generically.
 */
export const FLOW_EXECUTION_CONTRACT_FIELDS: readonly FlowCommonFieldSpec[] =
  FLOW_COMMON_FIELD_REGISTRY.filter((spec) => !spec.structural);
