import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AI_EXECUTION_EVENT_SCHEMA,
  type AiExecutionEvent,
} from "@dzupagent/runtime-contracts/ai-execution";

import {
  unsupportedAiExecutionProjection,
  validateAiExecutionCancellationAcknowledgement,
  validateAiExecutionEventPage,
  type DurableAiExecutionPort,
  type InlineAiExecutionPort,
} from "../ai-execution-port.js";

const started = {
  schema: AI_EXECUTION_EVENT_SCHEMA,
  requestId: "request-1",
  correlationId: "correlation-1",
  sequence: 1,
  cursor: "cursor-1",
  attempt: 1,
  emittedAt: "2026-08-01T00:00:00.000Z",
  type: "started",
} satisfies AiExecutionEvent;

const completed = {
  ...started,
  sequence: 2,
  cursor: "cursor-2",
  emittedAt: "2026-08-01T00:00:01.000Z",
  type: "completed",
  status: "succeeded",
} satisfies AiExecutionEvent;

describe("AI execution lifecycle ports", () => {
  it("keeps inline and durable drivers as distinct implementable ports", () => {
    expectTypeOf<InlineAiExecutionPort>().not.toEqualTypeOf<DurableAiExecutionPort>();
    expectTypeOf<InlineAiExecutionPort["start"]>().toBeFunction();
    expectTypeOf<DurableAiExecutionPort["submit"]>().toBeFunction();
  });

  it("accepts an ordered terminal page with an opaque replay cursor", () => {
    expect(validateAiExecutionEventPage({
      executionId: "execution-1",
      fromCursor: null,
      afterSequence: 0,
      events: [started, completed],
      nextCursor: "cursor-2",
      terminal: true,
    })).toEqual({ valid: true, diagnostics: [] });
  });

  it("accepts an empty replay page without inventing cursor progress", () => {
    expect(validateAiExecutionEventPage({
      executionId: "execution-1",
      fromCursor: "opaque-cursor",
      afterSequence: 2,
      events: [],
      nextCursor: "opaque-cursor",
      terminal: false,
    })).toEqual({ valid: true, diagnostics: [] });
  });

  it("rejects replay cursor and cross-execution identity drift", () => {
    const result = validateAiExecutionEventPage({
      executionId: "execution-1",
      fromCursor: "cursor-0",
      afterSequence: 0,
      events: [started, { ...completed, correlationId: "other", cursor: "cursor-1" }],
      nextCursor: "wrong-cursor",
      terminal: true,
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "AI_LIFECYCLE_EVENT_INVALID",
      "AI_LIFECYCLE_CURSOR_INVALID",
    ]));
  });

  it("rejects competing terminal completion", () => {
    const duplicate = { ...completed, sequence: 3, cursor: "cursor-3" };
    const result = validateAiExecutionEventPage({
      executionId: "execution-1",
      fromCursor: null,
      afterSequence: 0,
      events: [started, completed, duplicate],
      nextCursor: "cursor-3",
      terminal: true,
    });
    expect(result.diagnostics.map(({ code }) => code)).toContain("AI_LIFECYCLE_TERMINAL_CONFLICT");
  });

  it("models cancellation races separately from terminal completion", () => {
    expect(validateAiExecutionCancellationAcknowledgement({
      cancellationId: "cancel-1",
      executionId: "execution-1",
      status: "already-terminal",
      acknowledgedAt: "2026-08-01T00:00:02.000Z",
      terminalStatus: "succeeded",
    })).toEqual({ valid: true, diagnostics: [] });
    expect(validateAiExecutionCancellationAcknowledgement({
      cancellationId: "cancel-1",
      executionId: "execution-1",
      status: "already-terminal",
      acknowledgedAt: "2026-08-01T00:00:02.000Z",
    }).valid).toBe(false);
  });

  it("returns an explicit unsupported projection diagnostic", () => {
    expect(unsupportedAiExecutionProjection("worker.dispatch", "text.generate")).toEqual({
      supported: false,
      diagnostics: [{
        code: "AI_PROJECTION_UNSUPPORTED",
        path: "$",
        message: "Cannot project worker.dispatch to text.generate.",
        sourceKind: "worker.dispatch",
        targetKind: "text.generate",
      }],
    });
  });
});
