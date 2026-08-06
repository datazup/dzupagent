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
 * This registry is the single source the drifting lists derive from. ALL FOUR
 * stages now consume it: flow-dsl normalize and format read
 * `FLOW_EXECUTION_CONTRACT_FIELDS` directly, and flow-ast parse
 * (`parseCommonNodeFields`) and validate (`validateOptionalEffectClassField` /
 * `validateOptionalIdempotencyField`) delegate their admission decision to
 * {@link admitCommonField}. Each stage still owns its own DIAGNOSTIC shape —
 * only the admitted value set is shared.
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

type RegisteredCommonField =
  (typeof FLOW_COMMON_FIELD_REGISTRY)[number]["field"];

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

/**
 * Outcome of checking one authored value against a registered field's spec.
 *
 * `absent` and `invalid` are distinct on purpose: a field that was never
 * authored must not be written to the typed position (writing `undefined`
 * makes the key `in` the object and changes canonical output), while an
 * authored-but-invalid value must fail closed with a diagnostic.
 */
export type FlowFieldAdmission =
  | { readonly outcome: "absent" }
  | { readonly outcome: "admitted"; readonly value: string | boolean }
  | { readonly outcome: "invalid"; readonly expected: string };

/**
 * The ONE admission rule for a registered field, shared by every stage.
 *
 * normalize (flow-dsl), parse and validate (flow-ast) each hand-wrote this
 * check, so the admitted value set was duplicated three times and could drift
 * silently: a value added to `EFFECT_CLASSES` would be admitted by whichever
 * stages happened to re-derive it. Stages still own their DIAGNOSTIC shape
 * (`DslDiagnostic` / `ParseIssue` / `SchemaIssue` differ in code and pointer
 * spelling) — this function decides only whether a value is admissible, and
 * reports the expected set for the message.
 */
export function admitCommonField(
  spec: FlowCommonFieldSpec,
  value: unknown,
): FlowFieldAdmission {
  if (value === undefined) return { outcome: "absent" };
  switch (spec.value.kind) {
    case "boolean":
      return typeof value === "boolean"
        ? { outcome: "admitted", value }
        : { outcome: "invalid", expected: "a boolean" };
    case "enum":
      return typeof value === "string" && spec.value.values.includes(value)
        ? { outcome: "admitted", value }
        : { outcome: "invalid", expected: spec.value.values.join("|") };
    case "string":
      return typeof value === "string"
        ? { outcome: "admitted", value }
        : { outcome: "invalid", expected: "a string" };
    case "object":
      // Structural: `meta` keeps its bespoke plain-object walk at each stage.
      return { outcome: "absent" };
  }
}

/** Look up a registered field spec by name, or `undefined` if unregistered. */
export function commonFieldSpec(
  field: string,
): FlowCommonFieldSpec | undefined {
  return FLOW_COMMON_FIELD_REGISTRY.find((spec) => spec.field === field);
}
