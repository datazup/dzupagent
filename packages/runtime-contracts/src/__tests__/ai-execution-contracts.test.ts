import { describe, expect, it } from "vitest";

import type {
  ExecutionRequest,
  ExecutionResult,
} from "../canonical-execution.js";
import {
  AI_EXECUTION_EVENT_SCHEMA,
  AI_EXECUTION_RECEIPT_SCHEMA,
  AI_EXECUTION_REQUEST_SCHEMA,
  AI_PUBLIC_TARGET_SCHEMA,
  AI_RESOLVED_TARGET_SCHEMA,
  projectExecutionRequestToAi,
  validateAiExecutionEvent,
  validateAiExecutionEventSequence,
  validateAiExecutionReceipt,
  validateAiExecutionRequest,
  validateAiExecutionTargetSelection,
  validateAiExecutionTranscript,
  validateAiPublicTargetDescriptor,
  type AiExecutionReceipt,
  type AiExecutionRequest,
  type AiPublicTargetDescriptor,
  type AiResolvedTargetSnapshot,
} from "../ai-execution.js";
import {
  materializeAiResolvedTargetSnapshot,
  validateAiExecutionReceiptCustody,
} from "../ai-execution-node.js";
import {
  materializeExecutionBoundaryEvidenceV1,
  materializeExecutionStateAccessInventoryV1,
} from "../execution-boundary-evidence.js";

const route = {
  id: "route-request-1",
  requestId: "request-1",
  strategy: "fixed",
  candidates: [{ id: "model-default", provider: "provider" }],
  hardConstraints: [],
  preferenceOrder: [],
  fallback: "none",
  maxSelectionLatencyMs: 100,
} as const;

const execution = {
  schema: "dzupagent.executionRequest/v1",
  kind: "prompt",
  requestId: "request-1",
  correlationId: "correlation-1",
  attempt: 1,
  source: { nodeId: "node-1", nodePath: "node-1" },
  prompt: { layers: [{ kind: "task", content: "Summarize" }], bindings: {} },
  tools: { mode: "none", grants: [] },
  output: { key: "answer", format: "text" },
  route,
  policy: {},
  effects: { effectClass: "llm" },
  cancellation: { mode: "cooperative" },
  evidenceRequirements: [],
} satisfies ExecutionRequest;

const request = {
  schema: AI_EXECUTION_REQUEST_SCHEMA,
  execution,
  operation: {
    kind: "text.generate",
    input: { text: "Summarize" },
    output: { modality: "text" },
  },
  target: { kind: "target-id", targetId: "docs.summary.default" },
} satisfies AiExecutionRequest;

const snapshot = materializeAiResolvedTargetSnapshot({
  schema: AI_RESOLVED_TARGET_SCHEMA,
  targetId: "docs.summary.default",
  targetRevision: "target-revision-1",
  policyRevision: "policy-revision-1",
  operation: "text.generate",
  placement: "server",
  executionStyle: "inline",
  routeCandidateId: "model-default",
  backend: "sdk",
  provider: "provider",
  model: "model",
  resolvedAt: "2026-08-01T00:00:00.000Z",
} satisfies Omit<AiResolvedTargetSnapshot, "snapshotDigest">);

const result = {
  schema: "dzupagent.executionResult/v1",
  requestId: execution.requestId,
  correlationId: execution.correlationId,
  routeDecision: {
    id: "decision-1",
    policyId: route.id,
    requestId: execution.requestId,
    eligibleCandidateIds: ["model-default"],
    rejected: [],
    selectedCandidateId: "model-default",
    fallbackCandidateIds: [],
    strategy: "fixed",
    decidedAt: "2026-08-01T00:00:00.000Z",
  },
  evidence: [],
  artifacts: [],
  status: "succeeded",
  output: "summary",
} satisfies ExecutionResult;

const receipt = {
  schema: AI_EXECUTION_RECEIPT_SCHEMA,
  requestId: execution.requestId,
  correlationId: execution.correlationId,
  operation: "text.generate",
  requestedTarget: request.target,
  target: snapshot,
  attempts: [
    {
      attempt: 1,
      target: snapshot,
      dispatch: { status: "terminal" },
      usage: {
        measurement: "known",
        tokens: { input: 10, output: 5, cachedInput: 2 },
        cost: { status: "reconciled", currency: "USD", amountMicros: 25 },
      },
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:01.000Z",
    },
  ],
  result,
  usage: {
    measurement: "known",
    tokens: { input: 10, output: 5, cachedInput: 2 },
    cost: { status: "reconciled", currency: "USD", amountMicros: 25 },
  },
  terminalEventSequence: 3,
  completedAt: "2026-08-01T00:00:01.000Z",
} satisfies AiExecutionReceipt;

describe("AI execution contracts", () => {
  it("composes operation semantics around the canonical execution request", () => {
    expect(validateAiExecutionRequest(request)).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("projects existing execution leaves without guessing the operation", () => {
    const workerExecution = {
      ...execution,
      kind: "worker.dispatch",
      worker: { dispatchId: "dispatch-1" },
    } satisfies ExecutionRequest;
    const projection = projectExecutionRequestToAi(
      workerExecution,
      request.operation,
      { kind: "target-id", targetId: "docs.summary.worker" },
    );

    expect(projection.valid).toBe(true);
    expect(projection.request.execution).toBe(workerExecution);
    expect(projection.request.operation).toBe(request.operation);
  });

  it("validates boundary evidence and binds it to the canonical request before dispatch", () => {
    const owner = {
      rootDefinitionId: "flow/summary",
      rootDefinitionDigest: `sha256:${"a".repeat(64)}` as const,
      scopedDefinitionId: "flow/summary/root",
      scopedDefinitionDigest: `sha256:${"b".repeat(64)}` as const,
      executionKind: "prompt" as const,
      nodeId: execution.source.nodeId,
      nodePath: execution.source.nodePath,
    };
    const state = materializeExecutionStateAccessInventoryV1({
      owner,
      declared: {
        status: "exact",
        basisDigest: `sha256:${"c".repeat(64)}`,
        reads: [],
        writes: [execution.output.key],
      },
      observed: {
        status: "unknown",
        reason: "runtime-observation-unavailable",
      },
    });
    const boundaryEvidence = materializeExecutionBoundaryEvidenceV1({
      owner,
      state,
    });
    const exact = {
      ...request,
      execution: { ...execution, boundaryEvidence },
    } satisfies AiExecutionRequest;

    expect(validateAiExecutionRequest(exact)).toEqual({
      valid: true,
      diagnostics: [],
    });

    const corrupt = {
      ...exact,
      execution: {
        ...exact.execution,
        boundaryEvidence: {
          ...boundaryEvidence,
          boundaryDigest: `sha256:${"f".repeat(64)}` as const,
        },
      },
    } as unknown as AiExecutionRequest;
    expect(
      validateAiExecutionRequest(corrupt).diagnostics.map((item) => item.code),
    ).toContain("AI_EXECUTION_BOUNDARY_INVALID");

    const foreignOwner = {
      ...owner,
      nodeId: "foreign-node",
      nodePath: "root.nodes[9]",
    };
    const foreignState = materializeExecutionStateAccessInventoryV1({
      owner: foreignOwner,
      declared: {
        status: "exact",
        basisDigest: `sha256:${"c".repeat(64)}`,
        reads: [],
        writes: [execution.output.key],
      },
      observed: {
        status: "unknown",
        reason: "runtime-observation-unavailable",
      },
    });
    const foreign = {
      ...request,
      execution: {
        ...execution,
        boundaryEvidence: materializeExecutionBoundaryEvidenceV1({
          owner: foreignOwner,
          state: foreignState,
        }),
      },
    } satisfies AiExecutionRequest;
    expect(
      validateAiExecutionRequest(foreign).diagnostics.map((item) => item.code),
    ).toContain("AI_EXECUTION_BOUNDARY_INVALID");
  });

  it("rejects agent operations projected through a plain prompt leaf", () => {
    const invalid = {
      ...request,
      operation: {
        kind: "agent.run",
        input: { agentRef: "agent-1" },
        output: { modality: "unknown" },
      },
    } as unknown as AiExecutionRequest;

    expect(
      validateAiExecutionRequest(invalid).diagnostics.map(({ code }) => code),
    ).toContain("AI_EXECUTION_KIND_INCOMPATIBLE");
  });

  it("requires a schema for structured output", () => {
    const invalid = {
      ...request,
      operation: {
        kind: "structured.generate",
        input: { prompt: "Return JSON" },
        output: { modality: "json" },
      },
    } as AiExecutionRequest;

    expect(validateAiExecutionRequest(invalid).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "AI_INVALID_VALUE",
        path: "operation.output",
      }),
    );
  });

  it("returns diagnostics instead of throwing for malformed operation payloads", () => {
    const malformed = {
      ...request,
      operation: { kind: "structured.generate" },
    } as unknown as AiExecutionRequest;

    expect(() => validateAiExecutionRequest(malformed)).not.toThrow();
    expect(
      validateAiExecutionRequest(malformed).diagnostics.map(({ path }) => path),
    ).toEqual([
      "operation.input.prompt",
      "operation.output.modality",
      "operation.output",
    ]);
  });

  it("keeps every public validator unknown-input safe", () => {
    expect(() => validateAiExecutionRequest(null)).not.toThrow();
    expect(() => validateAiPublicTargetDescriptor("target")).not.toThrow();
    expect(() => validateAiExecutionEvent({ type: "usage" })).not.toThrow();
    expect(() => validateAiExecutionReceipt({ attempts: [null] })).not.toThrow();
    expect(() => validateAiExecutionReceiptCustody({ attempts: [null] })).not.toThrow();
  });

  it("keeps private routing data out of browser-safe targets", () => {
    const target = {
      schema: AI_PUBLIC_TARGET_SCHEMA,
      targetId: "docs.summary.default",
      revision: "target-revision-1",
      displayName: "Default summary",
      operations: ["text.generate"],
      capabilities: ["text/v1"],
      placement: "server",
      executionStyle: "inline",
      health: { status: "healthy" },
    } satisfies AiPublicTargetDescriptor;

    expect(validateAiPublicTargetDescriptor(target)).toEqual({
      valid: true,
      diagnostics: [],
    });
    expect(
      validateAiPublicTargetDescriptor({
        ...target,
        nested: {
          providerPath: "private-provider",
          workerId: "worker-1",
          endpoint: "private-endpoint",
        },
      } as AiPublicTargetDescriptor).diagnostics,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "AI_PUBLIC_TARGET_LEAK", path: "nested.providerPath" }),
      expect.objectContaining({ code: "AI_PUBLIC_TARGET_LEAK", path: "nested.workerId" }),
      expect.objectContaining({ code: "AI_PUBLIC_TARGET_LEAK", path: "nested.endpoint" }),
    ]));
  });

  it("requires stable versioned capability identifiers", () => {
    const target = {
      schema: AI_PUBLIC_TARGET_SCHEMA,
      targetId: "docs.summary.default",
      revision: "target-revision-1",
      displayName: "Default summary",
      operations: ["text.generate"],
      capabilities: ["text", "Text/v1", "text/v0", "text/v1"],
      placement: "server",
      executionStyle: "inline",
      health: { status: "healthy" },
    } as unknown as AiPublicTargetDescriptor;

    expect(
      validateAiPublicTargetDescriptor(target).diagnostics
        .filter(({ code }) => code === "AI_CAPABILITY_ID_INVALID"),
    ).toHaveLength(3);
  });

  it("rejects a target that does not support the requested operation", () => {
    const target = {
      schema: AI_PUBLIC_TARGET_SCHEMA,
      targetId: request.target.kind === "target-id" ? request.target.targetId : "unexpected",
      revision: "target-revision-1",
      displayName: "Embeddings only",
      operations: ["embedding.create"],
      capabilities: ["embedding/v1"],
      placement: "server",
      executionStyle: "inline",
      health: { status: "healthy" },
    } satisfies AiPublicTargetDescriptor;

    expect(validateAiExecutionTargetSelection(request, target).diagnostics).toContainEqual(
      expect.objectContaining({ code: "AI_TARGET_OPERATION_UNSUPPORTED" }),
    );
  });

  it("keeps Worker placement independent from inline or durable lifecycle", () => {
    const target = {
      schema: AI_PUBLIC_TARGET_SCHEMA,
      targetId: "worker",
      revision: "target-revision-1",
      displayName: "Worker",
      operations: ["text.generate"],
      capabilities: [],
      placement: "worker",
      executionStyle: "inline",
      health: { status: "unknown" },
    } satisfies AiPublicTargetDescriptor;

    expect(validateAiPublicTargetDescriptor(target)).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("rejects Worker dispatch and batch protocols as AI operations", () => {
    const target = {
      schema: AI_PUBLIC_TARGET_SCHEMA,
      targetId: "worker",
      revision: "target-revision-1",
      displayName: "Worker",
      operations: ["worker.dispatch", "batch.submit"],
      capabilities: [],
      placement: "worker",
      executionStyle: "durable",
      health: { status: "unknown" },
    } as unknown as AiPublicTargetDescriptor;

    expect(
      validateAiPublicTargetDescriptor(target).diagnostics.map(({ code }) => code),
    ).toEqual(["AI_INVALID_VALUE", "AI_INVALID_VALUE"]);
  });

  it("accepts ordered events with explicit usage truth", () => {
    expect(
      validateAiExecutionEvent({
        schema: AI_EXECUTION_EVENT_SCHEMA,
        requestId: execution.requestId,
        correlationId: execution.correlationId,
        sequence: 2,
        cursor: "2",
        attempt: 1,
        emittedAt: "2026-08-01T00:00:00.500Z",
        type: "usage",
        usage: {
          measurement: "partial",
          tokens: { input: 10, output: 0 },
          cost: { status: "unknown" },
        },
      }),
    ).toEqual({ valid: true, diagnostics: [] });
  });

  it("requires one final terminal event and contiguous ordering", () => {
    const base = {
      schema: AI_EXECUTION_EVENT_SCHEMA,
      requestId: execution.requestId,
      correlationId: execution.correlationId,
      attempt: 1,
      emittedAt: "2026-08-01T00:00:00.500Z",
    } as const;
    expect(
      validateAiExecutionEventSequence([
        { ...base, sequence: 1, cursor: "1", type: "started" },
        { ...base, sequence: 2, cursor: "2", type: "output.delta", delta: "ok" },
        { ...base, sequence: 3, cursor: "3", type: "completed", status: "succeeded" },
      ]),
    ).toEqual({ valid: true, diagnostics: [] });

    expect(
      validateAiExecutionEventSequence([
        { ...base, sequence: 2, cursor: "same", type: "completed", status: "succeeded" },
        { ...base, sequence: 3, cursor: "same", type: "started" },
      ]).diagnostics.map(({ code }) => code),
    ).toEqual([
      "AI_EVENT_SEQUENCE_INVALID",
      "AI_TERMINAL_EVENT_INVALID",
      "AI_EVENT_SEQUENCE_INVALID",
      "AI_EVENT_SEQUENCE_INVALID",
    ]);
  });

  it("does not interpret unknown usage as zero", () => {
    const invalid = {
      ...receipt,
      usage: {
        measurement: "unknown",
        tokens: { input: 0, output: 0 },
        cost: { status: "unknown" },
      },
    } as unknown as AiExecutionReceipt;

    expect(validateAiExecutionReceipt(invalid).diagnostics).toContainEqual(
      expect.objectContaining({ code: "AI_USAGE_TRUTH_INVALID", path: "usage" }),
    );
  });

  it("rejects drift between legacy result usage and explicit usage truth", () => {
    const invalid = {
      ...receipt,
      result: {
        ...result,
        usage: { inputTokens: 11, outputTokens: 5, costCents: 1 },
      },
    } satisfies AiExecutionReceipt;

    expect(
      validateAiExecutionReceipt(invalid).diagnostics.map(({ path }) => path),
    ).toEqual(["result.usage.inputTokens", "result.usage.costCents"]);
  });

  it("accepts a receipt bound to the final target and route decision", () => {
    expect(validateAiExecutionReceipt(receipt)).toEqual({
      valid: true,
      diagnostics: [],
    });
    expect(validateAiExecutionReceiptCustody(receipt)).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("binds terminal transcript identity, status, sequence, and usage", () => {
    const events = [
      {
        schema: AI_EXECUTION_EVENT_SCHEMA,
        requestId: execution.requestId,
        correlationId: execution.correlationId,
        sequence: 1,
        cursor: "1",
        attempt: 1,
        emittedAt: "2026-08-01T00:00:00.000Z",
        type: "started",
      },
      {
        schema: AI_EXECUTION_EVENT_SCHEMA,
        requestId: execution.requestId,
        correlationId: execution.correlationId,
        sequence: 2,
        cursor: "2",
        attempt: 1,
        emittedAt: "2026-08-01T00:00:00.500Z",
        type: "usage",
        usage: receipt.usage,
      },
      {
        schema: AI_EXECUTION_EVENT_SCHEMA,
        requestId: execution.requestId,
        correlationId: execution.correlationId,
        sequence: 3,
        cursor: "3",
        attempt: 1,
        emittedAt: "2026-08-01T00:00:01.000Z",
        type: "completed",
        status: "succeeded",
      },
    ] as const;

    expect(validateAiExecutionTranscript(receipt, events)).toEqual({
      valid: true,
      diagnostics: [],
    });
    expect(
      validateAiExecutionTranscript(
        { ...receipt, terminalEventSequence: 4 },
        events,
      ).diagnostics,
    ).toContainEqual(
      expect.objectContaining({ code: "AI_TRANSCRIPT_RECEIPT_MISMATCH" }),
    );
  });

  it("reconciles known receipt usage from every attempt", () => {
    const invalid = {
      ...receipt,
      usage: {
        ...receipt.usage,
        tokens: { input: 11, output: 5, cachedInput: 2 },
      },
    } satisfies AiExecutionReceipt;

    expect(validateAiExecutionReceipt(invalid).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "AI_ATTEMPT_USAGE_MISMATCH",
        path: "usage.tokens",
      }),
    );
  });

  it("rejects target, attempt, route, and result identity drift", () => {
    const invalid = {
      ...receipt,
      correlationId: "other-correlation",
      target: {
        ...snapshot,
        routeCandidateId: "other-route",
      },
      attempts: [{ ...receipt.attempts[0], attempt: 2 }],
    } as AiExecutionReceipt;

    const codes = validateAiExecutionReceiptCustody(invalid).diagnostics.map(
      ({ code }) => code,
    );
    expect(codes).toContain("AI_IDENTITY_MISMATCH");
    expect(codes).toContain("AI_ROUTE_TARGET_MISMATCH");
    expect(codes).toContain("AI_ATTEMPT_SEQUENCE_INVALID");
    expect(codes).toContain("AI_TARGET_SNAPSHOT_INVALID");
  });
});
