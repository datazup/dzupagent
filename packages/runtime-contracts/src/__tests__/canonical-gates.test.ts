import { describe, expect, it } from "vitest";

import {
  validateGateResult,
  type GateRequest,
  type GateResult,
} from "../index.js";

const approvalRequest: GateRequest = {
  schema: "dzupagent.gateRequest/v1",
  gateId: "request-1:gate:approval",
  requestId: "request-1",
  correlationId: "correlation-1",
  kind: "human-approval",
  source: { nodeId: "approval-1", nodePath: "root.nodes[1]" },
  requiredActor: { role: "reviewer" },
  evidenceRequirements: [],
  question: "Ship this change?",
  options: ["approve", "reject"],
  approveNodeIds: ["publish"],
  rejectNodeIds: ["revise"],
};

describe("canonical gate contracts", () => {
  it("validates an actor-bound human approval result", () => {
    const result: GateResult = {
      schema: "dzupagent.gateResult/v1",
      gateId: approvalRequest.gateId,
      requestId: approvalRequest.requestId,
      correlationId: approvalRequest.correlationId,
      kind: approvalRequest.kind,
      status: "passed",
      decidedAt: "2026-07-11T00:00:00.000Z",
      actor: { actorId: "user-1", role: "reviewer" },
      evidence: [{
        uri: "artifact://approval/decision.json",
        digest: "sha256:abc",
        digestOf: "sanitized",
        redactionStatus: "redacted",
        contentClass: "approval-decision",
      }],
      artifacts: [],
    };

    expect(validateGateResult(approvalRequest, result)).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("keeps human rejection distinct from execution failure", () => {
    const rejected: GateResult = {
      schema: "dzupagent.gateResult/v1",
      gateId: approvalRequest.gateId,
      requestId: approvalRequest.requestId,
      correlationId: approvalRequest.correlationId,
      kind: approvalRequest.kind,
      status: "rejected",
      decidedAt: "2026-07-11T00:00:00.000Z",
      actor: { actorId: "user-1" },
      reason: "Needs revision",
      evidence: [],
      artifacts: [],
    };

    expect(validateGateResult(approvalRequest, rejected).valid).toBe(true);
    expect(rejected.status).toBe("rejected");
  });

  it("requires actors and failure diagnostics where declared", () => {
    const noActor = {
      schema: "dzupagent.gateResult/v1",
      gateId: approvalRequest.gateId,
      requestId: approvalRequest.requestId,
      correlationId: approvalRequest.correlationId,
      kind: approvalRequest.kind,
      status: "passed",
      decidedAt: "2026-07-11T00:00:00.000Z",
      evidence: [],
      artifacts: [],
    } as GateResult;
    const failed = {
      ...noActor,
      status: "failed",
      completedAt: "2026-07-11T00:00:00.000Z",
      diagnostics: [],
    } as GateResult;

    expect(validateGateResult(approvalRequest, noActor).diagnostics.map((item) => item.code)).toEqual([
      "MISSING_GATE_ACTOR",
    ]);
    expect(validateGateResult(approvalRequest, failed).diagnostics.map((item) => item.code)).toEqual([
      "MISSING_FAILURE_DIAGNOSTIC",
    ]);
    expect(validateGateResult(approvalRequest, {
      ...noActor,
      actor: { actorId: "user-2", role: "operator" },
    }).diagnostics.map((item) => item.code)).toEqual([
      "GATE_ACTOR_MISMATCH",
    ]);
  });

  it("rejects input-required status on deterministic validation gates", () => {
    const request: GateRequest = {
      schema: "dzupagent.gateRequest/v1",
      gateId: "request-1:gate:schema",
      requestId: "request-1",
      correlationId: "correlation-1",
      kind: "schema-validation",
      source: { nodeId: "agent-1", nodePath: "root.nodes[0]" },
      evidenceRequirements: [],
      checks: [{ kind: "schema", schemaRef: "result/v1" }],
    };
    const result: GateResult = {
      schema: "dzupagent.gateResult/v1",
      gateId: request.gateId,
      requestId: request.requestId,
      correlationId: request.correlationId,
      kind: request.kind,
      status: "input_required",
      requestedAt: "2026-07-11T00:00:00.000Z",
      evidence: [],
      artifacts: [],
    };

    expect(validateGateResult(request, result).diagnostics.map((item) => item.code)).toEqual([
      "INVALID_GATE_STATUS",
    ]);
  });

  it("fails closed for incomplete or raw evidence-shaped data", () => {
    const result = {
      schema: "dzupagent.gateResult/v1",
      gateId: approvalRequest.gateId,
      requestId: approvalRequest.requestId,
      correlationId: approvalRequest.correlationId,
      kind: approvalRequest.kind,
      status: "pending",
      evidence: [{
        uri: "artifact://raw/events.jsonl",
        digest: "sha256:raw",
        digestOf: "raw",
        redactionStatus: "raw",
        contentClass: "provider-events",
      }],
      artifacts: [],
    } as unknown as GateResult;

    expect(validateGateResult(approvalRequest, result).diagnostics.map((item) => item.code)).toEqual([
      "INVALID_SANITIZED_EVIDENCE",
    ]);
  });
});
