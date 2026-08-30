/**
 * `ai-execution` request, target and binding contracts.
 *
 * The schema identifiers, operation kinds, and every declaration describing
 * what is being asked for and where it may run. The usage/event/receipt half —
 * what came back and what it cost — lives in `ai-execution-receipt-types.ts`.
 * Both are leaf modules: they declare no behavior and import no validator, so
 * the validators in `ai-execution.ts` can depend on them without a cycle.
 *
 * `ai-execution.ts` re-exports this module wholesale, so the public
 * `@dzupagent/runtime-contracts/ai-execution` surface is unchanged.
 *
 * @module ai-execution-types
 */

import type {
  ExecutionArtifactRef,
  ExecutionRequest,
  ProviderAuthenticationMode,
  ProviderExecutionBackend,
} from "./canonical-execution.js";

export const AI_EXECUTION_REQUEST_SCHEMA =
  "dzupagent.aiExecutionRequest/v1" as const;
export const AI_PUBLIC_TARGET_SCHEMA = "dzupagent.aiPublicTarget/v1" as const;
export const AI_RESOLVED_TARGET_SCHEMA =
  "dzupagent.aiResolvedTarget/v1" as const;
export const AI_EXECUTION_EVENT_SCHEMA =
  "dzupagent.aiExecutionEvent/v1" as const;
export const AI_EXECUTION_RECEIPT_SCHEMA =
  "dzupagent.aiExecutionReceipt/v1" as const;
export const AI_EXECUTION_RECEIPT_V2_SCHEMA =
  "dzupagent.aiExecutionReceipt/v2" as const;
export const AI_EXECUTION_OFFER_SCHEMA =
  "dzupagent.aiExecutionOffer/v1" as const;
export const AI_EXECUTION_BINDING_SCHEMA =
  "dzupagent.aiExecutionBinding/v1" as const;

export const AI_EXECUTION_OPERATION_KINDS = [
  "text.generate",
  "chat.generate",
  "structured.generate",
  "embedding.create",
  "audio.transcribe",
  "speech.synthesize",
  "image.analyze",
  "token.count",
  "agent.run",
] as const;

export type AiExecutionOperationKind =
  (typeof AI_EXECUTION_OPERATION_KINDS)[number];

export const AI_TARGET_PLACEMENTS = ["server", "worker"] as const;
export type AiTargetPlacement = (typeof AI_TARGET_PLACEMENTS)[number];

export const AI_EXECUTION_STYLES = ["inline", "durable"] as const;
export type AiExecutionStyle = (typeof AI_EXECUTION_STYLES)[number];

/** Capability identifiers are stable names with an explicit major version. */
export const AI_CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9.-]*\/v[1-9][0-9]*$/;


export type AiJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AiJsonValue[]
  | { readonly [key: string]: AiJsonValue };

export interface AiTextGenerateOperation {
  readonly kind: "text.generate";
  readonly input: { readonly text: string };
  readonly output: { readonly modality: "text" };
}

export type AiChatRole = "system" | "user" | "assistant" | "tool";

export interface AiChatMessage {
  readonly role: AiChatRole;
  readonly content: string;
  readonly name?: string;
}

export interface AiChatGenerateOperation {
  readonly kind: "chat.generate";
  readonly input: { readonly messages: readonly AiChatMessage[] };
  readonly output: { readonly modality: "text" };
}

export interface AiStructuredGenerateOperation {
  readonly kind: "structured.generate";
  readonly input: { readonly prompt: string };
  readonly output: {
    readonly modality: "json";
    readonly schemaRef?: string;
    readonly schema?: Readonly<Record<string, AiJsonValue>>;
  };
}

export interface AiEmbeddingCreateOperation {
  readonly kind: "embedding.create";
  readonly input: { readonly texts: readonly string[] };
  readonly output: {
    readonly modality: "embedding";
    readonly dimensions?: number;
  };
}

export interface AiAudioTranscribeOperation {
  readonly kind: "audio.transcribe";
  readonly input: {
    readonly audio: ExecutionArtifactRef;
    readonly language?: string;
  };
  readonly output: { readonly modality: "text" };
}

export interface AiSpeechSynthesizeOperation {
  readonly kind: "speech.synthesize";
  readonly input: {
    readonly text: string;
    readonly voiceRef?: string;
  };
  readonly output: {
    readonly modality: "audio";
    readonly mediaTypes?: readonly string[];
  };
}

export interface AiImageAnalyzeOperation {
  readonly kind: "image.analyze";
  readonly input: {
    readonly images: readonly ExecutionArtifactRef[];
    readonly prompt?: string;
  };
  readonly output:
    | { readonly modality: "text" }
    | {
        readonly modality: "json";
        readonly schemaRef?: string;
        readonly schema?: Readonly<Record<string, AiJsonValue>>;
      };
}

export interface AiTokenCountOperation {
  readonly kind: "token.count";
  readonly input:
    | { readonly text: string; readonly messages?: never }
    | { readonly messages: readonly AiChatMessage[]; readonly text?: never };
  readonly output: { readonly modality: "token-count" };
}

export interface AiAgentRunOperation {
  readonly kind: "agent.run";
  readonly input: {
    readonly agentRef: string;
    readonly arguments?: Readonly<Record<string, AiJsonValue>>;
  };
  readonly output: { readonly modality: "text" | "json" | "unknown" };
}

export type AiExecutionOperation =
  | AiTextGenerateOperation
  | AiChatGenerateOperation
  | AiStructuredGenerateOperation
  | AiEmbeddingCreateOperation
  | AiAudioTranscribeOperation
  | AiSpeechSynthesizeOperation
  | AiImageAnalyzeOperation
  | AiTokenCountOperation
  | AiAgentRunOperation;

export type AiTargetSelector =
  | { readonly kind: "target-id"; readonly targetId: string }
  | { readonly kind: "task-profile"; readonly taskProfileId: string };

/**
 * Adds operation-specific input/output semantics to the existing canonical
 * ExecutionRequest. Route, policy, effect, cancellation, and evidence truth
 * remain owned by that canonical request instead of being redefined here.
 */
export interface AiExecutionRequest {
  readonly schema: typeof AI_EXECUTION_REQUEST_SCHEMA;
  readonly execution: ExecutionRequest;
  readonly operation: AiExecutionOperation;
  /** Opaque application catalog identity or app-owned task profile. */
  readonly target: AiTargetSelector;
}

export interface AiTargetHealth {
  readonly status: "healthy" | "degraded" | "unhealthy" | "unknown";
  readonly checkedAt?: string;
}

/** Safe to expose to a browser after the application has authorized listing. */
export interface AiPublicTargetDescriptor {
  readonly schema: typeof AI_PUBLIC_TARGET_SCHEMA;
  readonly targetId: string;
  readonly revision: string;
  readonly displayName: string;
  readonly operations: readonly AiExecutionOperationKind[];
  readonly capabilities: readonly string[];
  readonly placement: AiTargetPlacement;
  readonly executionStyle: AiExecutionStyle;
  readonly locality?: "local" | "private-network" | "remote";
  readonly health: AiTargetHealth;
}

/** Private immutable execution-time target projection retained in receipts. */
export interface AiResolvedTargetSnapshot {
  readonly schema: typeof AI_RESOLVED_TARGET_SCHEMA;
  readonly targetId: string;
  readonly targetRevision: string;
  readonly policyRevision: string;
  readonly operation: AiExecutionOperationKind;
  readonly placement: AiTargetPlacement;
  readonly executionStyle: AiExecutionStyle;
  readonly routeCandidateId: string;
  readonly backend: ProviderExecutionBackend;
  readonly authMode?: ProviderAuthenticationMode;
  readonly provider?: string;
  readonly model?: string;
  readonly profileRef?: string;
  readonly workerRef?: string;
  readonly resolvedAt: string;
  readonly snapshotDigest: `sha256:${string}`;
}

/** Canonical model identity pinned independently from a provider's display id. */
export interface AiModelIdentity {
  readonly modelRef: string;
  readonly revision: string;
  readonly providerModelId?: string;
  readonly catalogDigest: `sha256:${string}`;
}

/**
 * Immutable route offer as admitted for one attempt. The digest covers every
 * field except itself; a mutable catalog row or provider/model string is never
 * accepted as execution-time identity.
 */
export interface AiExecutionOfferSnapshot {
  readonly schema: typeof AI_EXECUTION_OFFER_SCHEMA;
  readonly offerId: string;
  readonly offerRevision: string;
  readonly model: AiModelIdentity;
  readonly provider: string;
  readonly backend: ProviderExecutionBackend;
  readonly authMode?: ProviderAuthenticationMode;
  readonly agentHost?: string;
  readonly profileRef?: string;
  readonly locality: "local" | "remote";
  readonly privacyClass: "device" | "private-network" | "provider" | "public";
  readonly capabilities: readonly string[];
  readonly cacheBehavior: "none" | "provider" | "host" | "unknown";
  readonly sessionBehavior: "stateless" | "stateful" | "unknown";
  readonly tariffRef?: string;
  readonly quotaPolicyRef?: string;
  readonly health: AiTargetHealth;
  readonly effectiveAt: string;
  readonly expiresAt?: string;
  readonly catalogDigest: `sha256:${string}`;
  readonly snapshotDigest: `sha256:${string}`;
}

export interface AiRouteDecisionBinding {
  readonly decisionId: string;
  readonly policyId: string;
  readonly selectedCandidateId: string;
  readonly decisionDigest: `sha256:${string}`;
}

export interface AiPromptExecutionBinding {
  readonly blueprintRef: string;
  readonly blueprintRevision: string;
  readonly blueprintDigest: `sha256:${string}`;
  readonly renderedPayloadDigest: `sha256:${string}`;
}

export type AiPersonaExecutionBinding =
  | { readonly status: "none" }
  | {
      readonly status: "bound";
      readonly personaId: string;
      readonly revision: string;
      readonly digest: `sha256:${string}`;
    };

/** Complete immutable identity of what one execution attempt actually ran. */
export interface AiExecutionBinding {
  readonly schema: typeof AI_EXECUTION_BINDING_SCHEMA;
  readonly routeDecision: AiRouteDecisionBinding;
  readonly offer: AiExecutionOfferSnapshot;
  readonly target: AiResolvedTargetSnapshot;
  readonly prompt: AiPromptExecutionBinding;
  readonly persona: AiPersonaExecutionBinding;
  readonly model: AiModelIdentity;
  readonly bindingDigest: `sha256:${string}`;
}
