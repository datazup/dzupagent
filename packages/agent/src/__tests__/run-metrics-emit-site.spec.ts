/**
 * ORCH-DSL-L1-H-16 — end-to-end guard on the `llm:invoked` emit site.
 *
 * The pre-existing bridge tests in `run-metrics.spec.ts` hand-construct the
 * event, so they stayed green while the *real* emit site in
 * `run-engine-generate-tool-loop.ts` omitted `runId` — and
 * `attachRunMetricsBridge` early-returns on `llm:invoked` events without one.
 * Per-run token and cost accumulation was therefore silently zero for every
 * real run, with no error and no warning.
 *
 * These tests deliberately drive `DzupAgent.generate()` through the real
 * engine and the real bridge. A synthetic-event test cannot fail for this
 * defect; only wiring the two production halves together can.
 */
import { describe, it, expect, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { StandardMessageStructure } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createEventBus, type DzupEvent } from "@dzupagent/core";
import { DzupAgent } from "../agent/dzip-agent.js";
import {
  RunMetricsAggregator,
  attachRunMetricsBridge,
} from "../observability/index.js";

function createUsageModel(): BaseChatModel {
  return {
    invoke: vi.fn(() => {
      const msg = new AIMessage<StandardMessageStructure>({
        content: "hello",
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
      });
      return Promise.resolve(msg);
    }),
    bindTools: vi.fn().mockReturnThis(),
    model: "test-model",
  } as unknown as BaseChatModel;
}

describe("llm:invoked emit site carries runId (ORCH-DSL-L1-H-16)", () => {
  it("feeds the real bridge so accumulated tokens and cost are non-zero", async () => {
    const bus = createEventBus();
    const aggregator = new RunMetricsAggregator();
    const detach = attachRunMetricsBridge(bus, aggregator);

    const agent = new DzupAgent({
      id: "metrics-agent",
      instructions: "You are a test agent.",
      model: createUsageModel(),
      eventBus: bus,
    });

    const runId = "run-h16";

    // The run engine does not itself emit `agent:started` / `agent:completed`
    // (see the note at the foot of this file), and the aggregator's
    // `recordComplete` is a documented no-op for a run it never saw start.
    // Those two events are therefore supplied here so this test isolates the
    // defect actually under repair: whether the engine's own `llm:invoked`
    // carries the `runId` the bridge keys on. Without the fix the bridge
    // early-returns and the flushed totals are zero.
    bus.emit({ type: "agent:started", agentId: "metrics-agent", runId });
    await agent.generate([new HumanMessage("hi")], { runId });
    bus.emit({
      type: "agent:completed",
      agentId: "metrics-agent",
      runId,
      durationMs: 1,
    });

    // Allow the bus's microtask handlers to flush.
    await Promise.resolve();

    const row = aggregator.getRunMetrics(runId);
    expect(row).toBeDefined();
    // The whole point of the finding: these were silently zero.
    expect(row?.tokenUsage.input).toBe(100);
    expect(row?.tokenUsage.output).toBe(50);
    expect(row?.costMicros).toBeGreaterThan(0);

    detach();
  });

  it("includes runId on the raw event payload", async () => {
    const bus = createEventBus();
    const seen: DzupEvent[] = [];
    bus.on("llm:invoked", (e) => {
      seen.push(e);
    });

    const agent = new DzupAgent({
      id: "payload-agent",
      instructions: "You are a test agent.",
      model: createUsageModel(),
      eventBus: bus,
    });

    await agent.generate([new HumanMessage("hi")], { runId: "run-payload" });
    await Promise.resolve();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "llm:invoked",
      agentId: "payload-agent",
      runId: "run-payload",
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  /**
   * Known remaining gap, deliberately NOT fixed here.
   *
   * `packages/agent`'s run engine never emits `agent:started` or
   * `agent:completed` — a monorepo-wide search finds emit sites only in
   * `agent-adapters` (`registry/event-bus-bridge.ts`) and `codegen`
   * (`generation/codegen-run-engine.ts`). `packages/agent` only ever
   * *listens* for them, in `observability/event-bus-bridge.ts`.
   *
   * Because `RunMetricsAggregator.recordStart` is what materialises a row and
   * `recordComplete` is a no-op without it, a `DzupAgent` wired to
   * `attachRunMetricsBridge` still produces no metrics row in production even
   * with this fix — the `runId` now arrives and accumulates, but nothing
   * flushes it. Closing that requires emitting agent lifecycle events from the
   * run engine, which changes a shared bus consumed by otel, the compliance
   * audit logger, and the circuit breaker; it is its own change with its own
   * blast radius, not a side-quest of this one.
   */
});
