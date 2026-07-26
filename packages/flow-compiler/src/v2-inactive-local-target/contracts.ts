import { FLOW_TYPED_CONDITION_CAPABILITY } from "@dzupagent/flow-ast/typed-condition-evaluator";
import { FLOW_PRIMITIVE_MULTI_PORT_SAVE_CAPABILITY } from "@dzupagent/flow-dsl/v2-multi-port-save";
import { FLOW_PRIMITIVE_POLICY_NARROWING_CAPABILITY } from "@dzupagent/flow-dsl/v2-policy-narrowing";
import { FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY } from "@dzupagent/flow-dsl/v2-retry-policy";
import { FLOW_PRIMITIVE_TERMINAL_CATCH_CAPABILITY } from "@dzupagent/flow-dsl/v2-terminal-catch";

import type { CompilerOptions } from "../types.js";

export const V2_INACTIVE_LOCAL_TARGET_ID =
  "dzupagent.local-v2-inactive@1" as const;

export const V2_INACTIVE_LOCAL_TARGET_CAPABILITIES = Object.freeze([
  FLOW_TYPED_CONDITION_CAPABILITY,
  FLOW_PRIMITIVE_POLICY_NARROWING_CAPABILITY,
  FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY,
  FLOW_PRIMITIVE_TERMINAL_CATCH_CAPABILITY,
  FLOW_PRIMITIVE_MULTI_PORT_SAVE_CAPABILITY,
] as const);

export const V2_INACTIVE_LOCAL_TARGET_GATE_CODES = Object.freeze([
  "TYPED_CONDITION_TARGET_UNSUPPORTED",
  "V2_POLICY_TARGET_UNSUPPORTED",
  "V2_RETRY_TARGET_UNSUPPORTED",
  "V2_CATCH_TARGET_UNSUPPORTED",
  "V2_MULTI_SAVE_TARGET_UNSUPPORTED",
] as const);

export type V2InactiveLocalTargetCapability =
  (typeof V2_INACTIVE_LOCAL_TARGET_CAPABILITIES)[number];

export interface V2InactiveLocalTargetQualificationRequest {
  readonly source: string;
  /**
   * Closed qualification declaration, not proof that a runtime host exists.
   * Exactly the five reviewed provider-free capabilities are accepted.
   */
  readonly hostCapabilities: readonly string[];
  readonly conditionBindings: Readonly<Record<string, unknown>>;
  /**
   * The standalone qualifier evaluates conditions eagerly by default. The
   * local host uses the explicit deferred mode so conditions can be resolved
   * against checkpointed state and prior step outputs at their step boundary.
   */
  readonly conditionEvaluationMode?: "eager" | "deferred-runtime";
  readonly compilerOptions: CompilerOptions;
}

export type V2InactiveLocalTargetQualificationErrorCode =
  | "V2_LOCAL_TARGET_SOURCE_INVALID"
  | "V2_LOCAL_TARGET_V2_SOURCE_REQUIRED"
  | "V2_LOCAL_TARGET_EXACT_CAPABILITIES_REQUIRED"
  | "V2_LOCAL_TARGET_COVERAGE_INCOMPLETE"
  | "V2_LOCAL_TARGET_REGISTRY_INVALID"
  | "V2_LOCAL_TARGET_PRIMITIVE_BINDING_REQUIRED"
  | "V2_LOCAL_TARGET_PRIMITIVE_IDENTITY_DRIFT"
  | "V2_LOCAL_TARGET_TYPED_CONDITION_FAILED"
  | "V2_LOCAL_TARGET_COMPILER_GATE_REQUIRED"
  | "V2_LOCAL_TARGET_STRICT_COMPILER_REQUIRED";

export interface V2InactiveLocalTargetQualificationError {
  readonly code: V2InactiveLocalTargetQualificationErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly causes?: readonly string[];
}

export interface V2InactiveLocalTargetContractEvidence {
  readonly capability: Exclude<
    V2InactiveLocalTargetCapability,
    typeof FLOW_TYPED_CONDITION_CAPABILITY
  >;
  readonly authoredPath: string;
  readonly primitiveRef: `primitive://${string}@${string}`;
  readonly primitiveSemanticHash: `sha256:${string}`;
  readonly contractSha256: `sha256:${string}`;
}

export interface V2InactiveLocalTargetQualificationReceipt {
  readonly schema: "dzupagent.v2InactiveLocalTargetQualification/v1";
  readonly target: typeof V2_INACTIVE_LOCAL_TARGET_ID;
  readonly status: "qualified-inactive";
  readonly sourceSha256: `sha256:${string}`;
  readonly qualificationSha256: `sha256:${string}`;
  readonly capabilities: readonly V2InactiveLocalTargetCapability[];
  readonly compilerGate: {
    readonly referencePolicy: "strict";
    readonly artifactEmission: "blocked";
    readonly observedDiagnostics: typeof V2_INACTIVE_LOCAL_TARGET_GATE_CODES;
  };
  readonly coverage: {
    readonly typedConditions: number;
    readonly policyNarrowings: number;
    readonly retryPolicies: number;
    readonly terminalCatches: number;
    readonly multiPortSaves: number;
  };
  readonly conditionEvaluationMode: "eager" | "deferred-runtime";
  readonly conditionEvaluations: readonly (
    | {
        readonly path: string;
        readonly status: "evaluated";
        readonly value: boolean;
        readonly resolvedReferences: readonly string[];
      }
    | {
        readonly path: string;
        readonly status: "deferred-runtime";
      }
  )[];
  readonly primitiveContracts: readonly V2InactiveLocalTargetContractEvidence[];
  readonly lifecycle: {
    readonly activation: "inactive";
    readonly cancellation: "not-applicable-before-activation";
    readonly restart: "requalify-exact-source-and-capabilities";
    readonly evidence: "deterministic-qualification-receipt-only";
  };
  readonly authority: {
    readonly artifactEmission: false;
    readonly primitiveExecution: false;
    readonly providerDispatch: false;
    readonly stateMutation: false;
    readonly continuation: false;
    readonly deployment: false;
    readonly promotion: false;
    readonly activation: false;
  };
}

export type V2InactiveLocalTargetQualificationResult =
  | {
      readonly ok: true;
      readonly receipt: V2InactiveLocalTargetQualificationReceipt;
    }
  | {
      readonly ok: false;
      readonly errors: readonly V2InactiveLocalTargetQualificationError[];
    };
