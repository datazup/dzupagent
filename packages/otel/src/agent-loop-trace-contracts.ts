import type { OTelContext, OTelSpan } from "./otel-types.js";
import { SpanKind, SpanStatusCode } from "./otel-types.js";

export const AGENT_LOOP_TRACE_EVENT_SCHEMA =
  "dzupagent.agentLoopTraceEvent/v1" as const;
export const AGENT_LOOP_SPAN_PROJECTION_SCHEMA =
  "dzupagent.agentLoopSpanProjection/v1" as const;

export const AGENT_LOOP_TRACE_EVENTS = [
  "run.started",
  "run.completed",
  "run.stopped",
  "task.started",
  "task.completed",
  "implementation.started",
  "implementation.completed",
  "review.started",
  "review.completed",
  "semantic_judge.started",
  "semantic_judge.completed",
  "next_path_approval.started",
  "next_path_approval.completed",
  "terminal_approval.started",
  "terminal_approval.completed",
  "validation.completed",
] as const;

export type AgentLoopTraceEventName =
  (typeof AGENT_LOOP_TRACE_EVENTS)[number];

export type AgentLoopTraceRole =
  | "implementer"
  | "reviewer"
  | "semantic-judge"
  | "next-path-approver"
  | "terminal-approver"
  | "manager";

export type AgentLoopTraceStatus =
  | "started"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "exhausted"
  | "ambiguous";

export type AgentLoopTraceDecision =
  | "continue"
  | "complete"
  | "blocked"
  | "revise"
  | "approve"
  | "reject"
  | "ambiguous";

export interface AgentLoopTraceIdentity {
  readonly runId: string;
  readonly correlationId: string;
  readonly taskId?: string;
  readonly dispatchId?: string;
  readonly attemptId?: string;
  readonly reviewId?: string;
  readonly generation?: number;
}

export interface AgentLoopTraceSource {
  readonly commit?: string;
  readonly tree?: string;
  readonly buildArtifactSha256?: `sha256:${string}`;
  readonly compilerSemanticHash?: `sha256:${string}`;
  readonly dslVersion?: string;
  readonly schemaRegistryHash?: `sha256:${string}`;
  readonly primitiveRegistryHash?: `sha256:${string}`;
  readonly compositionHash?: `sha256:${string}`;
  readonly migrationQualificationHash?: `sha256:${string}`;
}

export interface AgentLoopTraceUsage {
  readonly promptBytes?: number;
  readonly contextBytes?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly costCents?: number;
  readonly latencyMs?: number;
}

export interface AgentLoopTraceEvent {
  readonly schema: typeof AGENT_LOOP_TRACE_EVENT_SCHEMA;
  readonly event: AgentLoopTraceEventName;
  readonly observedAt: string;
  readonly identity: AgentLoopTraceIdentity;
  readonly status: AgentLoopTraceStatus;
  readonly role?: AgentLoopTraceRole;
  readonly decision?: AgentLoopTraceDecision;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly providerRouteId?: string;
  readonly stopClassification?: string;
  readonly source?: AgentLoopTraceSource;
  readonly usage?: AgentLoopTraceUsage;
}

export const AgentLoopSpanAttr = {
  EVENT: "forge.agent_loop.event",
  OBSERVED_AT: "forge.agent_loop.observed_at",
  CORRELATION_ID: "forge.agent_loop.correlation_id",
  TASK_ID: "forge.agent_loop.task_id",
  DISPATCH_ID: "forge.agent_loop.dispatch_id",
  ATTEMPT_ID: "forge.agent_loop.attempt_id",
  REVIEW_ID: "forge.agent_loop.review_id",
  GENERATION: "forge.agent_loop.generation",
  ROLE: "forge.agent_loop.role",
  STATUS: "forge.agent_loop.status",
  DECISION: "forge.agent_loop.decision",
  STOP_CLASSIFICATION: "forge.agent_loop.stop_classification",
  PROVIDER_ROUTE_ID: "forge.agent_loop.provider_route_id",
  SOURCE_COMMIT: "forge.agent_loop.source.commit",
  SOURCE_TREE: "forge.agent_loop.source.tree",
  BUILD_ARTIFACT_SHA256: "forge.agent_loop.source.build_artifact_sha256",
  COMPILER_SEMANTIC_HASH:
    "forge.agent_loop.source.compiler_semantic_hash",
  DSL_VERSION: "forge.agent_loop.dsl.version",
  SCHEMA_REGISTRY_HASH: "forge.agent_loop.dsl.schema_registry_hash",
  PRIMITIVE_REGISTRY_HASH:
    "forge.agent_loop.dsl.primitive_registry_hash",
  COMPOSITION_HASH: "forge.agent_loop.dsl.composition_hash",
  MIGRATION_QUALIFICATION_HASH:
    "forge.agent_loop.dsl.migration_qualification_hash",
  PROMPT_BYTES: "forge.agent_loop.prompt_bytes",
  CONTEXT_BYTES: "forge.agent_loop.context_bytes",
  REASONING_TOKENS: "forge.agent_loop.reasoning_tokens",
  LATENCY_MS: "forge.agent_loop.latency_ms",
  ACCEPTANCE_AUTHORITY: "forge.agent_loop.authority.acceptance",
  CONTINUATION_AUTHORITY: "forge.agent_loop.authority.continuation",
  EXECUTION_AUTHORITY: "forge.agent_loop.authority.execution",
  MUTATION_AUTHORITY: "forge.agent_loop.authority.mutation",
  DEPLOYMENT_AUTHORITY: "forge.agent_loop.authority.deployment",
  PROMOTION_AUTHORITY: "forge.agent_loop.authority.promotion",
  PRODUCTION_AUTHORITY: "forge.agent_loop.authority.production",
} as const;

export interface AgentLoopAuthorityBoundary {
  readonly acceptanceAuthority: false;
  readonly continuationAuthority: false;
  readonly executionAuthority: false;
  readonly mutationAuthority: false;
  readonly deploymentAuthority: false;
  readonly promotionAuthority: false;
  readonly productionAuthority: false;
}

export interface AgentLoopSpanProjection {
  readonly schema: typeof AGENT_LOOP_SPAN_PROJECTION_SCHEMA;
  readonly spanName: string;
  readonly eventName: AgentLoopTraceEventName;
  readonly kind: typeof SpanKind.INTERNAL;
  readonly status: {
    readonly code:
      | typeof SpanStatusCode.UNSET
      | typeof SpanStatusCode.OK
      | typeof SpanStatusCode.ERROR;
    readonly message?: string;
  };
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly authority: AgentLoopAuthorityBoundary;
}

export interface RecordAgentLoopTraceOptions {
  readonly parentContext?: OTelContext;
  readonly onError?: (error: Error) => void;
}

export type RecordAgentLoopTraceResult =
  | {
      readonly recorded: true;
      readonly projection: AgentLoopSpanProjection;
      readonly span: OTelSpan;
    }
  | {
      readonly recorded: false;
      readonly error: Error;
    };
