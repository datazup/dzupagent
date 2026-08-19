import { describe, expect, expectTypeOf, it, vi } from "vitest"

import * as runtimeSurface from "../orchestration-ports.js"
import type {
  OrchestratorSpanAttrs,
  SpanPort,
  SpanStatus,
  TracerPort,
} from "../orchestration-ports.js"

describe("orchestration tracing ports", () => {
  it("remain a type-only runtime surface", () => {
    expect(Object.keys(runtimeSurface)).toEqual([])
  })

  it("preserve the provider-neutral attribute, status, span, and tracer shapes", () => {
    const statuses: SpanStatus[] = [
      { code: "unset" },
      { code: "ok" },
      { code: "error", message: "failed" },
    ]
    const attrs = {
      "agent_loop.run_id": "run-1",
      "agent_loop.turn_count": 2,
      "agent_loop.pattern": "agent_loop",
      "tool_executor.risk_tier": "low",
      "tool_executor.idempotency_hit": false,
      "tool_executor.tool_name": "git_status",
      "validation.tool_call_id": "call-1",
      "validation.status": "pass",
      "llm.model": "model-1",
      "approval.action_id": "approval-1",
    } satisfies OrchestratorSpanAttrs
    const span: SpanPort = {
      setAttribute: vi.fn(),
      recordException: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    }
    const tracer: TracerPort = {
      startSpan: vi.fn(() => span),
    }

    expectTypeOf(attrs).toMatchTypeOf<OrchestratorSpanAttrs>()
    expectTypeOf(span).toMatchTypeOf<SpanPort>()
    expectTypeOf(tracer).toMatchTypeOf<TracerPort>()
    expect(statuses.map((status) => status.code)).toEqual([
      "unset",
      "ok",
      "error",
    ])
    expect(tracer.startSpan("orchestrator.tool_execute", attrs)).toBe(span)
  })
})
