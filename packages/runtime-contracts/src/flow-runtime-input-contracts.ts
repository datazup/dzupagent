/**
 * Flow runtime input contract declarations.
 *
 * Extracted from `flow-runtime-input.ts` (RF-03 pin exit). This module is a
 * LEAF: the validator and its primitives both depend on it, and it depends on
 * neither, so the four modules form a DAG rather than a cycle.
 * `flow-runtime-input.ts` re-exports all of it, and the package root barrel
 * still imports every public name from that path — the surface is unchanged.
 */

import type { CANONICAL_JSON_VERSION } from "./idempotency.js";

export const FLOW_RUNTIME_INPUT_CONTRACT =
  "dzupagent.flowRuntimeInput/v1" as const;
export const FLOW_CREDENTIAL_HANDLE_REF_SCHEMA =
  "dzupagent.flowCredentialHandle/v1" as const;

export type FlowRuntimeInputType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "credential"
  | "any";

export type FlowRuntimeInputClassification =
  | "public"
  | "internal"
  | "sensitive"
  | "secret";

export type FlowRuntimeJsonValue =
  | string
  | number
  | boolean
  | null
  | FlowRuntimeJsonValue[]
  | { [key: string]: FlowRuntimeJsonValue };

/**
 * Structural runtime view of a DzupFlow input declaration. `FlowInputSpec`
 * from `@dzupagent/flow-ast` is assignable to this type without creating a
 * reverse package dependency from runtime-contracts to flow-ast.
 */
export interface FlowRuntimeInputSpec {
  type: FlowRuntimeInputType;
  required?: boolean;
  default?: FlowRuntimeJsonValue;
  classification?: FlowRuntimeInputClassification;
}

/**
 * Secret-free, persistable reference to a host-owned credential. The worker
 * must re-resolve this reference and create the nominal FlowCredentialHandle;
 * this record never carries credential material.
 */
export interface FlowRuntimeCredentialHandleRef {
  schema: typeof FLOW_CREDENTIAL_HANDLE_REF_SCHEMA;
  handleId: string;
  bindingRef: string;
  capabilityRef: string;
  provider?: string;
  scopes: string[];
  expiresAt?: string;
}

export interface FlowRuntimeInputLimits {
  maxCanonicalBytes: number;
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxTotalValues: number;
  maxStringBytes: number;
}

export const DEFAULT_FLOW_RUNTIME_INPUT_LIMITS: Readonly<FlowRuntimeInputLimits> =
  Object.freeze({
    maxCanonicalBytes: 64 * 1024,
    maxDepth: 12,
    maxArrayItems: 512,
    maxObjectKeys: 256,
    maxTotalValues: 4_096,
    maxStringBytes: 16 * 1024,
  });

export type FlowRuntimeInputIssueCode =
  | "FLOW_INPUT_NOT_OBJECT"
  | "FLOW_INPUT_CONTRACT_INVALID"
  | "FLOW_INPUT_KEY_INVALID"
  | "FLOW_INPUT_UNKNOWN_KEY"
  | "FLOW_INPUT_REQUIRED"
  | "FLOW_INPUT_TYPE_MISMATCH"
  | "FLOW_INPUT_VALUE_INVALID"
  | "FLOW_INPUT_CREDENTIAL_INLINE_DENIED"
  | "FLOW_INPUT_CREDENTIAL_HANDLE_REQUIRED"
  | "FLOW_INPUT_CREDENTIAL_HANDLE_UNKNOWN"
  | "FLOW_INPUT_CREDENTIAL_HANDLE_INVALID"
  | "FLOW_INPUT_MAX_CANONICAL_BYTES"
  | "FLOW_INPUT_MAX_DEPTH"
  | "FLOW_INPUT_MAX_ARRAY_ITEMS"
  | "FLOW_INPUT_MAX_OBJECT_KEYS"
  | "FLOW_INPUT_MAX_TOTAL_VALUES"
  | "FLOW_INPUT_MAX_STRING_BYTES";

export interface FlowRuntimeInputIssue {
  code: FlowRuntimeInputIssueCode;
  path: string;
  message: string;
}

export interface FlowRuntimeInputValidationRequest {
  inputContract?: Record<string, FlowRuntimeInputSpec>;
  input?: unknown;
  credentialHandleRefs?: unknown;
  limits?: Partial<FlowRuntimeInputLimits>;
}

export interface ValidatedFlowRuntimeInput {
  contract: typeof FLOW_RUNTIME_INPUT_CONTRACT;
  canonicalization: typeof CANONICAL_JSON_VERSION;
  inputs: Record<string, FlowRuntimeJsonValue>;
  credentialHandleRefs: Record<string, FlowRuntimeCredentialHandleRef>;
  classifications: Record<string, FlowRuntimeInputClassification>;
  canonicalPayloadJson: string;
  canonicalBytes: number;
  payloadDigest: `sha256:${string}`;
  classificationMapDigest: `sha256:${string}`;
  credentialHandleDigests: Record<string, `sha256:${string}`>;
  /** Exact initial-state namespace expected by DzupFlow references. */
  runtimeState: {
    inputs: Record<
      string,
      FlowRuntimeJsonValue | FlowRuntimeCredentialHandleRef
    >;
  };
}

export type FlowRuntimeInputValidationResult =
  | { valid: true; value: ValidatedFlowRuntimeInput; issues: [] }
  | { valid: false; issues: FlowRuntimeInputIssue[] };
