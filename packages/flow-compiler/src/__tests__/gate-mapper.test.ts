import { describe, expect, it } from "vitest";

import type { FlowNode } from "@dzupagent/flow-ast";

import { mapFlowNodeToGateRequests } from "../index.js";

const context = {
  requestId: "request-1",
  correlationId: "correlation-1",
  flowId: "flow-1",
  nodePath: "root.nodes[1]",
  policyRef: "policy/release",
  requiredActor: { role: "reviewer" },
  deadlineAt: "2026-07-12T00:00:00.000Z",
} as const;

describe("canonical gate mapper", () => {
  it("maps approval outcomes, actor policy, and evidence declarations", () => {
    const result = mapFlowNodeToGateRequests({
      id: "approval-1",
      type: "approval",
      question: "Ship the release?",
      options: ["yes", "no"],
      onApprove: [{ id: "publish", type: "complete" }],
      onReject: [{ id: "revise", type: "complete" }],
      meta: { evidence: { class: "release-review" } },
    } as FlowNode, context);

    expect(result).toEqual({
      ok: true,
      diagnostics: [],
      requests: [expect.objectContaining({
        schema: "dzupagent.gateRequest/v1",
        gateId: "request-1:gate:approval",
        kind: "human-approval",
        question: "Ship the release?",
        options: ["yes", "no"],
        approveNodeIds: ["publish"],
        rejectNodeIds: ["revise"],
        policyRef: "policy/release",
        requiredActor: { role: "reviewer" },
        evidenceRequirements: [{ kind: "declared", declaration: { class: "release-review" } }],
      })],
    });
  });

  it("maps clarification response shape separately from approval", () => {
    const result = mapFlowNodeToGateRequests({
      id: "clarify-1",
      type: "clarification",
      question: "Which environment?",
      expected: "choice",
      choices: ["staging", "production"],
    } as FlowNode, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests[0]).toMatchObject({
      kind: "input-request",
      question: "Which environment?",
      response: { format: "choice", choices: ["staging", "production"] },
    });
  });

  it("maps top-level command validation and repair policy", () => {
    const result = mapFlowNodeToGateRequests({
      id: "validate-1",
      type: "validate",
      commands: [
        { id: "types", command: "yarn typecheck" },
        { id: "tests", command: "yarn test" },
      ],
      repair: { maxAttempts: 2, onFailure: "retry-prior-agent" },
    } as FlowNode, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests[0]).toMatchObject({
      kind: "command-validation",
      checks: [
        { kind: "command", id: "types", command: "yarn typecheck" },
        { kind: "command", id: "tests", command: "yarn test" },
      ],
      repair: { maxAttempts: 2, onFailure: "retry-subject" },
    });
  });

  it("maps agent output, inline schema, and command gates independently", () => {
    const result = mapFlowNodeToGateRequests({
      id: "agent-1",
      type: "agent",
      agentId: "implementer",
      instructions: "Implement",
      output: { key: "result", schemaRef: "result/v1" },
      onInvalidOutput: { retry: 2, repairPrompt: true },
      validate: {
        schema: { type: "object", required: ["summary"] },
        failBehavior: "continue",
        maxRetries: 1,
      },
      validation: {
        required: [{ id: "tests", command: "yarn test" }],
        repair: { maxAttempts: 1 },
      },
    } as FlowNode, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests.map((request) => ({
      gateId: request.gateId,
      kind: request.kind,
      subject: request.subject,
      ...("checks" in request ? { checks: request.checks, repair: request.repair } : {}),
    }))).toEqual([
      {
        gateId: "request-1:gate:agent-output",
        kind: "schema-validation",
        subject: { kind: "execution-output", requestId: "request-1", outputKey: "result" },
        checks: [{ kind: "schema", schemaRef: "result/v1" }],
        repair: { maxAttempts: 2, onFailure: "retry-subject", repairPrompt: true },
      },
      {
        gateId: "request-1:gate:agent-inline",
        kind: "schema-validation",
        subject: { kind: "execution-output", requestId: "request-1", outputKey: "result" },
        checks: [{ kind: "schema", schema: { type: "object", required: ["summary"] } }],
        repair: { maxAttempts: 1, onFailure: "continue" },
      },
      {
        gateId: "request-1:gate:agent-commands",
        kind: "command-validation",
        subject: { kind: "execution-output", requestId: "request-1", outputKey: "result" },
        checks: [{ kind: "command", id: "tests", command: "yarn test" }],
        repair: { maxAttempts: 1, onFailure: "retry-subject" },
      },
    ]);
  });

  it("fails closed for ambiguous declarations and incomplete branches", () => {
    const validation = mapFlowNodeToGateRequests({
      id: "validate-2",
      type: "validate",
      ref: "release",
      commands: [{ command: "yarn test" }],
    } as FlowNode, context);
    const approval = mapFlowNodeToGateRequests({
      id: "approval-2",
      type: "approval",
      question: "Continue?",
      onApprove: [{ type: "complete" }],
    } as FlowNode, context);

    expect(validation.diagnostics.map((item) => item.code)).toEqual([
      "AMBIGUOUS_VALIDATION_DECLARATION",
    ]);
    expect(approval.diagnostics.map((item) => item.code)).toEqual([
      "MISSING_BRANCH_NODE_ID",
    ]);
  });
});
