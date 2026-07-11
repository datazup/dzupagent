import type {
  AgentNode,
  ApprovalNode,
  ClarificationNode,
  FlowNode,
  ValidateNode,
} from "@dzupagent/flow-ast";
import type {
  ExecutionEvidenceRequirement,
  GateCheck,
  GateRepairPolicy,
  GateRequest,
  GateSubject,
} from "@dzupagent/runtime-contracts";

export type GateMapperDiagnosticCode =
  | "UNSUPPORTED_GATE_NODE"
  | "MISSING_GATE_NODE_ID"
  | "MISSING_GATE_REQUEST_ID"
  | "MISSING_GATE_CORRELATION_ID"
  | "MISSING_BRANCH_NODE_ID"
  | "INVALID_CLARIFICATION_CHOICES"
  | "AMBIGUOUS_VALIDATION_DECLARATION"
  | "MISSING_VALIDATION_DECLARATION"
  | "AMBIGUOUS_AGENT_OUTPUT_SCHEMA"
  | "MISSING_AGENT_OUTPUT_SCHEMA";

export interface GateMapperDiagnostic {
  readonly code: GateMapperDiagnosticCode;
  readonly nodePath: string;
  readonly message: string;
}

export interface GateMapperContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly flowId?: string;
  readonly nodePath: string;
  readonly profileRef?: string;
  readonly capability?: string;
  readonly policyRef?: string;
  readonly requiredActor?: {
    readonly actorId?: string;
    readonly role?: string;
  };
  readonly deadlineAt?: string;
  readonly subject?: GateSubject;
}

export type GateRequestMapResult =
  | {
      readonly ok: true;
      readonly requests: readonly GateRequest[];
      readonly diagnostics: readonly [];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly GateMapperDiagnostic[];
    };

type SupportedGateNode = ApprovalNode | ClarificationNode | ValidateNode | AgentNode;

export function mapFlowNodeToGateRequests(
  node: FlowNode,
  context: GateMapperContext,
): GateRequestMapResult {
  const diagnostics = validateContext(node, context);
  if (!isSupportedGateNode(node)) {
    diagnostics.push(
      diagnostic(
        "UNSUPPORTED_GATE_NODE",
        context.nodePath,
        `Gate mapping is not defined for ${node.type}.`,
      ),
    );
    return { ok: false, diagnostics };
  }

  const requests = mapSupportedNode(node, context, diagnostics);
  if (diagnostics.length > 0 || !node.id) return { ok: false, diagnostics };
  return { ok: true, requests, diagnostics: [] };
}

function mapSupportedNode(
  node: SupportedGateNode,
  context: GateMapperContext,
  diagnostics: GateMapperDiagnostic[],
): GateRequest[] {
  switch (node.type) {
    case "approval":
      return mapApproval(node, context, diagnostics);
    case "clarification":
      return mapClarification(node, context, diagnostics);
    case "validate":
      return mapValidate(node, context, diagnostics);
    case "agent":
      return mapAgentGates(node, context, diagnostics);
  }
}

function mapApproval(
  node: ApprovalNode,
  context: GateMapperContext,
  diagnostics: GateMapperDiagnostic[],
): GateRequest[] {
  const approveNodeIds = branchNodeIds(node.onApprove, context, diagnostics);
  const rejectNodeIds = branchNodeIds(node.onReject ?? [], context, diagnostics);
  if (!node.id) return [];
  return [{
    ...baseRequest(node, context, "approval"),
    kind: "human-approval",
    question: node.question,
    options: node.options ?? ["approve", "reject"],
    approveNodeIds,
    rejectNodeIds,
  }];
}

function mapClarification(
  node: ClarificationNode,
  context: GateMapperContext,
  diagnostics: GateMapperDiagnostic[],
): GateRequest[] {
  const format = node.expected ?? "text";
  if (format === "choice" && !node.choices?.length) {
    diagnostics.push(
      diagnostic(
        "INVALID_CLARIFICATION_CHOICES",
        context.nodePath,
        "Choice clarification requires at least one choice.",
      ),
    );
  }
  if (!node.id) return [];
  return [{
    ...baseRequest(node, context, "clarification"),
    kind: "input-request",
    question: node.question,
    response: { format, choices: node.choices ?? [] },
  }];
}

function mapValidate(
  node: ValidateNode,
  context: GateMapperContext,
  diagnostics: GateMapperDiagnostic[],
): GateRequest[] {
  if (node.ref && node.commands?.length) {
    diagnostics.push(
      diagnostic(
        "AMBIGUOUS_VALIDATION_DECLARATION",
        context.nodePath,
        "validate cannot combine a declaration ref with inline commands.",
      ),
    );
  }
  if (!node.ref && !node.commands?.length) {
    diagnostics.push(
      diagnostic(
        "MISSING_VALIDATION_DECLARATION",
        context.nodePath,
        "validate requires a declaration ref or at least one command.",
      ),
    );
  }
  if (!node.id) return [];
  const checks: GateCheck[] = node.ref
    ? [{ kind: "declaration", ref: node.ref }]
    : (node.commands ?? []).map((command) => ({
        kind: "command",
        ...(command.id ? { id: command.id } : {}),
        command: command.command,
      }));
  return [{
    ...baseRequest(node, context, "validate"),
    kind: "command-validation",
    checks,
    ...(node.repair
      ? {
          repair: {
            maxAttempts: node.repair.maxAttempts,
            onFailure: node.repair.onFailure === "retry-prior-agent" ? "retry-subject" : "stop",
          } satisfies GateRepairPolicy,
        }
      : {}),
  }];
}

function mapAgentGates(
  node: AgentNode,
  context: GateMapperContext,
  diagnostics: GateMapperDiagnostic[],
): GateRequest[] {
  if (node.output.schemaRef && node.output.schema) {
    diagnostics.push(
      diagnostic(
        "AMBIGUOUS_AGENT_OUTPUT_SCHEMA",
        context.nodePath,
        "Agent output cannot declare both schemaRef and inline schema.",
      ),
    );
  }
  if (!node.output.schemaRef && !node.output.schema) {
    diagnostics.push(
      diagnostic(
        "MISSING_AGENT_OUTPUT_SCHEMA",
        context.nodePath,
        "Agent output requires schemaRef or inline schema before gate mapping.",
      ),
    );
  }
  if (!node.id) return [];

  const requests: GateRequest[] = [];
  const subject: GateSubject = {
    kind: "execution-output",
    requestId: context.requestId,
    outputKey: node.output.key,
  };
  if (node.output.schemaRef || node.output.schema) {
    requests.push({
      ...baseRequest(node, { ...context, subject }, "agent-output"),
      kind: "schema-validation",
      checks: [{
        kind: "schema",
        ...(node.output.schemaRef ? { schemaRef: node.output.schemaRef } : {}),
        ...(node.output.schema ? { schema: node.output.schema } : {}),
      }],
      ...outputRepair(node),
    });
  }
  if (node.validate) {
    requests.push({
      ...baseRequest(node, { ...context, subject }, "agent-inline"),
      kind: "schema-validation",
      checks: [{ kind: "schema", schema: node.validate.schema }],
      ...(node.validate.failBehavior
        ? {
            repair: {
              maxAttempts: node.validate.maxRetries ?? 1,
              onFailure:
                node.validate.failBehavior === "retry"
                  ? "retry-subject"
                  : node.validate.failBehavior === "abort"
                    ? "stop"
                    : "continue",
            } satisfies GateRepairPolicy,
          }
        : {}),
    });
  }
  if (node.validation?.required.length) {
    requests.push({
      ...baseRequest(node, { ...context, subject }, "agent-commands"),
      kind: "command-validation",
      checks: node.validation.required.map((command) => ({
        kind: "command",
        ...(command.id ? { id: command.id } : {}),
        command: command.command,
      })),
      ...(node.validation.repair
        ? {
            repair: {
              maxAttempts: node.validation.repair.maxAttempts,
              onFailure: "retry-subject",
            } satisfies GateRepairPolicy,
          }
        : {}),
    });
  }
  return requests;
}

function outputRepair(node: AgentNode): { repair?: GateRepairPolicy } {
  const retry = node.retry?.onInvalidOutput ??
    (node.onInvalidOutput
      ? { attempts: node.onInvalidOutput.retry, repairPrompt: node.onInvalidOutput.repairPrompt }
      : undefined);
  return retry
    ? {
        repair: {
          maxAttempts: retry.attempts,
          onFailure: "retry-subject",
          ...(retry.repairPrompt !== undefined ? { repairPrompt: retry.repairPrompt } : {}),
        },
      }
    : {};
}

function baseRequest(
  node: SupportedGateNode,
  context: GateMapperContext,
  suffix: string,
) {
  return {
    schema: "dzupagent.gateRequest/v1" as const,
    gateId: `${context.requestId}:gate:${suffix}`,
    requestId: context.requestId,
    correlationId: context.correlationId,
    source: {
      ...(context.flowId ? { flowId: context.flowId } : {}),
      nodeId: node.id ?? "",
      nodePath: context.nodePath,
      ...(context.profileRef ? { profileRef: context.profileRef } : {}),
      ...(context.capability ? { capability: context.capability } : {}),
    },
    ...(context.subject ? { subject: context.subject } : {}),
    ...(context.policyRef ? { policyRef: context.policyRef } : {}),
    ...(context.requiredActor ? { requiredActor: context.requiredActor } : {}),
    ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
    evidenceRequirements: evidenceRequirements(node),
  };
}

function evidenceRequirements(node: SupportedGateNode): ExecutionEvidenceRequirement[] {
  return node.meta?.evidence === undefined
    ? []
    : [{ kind: "declared", declaration: node.meta.evidence }];
}

function branchNodeIds(
  nodes: readonly FlowNode[],
  context: GateMapperContext,
  diagnostics: GateMapperDiagnostic[],
): string[] {
  return nodes.flatMap((node, index) => {
    if (node.id) return [node.id];
    diagnostics.push(
      diagnostic(
        "MISSING_BRANCH_NODE_ID",
        `${context.nodePath}.branches[${index}]`,
        "Approval outcome branches require stable node ids.",
      ),
    );
    return [];
  });
}

function validateContext(node: FlowNode, context: GateMapperContext): GateMapperDiagnostic[] {
  const diagnostics: GateMapperDiagnostic[] = [];
  if (!node.id) diagnostics.push(diagnostic("MISSING_GATE_NODE_ID", context.nodePath, "Gate mapping requires node.id."));
  if (!context.requestId) diagnostics.push(diagnostic("MISSING_GATE_REQUEST_ID", context.nodePath, "Gate requestId is required."));
  if (!context.correlationId) diagnostics.push(diagnostic("MISSING_GATE_CORRELATION_ID", context.nodePath, "Gate correlationId is required."));
  return diagnostics;
}

function isSupportedGateNode(node: FlowNode): node is SupportedGateNode {
  return node.type === "approval" || node.type === "clarification" || node.type === "validate" || node.type === "agent";
}

function diagnostic(
  code: GateMapperDiagnosticCode,
  nodePath: string,
  message: string,
): GateMapperDiagnostic {
  return { code, nodePath, message };
}
