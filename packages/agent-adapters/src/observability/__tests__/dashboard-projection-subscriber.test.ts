import { beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "@dzupagent/core";
import type { DzupEvent, DzupEventBus } from "@dzupagent/core";
import type { AdapterMonitorDashboardContract } from "@dzupagent/adapter-types";
import {
  DashboardProjectionSubscriber,
  UNSOURCED_V1_FIELDS,
  createDashboardProjectionSubscriber,
} from "../dashboard-projection-subscriber.js";

const CONTRACT_KEYS = [
  "providerId",
  "monitorTier",
  "watcherState",
  "rawEventCount",
  "normalizedEventCount",
  "artifactCount",
  "toolCallCount",
  "approvalPromptCount",
  "mcpToolUsageCount",
  "mcpMode",
  "costMicros",
  "totalTokens",
  "retryCount",
  "fallbackCount",
  "successRate",
] as const;

describe("DashboardProjectionSubscriber", () => {
  let bus: DzupEventBus;
  let subscriber: DashboardProjectionSubscriber;

  beforeEach(() => {
    bus = createEventBus();
    subscriber = createDashboardProjectionSubscriber(bus);
  });

  describe("FR-3.1 — materializes the existing V1 contract", () => {
    it("produces a row whose keys are exactly the contract surface", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });

      const row = subscriber.getProjection("claude");

      expect(row).not.toBeNull();
      expect(Object.keys(row!).sort()).toEqual([...CONTRACT_KEYS].sort());
      expect(CONTRACT_KEYS).toHaveLength(15);
    });

    it("satisfies the contract invariants the hand-written fixture asserts", () => {
      // FR-3.1: the same shape rules adapter-types pins against a literal
      // fixture must hold for real producer output. adapter-types cannot
      // import agent-adapters (dependency direction), so the producer side
      // owns this half of the check.
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({
        type: "tool:called",
        toolName: "read",
        executionRunId: "run-1",
      });
      bus.emit({
        type: "agent:completed",
        agentId: "claude",
        runId: "run-1",
        durationMs: 5,
        usage: { inputTokens: 10, outputTokens: 5, costCents: 2 },
      });

      const row = subscriber.getProjection("claude")!;

      const nullableNumericFields = [
        "rawEventCount",
        "normalizedEventCount",
        "artifactCount",
        "toolCallCount",
        "approvalPromptCount",
        "mcpToolUsageCount",
        "costMicros",
        "totalTokens",
        "retryCount",
        "fallbackCount",
        "successRate",
      ] as const;

      for (const field of nullableNumericFields) {
        const value = row[field];
        expect(
          value === null || typeof value === "number",
          `${field} must be a number or null, got ${typeof value}`
        ).toBe(true);
        if (typeof value === "number") {
          expect(Number.isFinite(value), `${field} must be finite`).toBe(true);
        }
      }

      expect(["deep", "partial", "artifact-backed", "none"]).toContain(
        row.monitorTier
      );
      expect(["active", "not_configured", "stopped"]).toContain(
        row.watcherState
      );
      expect(
        row.mcpMode === null ||
          row.mcpMode === "native" ||
          row.mcpMode === "system-prompt-fallback"
      ).toBe(true);
      expect(row.successRate).toBeGreaterThanOrEqual(0);
      expect(row.successRate).toBeLessThanOrEqual(1);
    });

    it("is assignable to AdapterMonitorDashboardContract without a cast", () => {
      bus.emit({ type: "agent:started", agentId: "codex", runId: "run-1" });

      const row: AdapterMonitorDashboardContract =
        subscriber.getProjection("codex")!;

      expect(row.providerId).toBe("codex");
    });

    it("reads monitorTier from the provider catalog", () => {
      // The catalog names this field monitorIntrospection; claude is 'deep'
      // and goose is 'artifact-backed', so a wrong mapping cannot pass both.
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({ type: "agent:started", agentId: "goose", runId: "run-2" });

      expect(subscriber.getProjection("claude")!.monitorTier).toBe("deep");
      expect(subscriber.getProjection("goose")!.monitorTier).toBe(
        "artifact-backed"
      );
    });

    it("falls back to none for a provider absent from the catalog", () => {
      bus.emit({
        type: "agent:started",
        agentId: "not-a-real-provider",
        runId: "run-1",
      });

      expect(subscriber.getProjection("not-a-real-provider")!.monitorTier).toBe(
        "none"
      );
    });

    it("keeps one independent tally per provider", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({ type: "agent:started", agentId: "codex", runId: "run-2" });
      bus.emit({
        type: "tool:called",
        toolName: "read",
        executionRunId: "run-1",
      });
      bus.emit({
        type: "tool:called",
        toolName: "read",
        executionRunId: "run-1",
      });
      bus.emit({
        type: "tool:called",
        toolName: "read",
        executionRunId: "run-2",
      });

      expect(subscriber.getProjection("claude")!.toolCallCount).toBe(2);
      expect(subscriber.getProjection("codex")!.toolCallCount).toBe(1);
    });

    it("returns null for a provider that produced no events", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });

      expect(subscriber.getProjection("qwen")).toBeNull();
      expect(subscriber.getProviderIds()).toEqual(["claude"]);
    });
  });

  describe("null-vs-zero semantics", () => {
    it("reports a measured zero as 0 and an unavailable metric as null", () => {
      // The whole point of the nullable contract: these must not collapse.
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });

      const row = subscriber.getProjection("claude")!;

      expect(row.toolCallCount).toBe(0);
      expect(row.approvalPromptCount).toBe(0);
      expect(row.retryCount).toBe(0);

      expect(row.rawEventCount).toBeNull();
      expect(row.normalizedEventCount).toBeNull();
      expect(row.artifactCount).toBeNull();
      expect(row.mcpToolUsageCount).toBeNull();
      expect(row.mcpMode).toBeNull();
      expect(row.fallbackCount).toBeNull();
    });

    it("leaves cost and tokens null until a provider actually reports usage", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({
        type: "agent:completed",
        agentId: "claude",
        runId: "run-1",
        durationMs: 10,
      });

      const row = subscriber.getProjection("claude")!;

      expect(row.costMicros).toBeNull();
      expect(row.totalTokens).toBeNull();
      expect(row.costMicros).not.toBe(0);
      expect(row.totalTokens).not.toBe(0);
    });

    it("converts reported cents to micro-dollars", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({
        type: "agent:completed",
        agentId: "claude",
        runId: "run-1",
        durationMs: 10,
        usage: { inputTokens: 100, outputTokens: 25, costCents: 3 },
      });

      const row = subscriber.getProjection("claude")!;

      // 3 cents = 30_000 micro-dollars. A pass-through or a ×1000 both fail.
      expect(row.costMicros).toBe(30_000);
      expect(row.totalTokens).toBe(125);
    });

    it("accumulates usage across runs", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({
        type: "agent:completed",
        agentId: "claude",
        runId: "run-1",
        durationMs: 10,
        usage: { inputTokens: 100, outputTokens: 25, costCents: 3 },
      });
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-2" });
      bus.emit({
        type: "agent:completed",
        agentId: "claude",
        runId: "run-2",
        durationMs: 10,
        usage: { inputTokens: 10, outputTokens: 5, costCents: 1 },
      });

      const row = subscriber.getProjection("claude")!;

      expect(row.totalTokens).toBe(140);
      expect(row.costMicros).toBe(40_000);
    });

    it("counts a genuinely reported zero cost as measured, not unavailable", () => {
      bus.emit({ type: "agent:started", agentId: "ollama", runId: "run-1" });
      bus.emit({
        type: "agent:completed",
        agentId: "ollama",
        runId: "run-1",
        durationMs: 10,
        usage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
      });

      const row = subscriber.getProjection("ollama")!;

      // A local model reporting zero cost is a measurement, not a gap.
      expect(row.costMicros).toBe(0);
      expect(row.costMicros).not.toBeNull();
      expect(row.totalTokens).toBe(0);
      expect(row.totalTokens).not.toBeNull();
    });

    it("documents every unsourced field with a reason", () => {
      const nullFields = [
        "rawEventCount",
        "normalizedEventCount",
        "artifactCount",
        "mcpToolUsageCount",
        "mcpMode",
        "fallbackCount",
      ] as const;

      for (const field of nullFields) {
        expect(UNSOURCED_V1_FIELDS[field]).toBeTruthy();
      }
      expect(Object.keys(UNSOURCED_V1_FIELDS).sort()).toEqual(
        [...nullFields].sort()
      );
    });
  });

  describe("successRate", () => {
    it("is null before any run reaches a terminal state", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });

      // Phantom green: an unfinished provider must not read as 100% success.
      expect(subscriber.getProjection("claude")!.successRate).toBeNull();
    });

    it("is the completed share of terminal events", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({
        type: "agent:completed",
        agentId: "claude",
        runId: "run-1",
        durationMs: 5,
      });
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-2" });
      bus.emit({
        type: "agent:completed",
        agentId: "claude",
        runId: "run-2",
        durationMs: 5,
      });
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-3" });
      bus.emit({
        type: "agent:failed",
        agentId: "claude",
        runId: "run-3",
        errorCode: "AGENT_EXECUTION_FAILED",
        message: "boom",
      });

      // 2 of 3 — an off-by-one in either term gives 0.5 or 1.0, not 0.666…
      expect(subscriber.getProjection("claude")!.successRate).toBeCloseTo(
        2 / 3,
        10
      );
    });

    it("is 0 when every terminal run failed", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({
        type: "agent:failed",
        agentId: "claude",
        runId: "run-1",
        errorCode: "AGENT_EXECUTION_FAILED",
        message: "boom",
      });

      const row = subscriber.getProjection("claude")!;

      expect(row.successRate).toBe(0);
      expect(row.successRate).not.toBeNull();
    });
  });

  describe("provider attribution", () => {
    it("resolves a tool call through the run map when the event omits providerId", () => {
      // EventBusBridge drops providerId on tool:called, so this is the
      // load-bearing path for toolCallCount.
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({
        type: "tool:called",
        toolName: "read",
        executionRunId: "run-1",
      });

      expect(subscriber.getProjection("claude")!.toolCallCount).toBe(1);
      expect(subscriber.getStats().droppedUnattributed).toBe(0);
    });

    it("drops an unattributable tool call instead of guessing a provider", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({
        type: "tool:called",
        toolName: "read",
        executionRunId: "unknown-run",
      });

      // Misattribution would silently corrupt claude's row.
      expect(subscriber.getProjection("claude")!.toolCallCount).toBe(0);
      expect(subscriber.getStats().droppedUnattributed).toBe(1);
    });

    it("prefers an explicit agentId over the run map", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({
        type: "tool:called",
        toolName: "read",
        executionRunId: "run-1",
        agentId: "codex",
      });

      expect(subscriber.getProjection("codex")!.toolCallCount).toBe(1);
      expect(subscriber.getProjection("claude")!.toolCallCount).toBe(0);
    });

    it("counts interaction prompts from their own providerId", () => {
      bus.emit({
        type: "adapter:interaction_required",
        interactionId: "i-1",
        providerId: "claude",
        question: "allow?",
        kind: "permission",
      });

      expect(subscriber.getProjection("claude")!.approvalPromptCount).toBe(1);
    });

    it("counts retries from recovery:attempt_started", () => {
      bus.emit({
        type: "recovery:attempt_started",
        agentId: "claude",
        runId: "run-1",
        attempt: 2,
        maxAttempts: 3,
        strategy: "exponential",
        timestamp: 1,
      });

      expect(subscriber.getProjection("claude")!.retryCount).toBe(1);
    });

    it("releases run state on a terminal event", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      expect(subscriber.getStats().openRuns).toBe(1);

      bus.emit({
        type: "agent:completed",
        agentId: "claude",
        runId: "run-1",
        durationMs: 5,
      });

      expect(subscriber.getStats().openRuns).toBe(0);
    });

    it("bounds tracked runs when terminal events never arrive", () => {
      const bounded = new DashboardProjectionSubscriber(bus, {
        maxTrackedRuns: 2,
      });
      bounded.start();

      for (let i = 0; i < 5; i++) {
        bus.emit({
          type: "agent:started",
          agentId: "claude",
          runId: `run-${i}`,
        });
      }

      expect(bounded.getStats().openRuns).toBe(2);
      bounded.dispose();
    });
  });

  describe("NFR-2 removal safety", () => {
    it("leaves bus traffic byte-identical whether the producer is on or off", () => {
      const withProducer = captureBusTraffic(true);
      const withoutProducer = captureBusTraffic(false);

      expect(JSON.stringify(withoutProducer)).toBe(
        JSON.stringify(withProducer)
      );
    });

    it("stops tallying after dispose", () => {
      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({
        type: "tool:called",
        toolName: "read",
        executionRunId: "run-1",
      });
      expect(subscriber.getProjection("claude")!.toolCallCount).toBe(1);

      subscriber.dispose();
      bus.emit({
        type: "tool:called",
        toolName: "read",
        executionRunId: "run-1",
      });

      // Still 1: the subscriber is detached, so the second call is invisible.
      expect(subscriber.getProjection("claude")!.toolCallCount).toBe(1);
    });

    it("is idempotent across repeated start calls", () => {
      subscriber.start();
      subscriber.start();

      bus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
      bus.emit({
        type: "tool:called",
        toolName: "read",
        executionRunId: "run-1",
      });

      // Double subscription would double-count to 2.
      expect(subscriber.getProjection("claude")!.toolCallCount).toBe(1);
    });

    it("does not throw when a run completes without ever having started", () => {
      expect(() => {
        bus.emit({
          type: "agent:completed",
          agentId: "claude",
          runId: "never-started",
          durationMs: 5,
        });
      }).not.toThrow();

      expect(subscriber.getProjection("claude")!.successRate).toBe(1);
    });
  });
});

/**
 * Emit a fixed run through a fresh bus, with and without the producer
 * attached, and capture what every other subscriber observed.
 */
function captureBusTraffic(attachProducer: boolean): DzupEvent[] {
  const localBus = createEventBus();
  const observed: DzupEvent[] = [];
  localBus.onAny((event) => observed.push(event));

  const producer = attachProducer
    ? createDashboardProjectionSubscriber(localBus)
    : null;

  localBus.emit({ type: "agent:started", agentId: "claude", runId: "run-1" });
  localBus.emit({
    type: "tool:called",
    toolName: "read",
    executionRunId: "run-1",
  });
  localBus.emit({
    type: "agent:completed",
    agentId: "claude",
    runId: "run-1",
    durationMs: 5,
    usage: { inputTokens: 10, outputTokens: 5, costCents: 1 },
  });

  producer?.dispose();
  return observed;
}
