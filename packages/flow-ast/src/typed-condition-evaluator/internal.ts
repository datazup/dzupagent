import type {
  FlowTypedConditionEvaluationErrorCode,
  FlowTypedConditionEvaluationResult,
} from "../typed-condition-evaluator.js";

export type EvaluationFailure = Extract<
  FlowTypedConditionEvaluationResult,
  { readonly ok: false }
>;

export const MISSING_VALUE = Symbol(
  "dzupagent.flowTypedCondition.missing",
);
export type MissingValue = typeof MISSING_VALUE;

export type ValueResult =
  | { readonly ok: true; readonly value: unknown | MissingValue }
  | EvaluationFailure;

export function failure(
  code: FlowTypedConditionEvaluationErrorCode,
  message: string,
  path: string,
): EvaluationFailure {
  return { ok: false, code, message, path };
}

export function hasOwn(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
