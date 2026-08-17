import { describe, expect, it, vi } from "vitest";

import {
  AGENT_LOOP_SPAN_PROJECTION_SCHEMA,
  AGENT_LOOP_TRACE_EVENT_SCHEMA,
  AgentLoopSpanAttr,
  projectAgentLoopTraceEvent,
  recordAgentLoopTraceEvent,
  type AgentLoopTraceEvent,
} from "../agent-loop.js";
import { NoopTracer } from "../noop.js";
import {
  SpanStatusCode,
  type OTelContext,
  type OTelSpan,
  type OTelSpanOptions,
  type OTelTracer,
} from "../otel-types.js";
import { ForgeSpanAttr } from "../span-attributes.js";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;

interface RecordedSpan {
  readonly name: string;
  readonly options?: OTelSpanOptions;
  readonly context?: OTelContext;
  readonly attributes: Record<string, string | number | boolean>;
  readonly events: Array<{
    name: string;
    attributes?: Record<string, string | number | boolean>;
  }>;
  status?: { code: number; message?: string };
  ended: boolean;
}

class RecordingSpan implements OTelSpan {
  readonly recorded: RecordedSpan;

  constructor(
    name: string,
    options?: OTelSpanOptions,
    context?: OTelContext,
  ) {
    this.recorded = {
      name,
      ...(options === undefined ? {} : { options }),
      context,
      attributes: { ...(options?.attributes ?? {}) },
      events: [],
      ended: false,
    };
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.recorded.attributes[key] = value;
    return this;
  }

  setStatus(status: { code: number; message?: string }): this {
    this.recorded.status = status;
    return this;
  }

  addEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): this {
    this.recorded.events.push({ name, ...(attributes === undefined ? {} : { attributes }) });
    return this;
  }

  end(): void {
    this.recorded.ended = true;
  }

  spanContext(): { traceId: string; spanId: string } {
    return {
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
    };
  }

  isRecording(): boolean {
    return !this.recorded.ended;
  }
}

class RecordingTracer implements OTelTracer {
  readonly spans: RecordingSpan[] = [];

  startSpan(
    name: string,
    options?: OTelSpanOptions,
    context?: OTelContext,
  ): OTelSpan {
    const span = new RecordingSpan(name, options, context);
    this.spans.push(span);
    return span;
  }
}

function event(
  overrides: Partial<AgentLoopTraceEvent> = {},
): AgentLoopTraceEvent {
  return {
    schema: AGENT_LOOP_TRACE_EVENT_SCHEMA,
    event: "review.completed",
    observedAt: "2026-07-25T10:00:00.000Z",
    identity: {
      runId: "run-1",
      correlationId: "correlation-1",
      taskId: "task-1",
      dispatchId: "dispatch-1",
      attemptId: "attempt-1",
      reviewId: "review-1",
      generation: 2,
    },
    status: "completed",
    role: "reviewer",
    decision: "continue",
    providerId: "codex",
    modelId: "gpt-5.6",
    providerRouteId: "codex/gpt-5.6/high",
    source: {
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      buildArtifactSha256: SHA_A,
      compilerSemanticHash: SHA_B,
      dslVersion: "dzupflow/v2",
      schemaRegistryHash: SHA_A,
      primitiveRegistryHash: SHA_B,
      compositionHash: SHA_A,
      migrationQualificationHash: SHA_B,
    },
    usage: {
      promptBytes: 5_120,
      contextBytes: 11_200,
      inputTokens: 2_500,
      outputTokens: 400,
      reasoningTokens: 350,
      costCents: 12.5,
      latencyMs: 4_200,
    },
    ...overrides,
  };
}

describe("Agent Loop trace projection", () => {
  it("uses a unique bounded forge.agent_loop attribute namespace", () => {
    const attributes = Object.values(AgentLoopSpanAttr);
    expect(new Set(attributes).size).toBe(attributes.length);
    for (const attribute of attributes) {
      expect(attribute).toMatch(/^forge\.agent_loop\.[a-z0-9_.]+$/u);
      expect(attribute.length).toBeLessThanOrEqual(96);
    }
  });

  it("projects correlation, source, usage, decision, and zero-authority attributes", () => {
    const projection = projectAgentLoopTraceEvent(event());

    expect(projection.schema).toBe(AGENT_LOOP_SPAN_PROJECTION_SCHEMA);
    expect(projection.spanName).toBe("agent_loop.review");
    expect(projection.status).toEqual({ code: SpanStatusCode.OK });
    expect(projection.attributes).toMatchObject({
      [ForgeSpanAttr.RUN_ID]: "run-1",
      [ForgeSpanAttr.GEN_AI_PROVIDER_NAME]: "codex",
      [ForgeSpanAttr.GEN_AI_REQUEST_MODEL]: "gpt-5.6",
      [ForgeSpanAttr.GEN_AI_USAGE_INPUT_TOKENS]: 2_500,
      [ForgeSpanAttr.GEN_AI_USAGE_OUTPUT_TOKENS]: 400,
      [ForgeSpanAttr.COST_CENTS]: 12.5,
      [AgentLoopSpanAttr.CORRELATION_ID]: "correlation-1",
      [AgentLoopSpanAttr.TASK_ID]: "task-1",
      [AgentLoopSpanAttr.REVIEW_ID]: "review-1",
      [AgentLoopSpanAttr.DECISION]: "continue",
      [AgentLoopSpanAttr.COMPILER_SEMANTIC_HASH]: SHA_B,
      [AgentLoopSpanAttr.PRIMITIVE_REGISTRY_HASH]: SHA_B,
      [AgentLoopSpanAttr.PROMPT_BYTES]: 5_120,
      [AgentLoopSpanAttr.CONTEXT_BYTES]: 11_200,
      [AgentLoopSpanAttr.REASONING_TOKENS]: 350,
      [AgentLoopSpanAttr.LATENCY_MS]: 4_200,
      [AgentLoopSpanAttr.EXECUTION_AUTHORITY]: false,
      [AgentLoopSpanAttr.PRODUCTION_AUTHORITY]: false,
    });
    expect(projection.authority).toEqual({
      acceptanceAuthority: false,
      continuationAuthority: false,
      executionAuthority: false,
      mutationAuthority: false,
      deploymentAuthority: false,
      promotionAuthority: false,
      productionAuthority: false,
    });
  });

  it("supports the canonical read-only next-path approver role", () => {
    const projection = projectAgentLoopTraceEvent(
      event({
        event: "next_path_approval.completed",
        role: "next-path-approver",
        decision: "approve",
      }),
    );

    expect(projection.spanName).toBe("agent_loop.next_path_approval");
    expect(projection.attributes[AgentLoopSpanAttr.ROLE]).toBe(
      "next-path-approver",
    );
  });

  it("maps started, ambiguous, and stopped states without inventing success", () => {
    expect(
      projectAgentLoopTraceEvent(
        event({
          event: "implementation.started",
          status: "started",
          role: "implementer",
          identity: (({ reviewId: _drop, ...rest }) => rest)(event().identity),
        }),
      ).status,
    ).toEqual({ code: SpanStatusCode.UNSET });

    expect(
      projectAgentLoopTraceEvent(
        event({
          status: "ambiguous",
          decision: "ambiguous",
        }),
      ).status,
    ).toEqual({ code: SpanStatusCode.UNSET });

    expect(
      projectAgentLoopTraceEvent(
        event({
          event: "run.stopped",
          status: "exhausted",
          identity: {
            runId: "run-1",
            correlationId: "correlation-1",
          },
          role: "manager",
          stopClassification: "token_budget_exhausted",
        }),
      ).status,
    ).toEqual({
      code: SpanStatusCode.ERROR,
      message: "token_budget_exhausted",
    });
  });

  it("fails closed on lifecycle, identity, digest, and usage drift", () => {
    expect(() =>
      projectAgentLoopTraceEvent(event({ status: "started" })),
    ).toThrow(/lifecycle status/u);
    expect(() =>
      projectAgentLoopTraceEvent(
        event({
          identity: { runId: "run-1", correlationId: "correlation-1" },
        }),
      ),
    ).toThrow(/requires taskId/u);
    expect(() =>
      projectAgentLoopTraceEvent(
        event({
          source: {
            compilerSemanticHash: "sha256:not-a-digest",
          },
        }),
      ),
    ).toThrow(/compilerSemanticHash/u);
    expect(() =>
      projectAgentLoopTraceEvent(
        event({
          usage: { inputTokens: -1 },
        }),
      ),
    ).toThrow(/inputTokens/u);
    expect(() =>
      projectAgentLoopTraceEvent(
        event({
          role: "untrusted-role",
        } as unknown as Partial<AgentLoopTraceEvent>),
      ),
    ).toThrow(/role/u);
    expect(() =>
      projectAgentLoopTraceEvent(
        event({
          decision: "invented-decision",
        } as unknown as Partial<AgentLoopTraceEvent>),
      ),
    ).toThrow(/decision/u);
  });

  it("does not project prompt, response, or arbitrary extra content", () => {
    const sensitive = "secret prompt and provider output";
    const projection = projectAgentLoopTraceEvent({
      ...event(),
      prompt: sensitive,
      response: sensitive,
      metadata: { sensitive },
    } as AgentLoopTraceEvent & {
      prompt: string;
      response: string;
      metadata: { sensitive: string };
    });

    expect(JSON.stringify(projection)).not.toContain(sensitive);
  });

  it("records one bounded span and preserves an injected parent context", () => {
    const tracer = new RecordingTracer();
    const parentContext = { trace: "parent" };
    const result = recordAgentLoopTraceEvent(tracer, event(), {
      parentContext,
    });

    expect(result.recorded).toBe(true);
    expect(tracer.spans).toHaveLength(1);
    expect(tracer.spans[0]?.recorded).toMatchObject({
      name: "agent_loop.review",
      context: parentContext,
      status: { code: SpanStatusCode.OK },
      ended: true,
      events: [
        {
          name: "review.completed",
          attributes: {
            [AgentLoopSpanAttr.EVENT]: "review.completed",
            [AgentLoopSpanAttr.STATUS]: "completed",
          },
        },
      ],
    });
  });

  it("degrades safely with the package no-op tracer", () => {
    const result = recordAgentLoopTraceEvent(new NoopTracer(), event());
    expect(result.recorded).toBe(true);
    if (result.recorded)
      expect(result.span.isRecording()).toBe(false);
  });

  it("contains projector, tracer, and error-hook failures without throwing", () => {
    const onError = vi.fn(() => {
      throw new Error("hook failed");
    });
    const invalid = recordAgentLoopTraceEvent(
      new RecordingTracer(),
      event({ observedAt: "not-a-time" }),
      { onError },
    );
    expect(invalid.recorded).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);

    const throwingTracer: OTelTracer = {
      startSpan() {
        throw new Error("export unavailable");
      },
    };
    expect(() =>
      recordAgentLoopTraceEvent(throwingTracer, event(), { onError }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
