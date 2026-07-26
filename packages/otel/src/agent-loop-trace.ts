import type {
  OTelSpan,
  OTelTracer,
} from "./otel-types.js";
import {
  SpanKind,
  SpanStatusCode,
} from "./otel-types.js";
import { ForgeSpanAttr } from "./span-attributes.js";
import {
  AGENT_LOOP_SPAN_PROJECTION_SCHEMA,
  AGENT_LOOP_TRACE_EVENT_SCHEMA,
  AGENT_LOOP_TRACE_EVENTS,
  AgentLoopSpanAttr,
  type AgentLoopAuthorityBoundary,
  type AgentLoopSpanProjection,
  type AgentLoopTraceEvent,
  type AgentLoopTraceEventName,
  type AgentLoopTraceSource,
  type AgentLoopTraceUsage,
  type RecordAgentLoopTraceOptions,
  type RecordAgentLoopTraceResult,
} from "./agent-loop-trace-contracts.js";

const EVENT_NAMES = new Set<string>(AGENT_LOOP_TRACE_EVENTS);
const STATUSES = new Set<string>([
  "started",
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "exhausted",
  "ambiguous",
]);
const ROLES = new Set<string>([
  "implementer",
  "reviewer",
  "semantic-judge",
  "next-path-approver",
  "terminal-approver",
  "manager",
]);
const DECISIONS = new Set<string>([
  "continue",
  "complete",
  "blocked",
  "revise",
  "approve",
  "reject",
  "ambiguous",
]);
const START_EVENTS = new Set<AgentLoopTraceEventName>([
  "run.started",
  "task.started",
  "implementation.started",
  "review.started",
  "semantic_judge.started",
  "next_path_approval.started",
  "terminal_approval.started",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/u;
// False positive: matches a 40-hex SHA-1 or 64-hex SHA-256 git object id.
// Anchored at both ends, fixed-length quantifiers only ({40} then optional
// {24}), and no nested unbounded quantifier, so catastrophic backtracking is
// impossible. Measured on adversarial all-hex non-matching input: 100,000
// chars in 0.22ms and 1,000,000 chars in 1.84ms — linear, not exponential.
// eslint-disable-next-line security/detect-unsafe-regex
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

const AUTHORITY_BOUNDARY: AgentLoopAuthorityBoundary = Object.freeze({
  acceptanceAuthority: false,
  continuationAuthority: false,
  executionAuthority: false,
  mutationAuthority: false,
  deploymentAuthority: false,
  promotionAuthority: false,
  productionAuthority: false,
});

const SPAN_NAMES: Record<AgentLoopTraceEventName, string> = {
  "run.started": "agent_loop.run",
  "run.completed": "agent_loop.run",
  "run.stopped": "agent_loop.run",
  "task.started": "agent_loop.task",
  "task.completed": "agent_loop.task",
  "implementation.started": "agent_loop.implementation",
  "implementation.completed": "agent_loop.implementation",
  "review.started": "agent_loop.review",
  "review.completed": "agent_loop.review",
  "semantic_judge.started": "agent_loop.semantic_judge",
  "semantic_judge.completed": "agent_loop.semantic_judge",
  "next_path_approval.started": "agent_loop.next_path_approval",
  "next_path_approval.completed": "agent_loop.next_path_approval",
  "terminal_approval.started": "agent_loop.terminal_approval",
  "terminal_approval.completed": "agent_loop.terminal_approval",
  "validation.completed": "agent_loop.validation",
};

export function projectAgentLoopTraceEvent(
  input: AgentLoopTraceEvent,
): AgentLoopSpanProjection {
  validateEvent(input);
  const attributes: Record<string, string | number | boolean> = {
    [ForgeSpanAttr.RUN_ID]: input.identity.runId,
    [AgentLoopSpanAttr.EVENT]: input.event,
    [AgentLoopSpanAttr.OBSERVED_AT]: input.observedAt,
    [AgentLoopSpanAttr.CORRELATION_ID]: input.identity.correlationId,
    [AgentLoopSpanAttr.STATUS]: input.status,
    [AgentLoopSpanAttr.ACCEPTANCE_AUTHORITY]: false,
    [AgentLoopSpanAttr.CONTINUATION_AUTHORITY]: false,
    [AgentLoopSpanAttr.EXECUTION_AUTHORITY]: false,
    [AgentLoopSpanAttr.MUTATION_AUTHORITY]: false,
    [AgentLoopSpanAttr.DEPLOYMENT_AUTHORITY]: false,
    [AgentLoopSpanAttr.PROMOTION_AUTHORITY]: false,
    [AgentLoopSpanAttr.PRODUCTION_AUTHORITY]: false,
  };

  assignOptional(attributes, AgentLoopSpanAttr.TASK_ID, input.identity.taskId);
  assignOptional(
    attributes,
    AgentLoopSpanAttr.DISPATCH_ID,
    input.identity.dispatchId,
  );
  assignOptional(
    attributes,
    AgentLoopSpanAttr.ATTEMPT_ID,
    input.identity.attemptId,
  );
  assignOptional(
    attributes,
    AgentLoopSpanAttr.REVIEW_ID,
    input.identity.reviewId,
  );
  assignOptional(
    attributes,
    AgentLoopSpanAttr.GENERATION,
    input.identity.generation,
  );
  assignOptional(attributes, AgentLoopSpanAttr.ROLE, input.role);
  assignOptional(attributes, AgentLoopSpanAttr.DECISION, input.decision);
  assignOptional(
    attributes,
    AgentLoopSpanAttr.STOP_CLASSIFICATION,
    input.stopClassification,
  );
  assignOptional(
    attributes,
    AgentLoopSpanAttr.PROVIDER_ROUTE_ID,
    input.providerRouteId,
  );
  assignOptional(
    attributes,
    ForgeSpanAttr.GEN_AI_PROVIDER_NAME,
    input.providerId,
  );
  assignOptional(
    attributes,
    ForgeSpanAttr.GEN_AI_REQUEST_MODEL,
    input.modelId,
  );
  projectSource(attributes, input.source);
  projectUsage(attributes, input.usage);

  return {
    schema: AGENT_LOOP_SPAN_PROJECTION_SCHEMA,
    spanName: SPAN_NAMES[input.event],
    eventName: input.event,
    kind: SpanKind.INTERNAL,
    status: projectStatus(input),
    attributes,
    authority: AUTHORITY_BOUNDARY,
  };
}

export function recordAgentLoopTraceEvent(
  tracer: OTelTracer,
  event: AgentLoopTraceEvent,
  options: RecordAgentLoopTraceOptions = {},
): RecordAgentLoopTraceResult {
  let span: OTelSpan | undefined;
  try {
    const projection = projectAgentLoopTraceEvent(event);
    span = tracer.startSpan(
      projection.spanName,
      {
        attributes: { ...projection.attributes },
        kind: projection.kind,
      },
      options.parentContext,
    );
    span.addEvent(projection.eventName, {
      [AgentLoopSpanAttr.EVENT]: projection.eventName,
      [AgentLoopSpanAttr.STATUS]: event.status,
    });
    span.setStatus(projection.status);
    span.end();
    return { recorded: true, projection, span };
  } catch (value) {
    try {
      span?.end();
    } catch {
      // A broken exporter/span must not change controller behavior.
    }
    const error = value instanceof Error ? value : new Error(String(value));
    try {
      options.onError?.(error);
    } catch {
      // Telemetry error reporting must not change controller behavior.
    }
    return { recorded: false, error };
  }
}

function validateEvent(input: AgentLoopTraceEvent): void {
  if (input?.schema !== AGENT_LOOP_TRACE_EVENT_SCHEMA)
    throw new Error("Agent Loop trace event schema is invalid");
  if (!EVENT_NAMES.has(input.event))
    throw new Error("Agent Loop trace event name is invalid");
  canonicalTimestamp(input.observedAt);
  identifier(input.identity?.runId, "runId");
  identifier(input.identity?.correlationId, "correlationId");
  optionalIdentifier(input.identity?.taskId, "taskId");
  optionalIdentifier(input.identity?.dispatchId, "dispatchId");
  optionalIdentifier(input.identity?.attemptId, "attemptId");
  optionalIdentifier(input.identity?.reviewId, "reviewId");
  optionalInteger(input.identity?.generation, "generation");
  optionalMember(input.status, STATUSES, "status");
  optionalMember(input.role, ROLES, "role");
  optionalMember(input.decision, DECISIONS, "decision");
  optionalIdentifier(input.providerId, "providerId");
  optionalIdentifier(input.modelId, "modelId");
  optionalIdentifier(input.providerRouteId, "providerRouteId");
  optionalIdentifier(input.stopClassification, "stopClassification");
  if (START_EVENTS.has(input.event) !== (input.status === "started"))
    throw new Error("Agent Loop trace event lifecycle status is inconsistent");
  if (!input.event.startsWith("run.") && !input.identity.taskId)
    throw new Error("Agent Loop task-scoped trace event requires taskId");
  if (
    (input.event.includes("review") ||
      input.event.includes("approval") ||
      input.event.includes("judge")) &&
    !input.identity.reviewId
  )
    throw new Error("Agent Loop review trace event requires reviewId");
  validateSource(input.source);
  validateUsage(input.usage);
}

function validateSource(source?: AgentLoopTraceSource): void {
  if (!source) return;
  for (const [field, value] of [
    ["commit", source.commit],
    ["tree", source.tree],
  ] as const) {
    if (value !== undefined && !GIT_OBJECT_ID.test(value))
      throw new Error(`Agent Loop source ${field} is invalid`);
  }
  for (const [field, value] of [
    ["buildArtifactSha256", source.buildArtifactSha256],
    ["compilerSemanticHash", source.compilerSemanticHash],
    ["schemaRegistryHash", source.schemaRegistryHash],
    ["primitiveRegistryHash", source.primitiveRegistryHash],
    ["compositionHash", source.compositionHash],
    ["migrationQualificationHash", source.migrationQualificationHash],
  ] as const) {
    if (value !== undefined && !SHA256.test(value))
      throw new Error(`Agent Loop source ${field} is invalid`);
  }
  optionalIdentifier(source.dslVersion, "dslVersion");
}

function validateUsage(usage?: AgentLoopTraceUsage): void {
  if (!usage) return;
  for (const [field, value] of Object.entries(usage))
    optionalNonNegativeNumber(value, field);
}

function projectSource(
  attributes: Record<string, string | number | boolean>,
  source?: AgentLoopTraceSource,
): void {
  if (!source) return;
  assignOptional(attributes, AgentLoopSpanAttr.SOURCE_COMMIT, source.commit);
  assignOptional(attributes, AgentLoopSpanAttr.SOURCE_TREE, source.tree);
  assignOptional(
    attributes,
    AgentLoopSpanAttr.BUILD_ARTIFACT_SHA256,
    source.buildArtifactSha256,
  );
  assignOptional(
    attributes,
    AgentLoopSpanAttr.COMPILER_SEMANTIC_HASH,
    source.compilerSemanticHash,
  );
  assignOptional(attributes, AgentLoopSpanAttr.DSL_VERSION, source.dslVersion);
  assignOptional(
    attributes,
    AgentLoopSpanAttr.SCHEMA_REGISTRY_HASH,
    source.schemaRegistryHash,
  );
  assignOptional(
    attributes,
    AgentLoopSpanAttr.PRIMITIVE_REGISTRY_HASH,
    source.primitiveRegistryHash,
  );
  assignOptional(
    attributes,
    AgentLoopSpanAttr.COMPOSITION_HASH,
    source.compositionHash,
  );
  assignOptional(
    attributes,
    AgentLoopSpanAttr.MIGRATION_QUALIFICATION_HASH,
    source.migrationQualificationHash,
  );
}

function projectUsage(
  attributes: Record<string, string | number | boolean>,
  usage?: AgentLoopTraceUsage,
): void {
  if (!usage) return;
  assignOptional(
    attributes,
    AgentLoopSpanAttr.PROMPT_BYTES,
    usage.promptBytes,
  );
  assignOptional(
    attributes,
    AgentLoopSpanAttr.CONTEXT_BYTES,
    usage.contextBytes,
  );
  assignOptional(
    attributes,
    ForgeSpanAttr.GEN_AI_USAGE_INPUT_TOKENS,
    usage.inputTokens,
  );
  assignOptional(
    attributes,
    ForgeSpanAttr.GEN_AI_USAGE_OUTPUT_TOKENS,
    usage.outputTokens,
  );
  assignOptional(
    attributes,
    AgentLoopSpanAttr.REASONING_TOKENS,
    usage.reasoningTokens,
  );
  assignOptional(attributes, ForgeSpanAttr.COST_CENTS, usage.costCents);
  assignOptional(attributes, AgentLoopSpanAttr.LATENCY_MS, usage.latencyMs);
}

function projectStatus(
  input: AgentLoopTraceEvent,
): AgentLoopSpanProjection["status"] {
  if (input.status === "started" || input.status === "ambiguous")
    return { code: SpanStatusCode.UNSET };
  if (input.status === "completed")
    return { code: SpanStatusCode.OK };
  return {
    code: SpanStatusCode.ERROR,
    message: input.stopClassification ?? input.status,
  };
}

function assignOptional(
  target: Record<string, string | number | boolean>,
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    throw new Error(`Agent Loop ${label} is invalid`);
}

function optionalIdentifier(value: unknown, label: string): void {
  if (value !== undefined) identifier(value, label);
}

function optionalMember(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || !allowed.has(value))
  )
    throw new Error(`Agent Loop ${label} is invalid`);
}

function optionalInteger(value: unknown, label: string): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || Number(value) < 0)
  )
    throw new Error(`Agent Loop ${label} is invalid`);
}

function optionalNonNegativeNumber(value: unknown, label: string): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0)
  )
    throw new Error(`Agent Loop ${label} is invalid`);
}

function canonicalTimestamp(value: unknown): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("Agent Loop observedAt must be a canonical timestamp");
}
