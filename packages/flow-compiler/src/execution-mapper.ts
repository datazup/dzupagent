import type {
  AdapterRunNode,
  AgentNode,
  FlowNode,
  PromptNode,
  WorkerDispatchNode,
} from "@dzupagent/flow-ast";
import type {
  AdapterRunExecutionRequest,
  AgentExecutionRequest,
  ExecutionEvidenceRequirement,
  ExecutionPolicy,
  ExecutionRequest,
  ExecutionRouteCandidate,
  ExecutionRouteConstraint,
  ExecutionRoutePolicy,
  ExecutionToolPolicy,
  PromptExecutionRequest,
  WorkerDispatchExecutionRequest,
} from "@dzupagent/runtime-contracts";

export type ExecutionMapperDiagnosticCode =
  | "UNSUPPORTED_EXECUTION_NODE"
  | "MISSING_NODE_ID"
  | "MISSING_REQUEST_ID"
  | "MISSING_CORRELATION_ID"
  | "INVALID_ATTEMPT"
  | "ROUTE_CANDIDATES_REQUIRED"
  | "NO_ELIGIBLE_ROUTE_CANDIDATES"
  | "DUPLICATE_ROUTE_CANDIDATE"
  | "AMBIGUOUS_OUTPUT_SCHEMA"
  | "INVALID_RESULT_SCHEMA";

export interface ExecutionMapperDiagnostic {
  readonly code: ExecutionMapperDiagnosticCode;
  readonly nodePath: string;
  readonly message: string;
}

export interface ExecutionMapperContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly attempt?: number;
  readonly flowId?: string;
  readonly nodePath: string;
  readonly profileRef?: string;
  readonly capability?: string;
  /** Materialized host candidates. Required when the node does not pin a provider. */
  readonly routeCandidates?: readonly ExecutionRouteCandidate[];
  /** Resolved persona/system layer. Used only for prompt nodes; explicit systemPrompt wins. */
  readonly resolvedPromptSystemLayer?: string;
  readonly maxSelectionLatencyMs?: number;
}

export type ExecutionRequestMapResult =
  | { readonly ok: true; readonly request: ExecutionRequest; readonly diagnostics: readonly [] }
  | { readonly ok: false; readonly diagnostics: readonly ExecutionMapperDiagnostic[] };

type SupportedLeaf = PromptNode | AgentNode | AdapterRunNode | WorkerDispatchNode;

export function mapFlowLeafToExecutionRequest(
  node: FlowNode,
  context: ExecutionMapperContext,
): ExecutionRequestMapResult {
  const diagnostics = validateContext(node, context);
  if (!isSupportedLeaf(node)) {
    diagnostics.push(
      diagnostic(
        "UNSUPPORTED_EXECUTION_NODE",
        context.nodePath,
        `Execution mapping is not defined for ${node.type}.`,
      ),
    );
    return { ok: false, diagnostics };
  }

  if (node.type === "agent" && node.output.schemaRef && node.output.schema) {
    diagnostics.push(
      diagnostic(
        "AMBIGUOUS_OUTPUT_SCHEMA",
        context.nodePath,
        "Agent output cannot declare both schemaRef and inline schema.",
      ),
    );
  }
  if (node.type === "worker.dispatch" && node.resultSchema && node.resultFormat !== "json") {
    diagnostics.push(
      diagnostic(
        "INVALID_RESULT_SCHEMA",
        context.nodePath,
        "worker.dispatch resultSchema requires resultFormat: json.",
      ),
    );
  }

  const route = buildRoutePolicy(node, context, diagnostics);
  if (diagnostics.length > 0 || !node.id || !route) {
    return { ok: false, diagnostics };
  }

  const base = {
    schema: "dzupagent.executionRequest/v1" as const,
    requestId: context.requestId,
    correlationId: context.correlationId,
    attempt: context.attempt ?? 1,
    source: {
      ...(context.flowId ? { flowId: context.flowId } : {}),
      nodeId: node.id,
      nodePath: context.nodePath,
      ...(context.profileRef ? { profileRef: context.profileRef } : {}),
      ...(context.capability ? { capability: context.capability } : {}),
    },
    route,
    effects: {
      ...(node.effectClass ? { effectClass: node.effectClass } : {}),
      ...(node.idempotency ? { idempotency: node.idempotency } : {}),
    },
    evidenceRequirements: evidenceRequirements(node),
  };

  let request: ExecutionRequest;
  switch (node.type) {
    case "prompt":
      request = mapPrompt(node, context, base);
      break;
    case "agent":
      request = mapAgent(node, base);
      break;
    case "adapter.run":
      request = mapAdapterRun(node, base);
      break;
    case "worker.dispatch":
      request = mapWorkerDispatch(node, base);
      break;
  }
  return { ok: true, request, diagnostics: [] };
}

function mapPrompt(
  node: PromptNode,
  context: ExecutionMapperContext,
  base: CommonMappedFields,
): PromptExecutionRequest {
  const system = node.systemPrompt ?? context.resolvedPromptSystemLayer;
  return {
    ...base,
    kind: "prompt",
    prompt: {
      layers: [
        ...(system ? [{ kind: "system" as const, content: system }] : []),
        { kind: "task", content: node.userPrompt },
      ],
      bindings: {},
    },
    tools: node.tools
      ? { mode: "host-default", grants: [] }
      : { mode: "none", grants: [] },
    output: { key: node.outputKey ?? node.id ?? "promptResult", format: "text" },
    policy: {},
  };
}

function mapAgent(node: AgentNode, base: CommonMappedFields): AgentExecutionRequest {
  return {
    ...base,
    kind: "agent",
    identity: {
      agentId: node.agentId,
      ...(node.template?.ref ? { templateRef: node.template.ref } : {}),
    },
    prompt: {
      layers: [{ kind: "instructions", content: node.instructions }],
      bindings: node.input ?? {},
    },
    tools: explicitTools(node.tools),
    output: {
      key: node.output.key,
      format: "json",
      ...(node.output.schemaRef ? { schemaRef: node.output.schemaRef } : {}),
      ...(node.output.schema ? { schema: node.output.schema } : {}),
    },
    policy: {
      ...(node.policy?.timeoutMs !== undefined ? { timeoutMs: node.policy.timeoutMs } : {}),
      ...(node.policy?.budgetCents !== undefined ? { budgetCents: node.policy.budgetCents } : {}),
      ...(node.stop?.maxIterations !== undefined ? { maxIterations: node.stop.maxIterations } : {}),
      ...(node.stop?.maxToolCalls ?? node.policy?.maxToolCalls) !== undefined
        ? { maxToolCalls: node.stop?.maxToolCalls ?? node.policy?.maxToolCalls }
        : {},
      ...(node.policy?.workingDirectory ? { workingDirectory: node.policy.workingDirectory } : {}),
      ...(node.policy?.approval?.requiredFor
        ? { approvalRequiredFor: node.policy.approval.requiredFor }
        : {}),
      ...(node.validation?.required
        ? { validationCommands: node.validation.required.map((item) => item.command) }
        : {}),
    },
  };
}

function mapAdapterRun(
  node: AdapterRunNode,
  base: CommonMappedFields,
): AdapterRunExecutionRequest {
  const outputSchema = node.outputSchema;
  return {
    ...base,
    kind: "adapter.run",
    adapter: {
      ...(node.persona ? { personaRef: node.persona } : {}),
      ...(node.reasoning ? { reasoning: node.reasoning } : {}),
      promptPreparation: node.promptPrep ?? "auto",
    },
    prompt: {
      layers: [
        ...(node.systemPrompt ? [{ kind: "system" as const, content: node.systemPrompt }] : []),
        ...(node.persona ? [{ kind: "persona" as const, ref: node.persona }] : []),
        { kind: "instructions", content: node.instructions },
      ],
      bindings: node.input ?? {},
    },
    tools: { mode: "none", grants: [] },
    output: {
      key: node.output,
      format: outputSchema ? "json" : "unknown",
      ...(typeof outputSchema === "string" ? { schemaRef: outputSchema } : {}),
      ...(outputSchema && typeof outputSchema === "object" ? { schema: outputSchema } : {}),
    },
    policy: {
      ...(node.policy ? { extensions: node.policy } : {}),
    },
  };
}

function mapWorkerDispatch(
  node: WorkerDispatchNode,
  base: CommonMappedFields,
): WorkerDispatchExecutionRequest {
  const commandSurface = node.commandSurface ?? "none";
  return {
    ...base,
    kind: "worker.dispatch",
    worker: { dispatchId: node.dispatchId },
    prompt: {
      layers: [
        ...(node.systemPrompt ? [{ kind: "system" as const, content: node.systemPrompt }] : []),
        { kind: "instructions", content: node.instructions },
      ],
      bindings: node.input ?? {},
    },
    tools:
      commandSurface === "code"
        ? {
            mode: "explicit",
            grants: [{ toolRef: "worker.command", operations: node.commandAllowlist ?? [] }],
          }
        : { mode: "none", grants: [] },
    output: {
      key: node.outputKey,
      format: node.resultFormat ?? "text",
      ...(node.resultSchema ? { schemaRef: node.resultSchema } : {}),
    },
    policy: {
      commandSurface,
      ...(node.validationCommand ? { validationCommands: [node.validationCommand] } : {}),
    },
  };
}

interface CommonMappedFields {
  readonly schema: "dzupagent.executionRequest/v1";
  readonly requestId: string;
  readonly correlationId: string;
  readonly attempt: number;
  readonly source: {
    readonly flowId?: string;
    readonly nodeId: string;
    readonly nodePath: string;
    readonly profileRef?: string;
    readonly capability?: string;
  };
  readonly route: ExecutionRoutePolicy;
  readonly effects: {
    readonly effectClass?: string;
    readonly idempotency?: "idempotent" | "at-least-once" | "exactly-once-required";
  };
  readonly evidenceRequirements: readonly ExecutionEvidenceRequirement[];
}

function buildRoutePolicy(
  node: SupportedLeaf,
  context: ExecutionMapperContext,
  diagnostics: ExecutionMapperDiagnostic[],
): ExecutionRoutePolicy | null {
  const provider = node.provider;
  const model = node.model;
  const constraints: ExecutionRouteConstraint[] = [];
  let candidates: ExecutionRouteCandidate[];

  if (provider) {
    constraints.push({ kind: "provider", values: [provider] });
    candidates = [{ id: model ? `${provider}:${model}` : provider, provider, ...(model ? { model } : {}) }];
  } else {
    candidates = [...(context.routeCandidates ?? [])];
    if (node.type === "adapter.run" && node.tags?.length) {
      constraints.push({ kind: "tags", values: node.tags });
      candidates = candidates.filter((candidate) =>
        node.tags?.every((tag) => candidate.tags?.includes(tag)),
      );
    }
    if (!context.routeCandidates) {
      diagnostics.push(
        diagnostic(
          "ROUTE_CANDIDATES_REQUIRED",
          context.nodePath,
          `${node.type} must pin a provider or receive materialized host route candidates.`,
        ),
      );
    } else if (candidates.length === 0) {
      diagnostics.push(
        diagnostic(
          "NO_ELIGIBLE_ROUTE_CANDIDATES",
          context.nodePath,
          "No materialized route candidate satisfies the node constraints.",
        ),
      );
    }
  }

  const seen = new Set<string>();
  candidates.forEach((candidate) => {
    if (seen.has(candidate.id)) {
      diagnostics.push(
        diagnostic(
          "DUPLICATE_ROUTE_CANDIDATE",
          context.nodePath,
          `Duplicate materialized route candidate: ${candidate.id}`,
        ),
      );
    }
    seen.add(candidate.id);
  });
  if (diagnostics.length > 0) return null;

  return {
    id: `${context.requestId}:route`,
    requestId: context.requestId,
    strategy: provider ? "fixed" : "rule",
    candidates,
    hardConstraints: constraints,
    preferenceOrder: model ? [model] : [],
    fallback: candidates.length > 1 ? "ordered-compatible" : "none",
    maxSelectionLatencyMs: context.maxSelectionLatencyMs ?? 1_500,
  };
}

function explicitTools(tools: readonly string[] | undefined): ExecutionToolPolicy {
  if (!tools?.length) return { mode: "none", grants: [] };
  return {
    mode: "explicit",
    grants: tools.map((toolRef) => ({ toolRef })),
  };
}

function evidenceRequirements(node: SupportedLeaf): ExecutionEvidenceRequirement[] {
  return node.meta?.evidence === undefined
    ? []
    : [{ kind: "declared", declaration: node.meta.evidence }];
}

function validateContext(
  node: FlowNode,
  context: ExecutionMapperContext,
): ExecutionMapperDiagnostic[] {
  const diagnostics: ExecutionMapperDiagnostic[] = [];
  if (!node.id) diagnostics.push(diagnostic("MISSING_NODE_ID", context.nodePath, "Canonical execution mapping requires node.id."));
  if (!context.requestId) diagnostics.push(diagnostic("MISSING_REQUEST_ID", context.nodePath, "requestId is required."));
  if (!context.correlationId) diagnostics.push(diagnostic("MISSING_CORRELATION_ID", context.nodePath, "correlationId is required."));
  if ((context.attempt ?? 1) < 1 || !Number.isInteger(context.attempt ?? 1)) {
    diagnostics.push(diagnostic("INVALID_ATTEMPT", context.nodePath, "attempt must be a positive integer."));
  }
  return diagnostics;
}

function isSupportedLeaf(node: FlowNode): node is SupportedLeaf {
  return node.type === "prompt" || node.type === "agent" || node.type === "adapter.run" || node.type === "worker.dispatch";
}

function diagnostic(
  code: ExecutionMapperDiagnosticCode,
  nodePath: string,
  message: string,
): ExecutionMapperDiagnostic {
  return { code, nodePath, message };
}
