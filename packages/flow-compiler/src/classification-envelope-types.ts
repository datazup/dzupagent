import type {
  EffectClass,
  FlowDataClassification,
  ResolvedToolKind,
} from "@dzupagent/flow-ast";

import type { FlowReferenceValueType } from "./reference-value-types.js";

export const FLOW_COMPILED_CLASSIFICATION_ENVELOPE_SCHEMA =
  "dzupagent.flowCompiledClassificationEnvelope/v1" as const;

export interface FlowCompiledClassifiedValue {
  readonly reference: string;
  readonly root: string;
  readonly name: string;
  readonly classification: FlowDataClassification;
  readonly valueType: FlowReferenceValueType;
  readonly credential?: {
    readonly form: "opaque-handle";
    readonly resolution: "lease-only";
  };
}

export interface FlowCompiledClassifiedPort {
  readonly reference: string;
  readonly stepId: string;
  readonly port: string;
  readonly classification: FlowDataClassification;
  readonly valueType: FlowReferenceValueType;
}

export interface FlowCompiledPrimitiveOutputObligation {
  readonly port: string;
  readonly expectedClassification: FlowDataClassification;
  readonly effectiveClassification: FlowDataClassification;
  readonly cardinality: "one" | "optional" | "many";
  readonly persistence: "state" | "artifact" | "ephemeral";
}

export interface FlowCompiledPrimitiveObligation {
  readonly nodePath: string;
  readonly nodeId?: string;
  readonly primitiveRef: `primitive://${string}@${string}`;
  readonly requiredCapabilities: readonly string[];
  readonly acceptedInputClassifications: readonly FlowDataClassification[];
  readonly credential?: {
    readonly mode: "handle-only" | "raw-by-policy";
    readonly inputPaths: readonly string[];
    readonly resolverCapabilityRef?: string;
    readonly allowedProviders?: readonly string[];
    readonly requiredScopes?: readonly string[];
    readonly httpAuth?: {
      readonly scheme: "bearer" | "basic" | "api-key-header";
      readonly headerName?: string;
    };
  };
  readonly redaction?: {
    readonly requiredAbove?: FlowDataClassification;
    readonly policyRef?: string;
    readonly receiptRequired: boolean;
    readonly receiptSchema?: "dzupagent.flowRedactionReceipt/v1";
  };
  readonly outputs: readonly FlowCompiledPrimitiveOutputObligation[];
}

export interface FlowCompiledIntegrationObligation {
  readonly nodePath: string;
  readonly nodeId?: string;
  readonly toolRef: string;
  readonly toolKind: ResolvedToolKind;
  readonly policyHash: `sha256:${string}`;
  readonly acceptedInputClassifications: readonly FlowDataClassification[];
  readonly credential?: {
    readonly mode: "handle-only";
    readonly inputPaths: readonly string[];
    readonly resolverCapabilityRef: string;
    readonly allowedProviders: readonly string[];
    readonly requiredScopes: readonly string[];
  };
  readonly outputClassification: FlowDataClassification;
  readonly effectClasses: readonly EffectClass[];
  readonly evidence: {
    readonly required: readonly string[];
    readonly classification: FlowDataClassification;
    readonly rawContent: "forbidden" | "ephemeral" | "allowed-by-policy";
  };
}

/**
 * Immutable compile-time policy projection. It carries identities and
 * obligations only; authored/runtime values and raw credential material are
 * deliberately absent.
 */
export interface FlowCompiledClassificationEnvelope {
  readonly schema: typeof FLOW_COMPILED_CLASSIFICATION_ENVELOPE_SCHEMA;
  readonly compileId: string;
  readonly semanticHash: string;
  readonly classificationHash: `sha256:${string}`;
  readonly classificationComplete: boolean;
  readonly unclassifiedReferences: readonly string[];
  readonly values: readonly FlowCompiledClassifiedValue[];
  readonly ports: readonly FlowCompiledClassifiedPort[];
  readonly primitives: readonly FlowCompiledPrimitiveObligation[];
  readonly integrations: readonly FlowCompiledIntegrationObligation[];
}

export interface FlowCompiledClassificationEnvelopeValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}
