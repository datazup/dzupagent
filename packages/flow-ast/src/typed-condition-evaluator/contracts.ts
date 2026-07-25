export interface FlowTypedConditionEvaluationOptions {
  /** Capabilities explicitly owned by the calling host. */
  readonly hostCapabilities: readonly string[];
  /** Runtime values keyed by canonical strict reference roots. */
  readonly bindings: Readonly<Record<string, unknown>>;
}

export type FlowTypedConditionEvaluationErrorCode =
  | "TYPED_CONDITION_CAPABILITY_REQUIRED"
  | "INVALID_TYPED_CONDITION"
  | "RAW_JS_EXPRESSION_FORBIDDEN"
  | "INVALID_TYPED_REFERENCE"
  | "TYPED_REFERENCE_MISSING"
  | "TYPED_CONDITION_TYPE_MISMATCH"
  | "TYPED_CONDITION_VALUE_UNSUPPORTED";

export type FlowTypedConditionEvaluationResult =
  | {
      readonly ok: true;
      readonly value: boolean;
      readonly resolvedReferences: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: FlowTypedConditionEvaluationErrorCode;
      readonly message: string;
      readonly path: string;
    };
