/**
 * Compile-time value categories used by strict reference analysis.
 *
 * This is intentionally smaller than JSON Schema. It is sufficient for
 * scalar-vs-collection checks without pretending that opaque schema refs have
 * been resolved. `unknown` means no sound type is available; `any` preserves
 * an explicitly untyped authored input.
 */
export type FlowReferenceValueType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "credential"
  | "null"
  | "any"
  | "unknown";
