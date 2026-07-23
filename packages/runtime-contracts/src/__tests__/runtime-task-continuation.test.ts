import { describe, expect, it } from "vitest";

import {
  EXECUTION_LEAF_KINDS,
  isRuntimeTaskTerminalState,
  validateContinuationResult,
  validatePrimitiveInvocation,
  validateRuntimeTaskTransition,
  type ContinuationRequest,
  type ContinuationResult,
  type PrimitiveInvocation,
  type RuntimeTaskRef,
  type RuntimeTaskResult,
} from "../orchestration.js";

const TASK_REF: RuntimeTaskRef = {
  schema: "dzupagent.runtimeTaskRef/v1",
  taskId: "task-1",
  attemptId: "attempt-1",
  generation: 1,
  kind: "mcp-task",
  owner: "fixture-host",
  externalTaskId: "remote-task-1",
};

function taskResult(
  state: RuntimeTaskResult["state"],
  task: RuntimeTaskRef = TASK_REF,
): RuntimeTaskResult {
  const base = {
    schema: "dzupagent.runtimeTaskResult/v1" as const,
    requestId: "request-1",
    correlationId: "correlation-1",
    task,
    evidence: [],
    artifacts: [],
  };

  switch (state) {
    case "requested":
    case "queued":
    case "running":
      return { ...base, state };
    case "input-required":
    case "auth-required":
      return { ...base, state, continuationId: "continuation-1" };
    case "succeeded":
      return { ...base, state, output: { ok: true } };
    case "failed":
      return {
        ...base,
        state,
        error: {
          code: "FIXTURE_FAILED",
          message: "Fixture failed.",
          retryable: false,
        },
      };
    case "cancelled":
    case "expired":
      return { ...base, state, reason: "fixture terminal result" };
  }
}

const CONTINUATION_REQUEST: ContinuationRequest = {
  schema: "dzupagent.continuationRequest/v1",
  continuationId: "continuation-1",
  correlationId: "correlation-1",
  runId: "run-1",
  nodeId: "approval-1",
  attemptId: "attempt-1",
  generation: 2,
  kind: "approval",
  subjectRef: "approval://change-1",
  requestedAt: "2026-07-23T10:00:00.000Z",
  response: {
    required: true,
    schemaRef: "schema://approval-decision@1",
  },
};

function continuationResult(
  overrides: Partial<ContinuationResult> = {},
): ContinuationResult {
  return {
    schema: "dzupagent.continuationResult/v1",
    continuationId: "continuation-1",
    correlationId: "correlation-1",
    generation: 2,
    status: "resumed",
    decidedAt: "2026-07-23T10:05:00.000Z",
    actorRef: "actor://operator-1",
    payload: { decision: "approved" },
    evidence: [],
    ...overrides,
  };
}

describe("canonical runtime task contracts", () => {
  it("publishes a stable execution-leaf runtime list", () => {
    expect(EXECUTION_LEAF_KINDS).toEqual([
      "prompt",
      "agent",
      "adapter.run",
      "worker.dispatch",
    ]);
  });

  it("accepts legal task transitions with stable identity", () => {
    expect(
      validateRuntimeTaskTransition(
        taskResult("running"),
        taskResult("input-required"),
      ),
    ).toEqual({
      valid: true,
      diagnostics: [],
    });
    expect(
      validateRuntimeTaskTransition(
        taskResult("input-required"),
        taskResult("running"),
      ).valid,
    ).toBe(true);
    expect(
      validateRuntimeTaskTransition(
        taskResult("running"),
        taskResult("succeeded"),
      ).valid,
    ).toBe(true);
  });

  it("rejects terminal transitions and identity or generation drift", () => {
    const changedTask = {
      ...TASK_REF,
      attemptId: "attempt-2",
      generation: 2,
    };
    const result = validateRuntimeTaskTransition(
      taskResult("succeeded"),
      taskResult("running", changedTask),
    );

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "ATTEMPT_ID_MISMATCH",
      "GENERATION_MISMATCH",
      "INVALID_TASK_TRANSITION",
    ]);
  });

  it("classifies only terminal states as terminal", () => {
    expect(isRuntimeTaskTerminalState("running")).toBe(false);
    expect(isRuntimeTaskTerminalState("input-required")).toBe(false);
    expect(isRuntimeTaskTerminalState("succeeded")).toBe(true);
    expect(isRuntimeTaskTerminalState("cancelled")).toBe(true);
  });
});

describe("canonical continuation admission", () => {
  it("accepts an identity-bound required response", () => {
    expect(
      validateContinuationResult(
        CONTINUATION_REQUEST,
        continuationResult(),
      ),
    ).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("rejects stale generations and missing required payloads", () => {
    const result = validateContinuationResult(
      CONTINUATION_REQUEST,
      continuationResult({
        generation: 1,
        payload: undefined,
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "CONTINUATION_GENERATION_MISMATCH",
      "MISSING_CONTINUATION_PAYLOAD",
    ]);
  });

  it("requires non-resume results to omit payload and explain the stop", () => {
    const result = validateContinuationResult(
      CONTINUATION_REQUEST,
      continuationResult({
        status: "denied",
        payload: { decision: "denied" },
        reason: "",
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "UNEXPECTED_CONTINUATION_PAYLOAD",
      "MISSING_CONTINUATION_REASON",
    ]);
  });
});

describe("primitive invocation admission", () => {
  it("accepts a complete identity envelope", () => {
    const invocation: PrimitiveInvocation = {
      schema: "dzupagent.primitiveInvocation/v1",
      invocationId: "invocation-1",
      correlationId: "correlation-1",
      attemptId: "attempt-1",
      primitive: {
        kind: "adapter.run",
        version: "1",
      },
      source: {
        nodeId: "review",
        nodePath: "root.nodes[0]",
      },
      input: {
        instructions: "Review the candidate.",
      },
      policy: {},
      effects: {
        effectClass: "llm",
        idempotency: "at-least-once",
      },
      capabilityRequirements: [],
      evidenceRequirements: [],
    };

    expect(validatePrimitiveInvocation(invocation)).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("rejects incomplete primitive and attempt identity", () => {
    const invocation = {
      schema: "dzupagent.primitiveInvocation/v1",
      invocationId: "",
      correlationId: "correlation-1",
      attemptId: " ",
      primitive: {
        kind: "",
        version: "1",
      },
      source: {
        nodeId: "",
        nodePath: "root.nodes[0]",
      },
      input: {},
      policy: {},
      effects: {},
      capabilityRequirements: [],
      evidenceRequirements: [],
    } satisfies PrimitiveInvocation;

    expect(
      validatePrimitiveInvocation(invocation).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual([
      "INVALID_INVOCATION_ID",
      "INVALID_ATTEMPT_ID",
      "INVALID_PRIMITIVE_KIND",
      "INVALID_SOURCE_NODE",
    ]);
  });
});
