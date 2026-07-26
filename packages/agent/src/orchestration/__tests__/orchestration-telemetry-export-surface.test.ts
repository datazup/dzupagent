/**
 * Export-surface + behaviour pin for `orchestration-telemetry.ts`.
 *
 * `recordRoutingDecision`, `recordMergeOperation`, and `recordCircuitBreakerEvent`
 * have ZERO call sites inside this package. That is documented on the module as
 * deliberate: they are opt-in, consumer-facing helpers re-exported from the
 * orchestration barrel for downstream hosts, while this package's own
 * observability flows through the `DzupEventBus` instead.
 *
 * Because "no internal callers" is exactly what dead-code sweeps look for, this
 * test makes the public-API status executable:
 *
 *  1. The three recorders must remain exported from `orchestration/index.ts`.
 *     Removing one is a BREAKING change to the package barrel and must be a
 *     deliberate decision, not a cleanup — this test fails loudly if it happens.
 *  2. Their emitted attribute keys are pinned. Downstream hosts map these dotted
 *     keys onto OTel span attributes, so renaming a key silently breaks their
 *     dashboards; the rename must be visible in a diff here.
 *
 * It also pins the distinction from `circuit-breaker-recorder.ts`, which shares
 * the "record" verb but mutates breaker STATE rather than only logging.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { defaultLogger } from "@dzupagent/core/utils";
import * as orchestrationBarrel from "../index.js";
import {
  recordRoutingDecision,
  recordMergeOperation,
  recordCircuitBreakerEvent,
} from "../orchestration-telemetry.js";

/** Capture the single debug payload a recorder emits. */
function captureDebug(run: () => void): {
  message: string;
  payload: Record<string, unknown>;
} {
  const spy = vi.spyOn(defaultLogger, "debug").mockImplementation(() => {});
  try {
    run();
    expect(spy).toHaveBeenCalledTimes(1);
    const [message, payload] = spy.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    return { message, payload };
  } finally {
    spy.mockRestore();
  }
}

describe("orchestration telemetry is public API despite having no internal callers", () => {
  it("re-exports all three recorders from the orchestration barrel", () => {
    // Guards against a dead-code sweep deleting them: they are unreferenced
    // inside this package BY DESIGN, and removing them breaks consumers.
    expect(typeof orchestrationBarrel.recordRoutingDecision).toBe("function");
    expect(typeof orchestrationBarrel.recordMergeOperation).toBe("function");
    expect(typeof orchestrationBarrel.recordCircuitBreakerEvent).toBe(
      "function"
    );
  });

  it("barrel exports are the same bindings as the module exports", () => {
    expect(orchestrationBarrel.recordRoutingDecision).toBe(
      recordRoutingDecision
    );
    expect(orchestrationBarrel.recordMergeOperation).toBe(recordMergeOperation);
    expect(orchestrationBarrel.recordCircuitBreakerEvent).toBe(
      recordCircuitBreakerEvent
    );
  });
});

describe("recorder attribute keys are a downstream contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recordRoutingDecision emits its documented OTel-style keys", () => {
    const { message, payload } = captureDebug(() =>
      recordRoutingDecision({
        taskId: "t-1",
        strategy: "rule",
        selectedAgents: ["a", "b"],
        reason: "tag match",
        candidateCount: 3,
        filteredByCircuitBreaker: 1,
      })
    );

    expect(message).toBe("[orchestration:routing]");
    expect(Object.keys(payload).sort()).toEqual([
      "orchestration.routing.candidate_count",
      "orchestration.routing.filtered_count",
      "orchestration.routing.reason",
      "orchestration.routing.selected_agents",
      "orchestration.routing.strategy",
      "orchestration.task_id",
    ]);
    // Agents are flattened to a comma-joined string, not an array.
    expect(payload["orchestration.routing.selected_agents"]).toBe("a,b");
  });

  it("recordMergeOperation emits its documented OTel-style keys", () => {
    const { message, payload } = captureDebug(() =>
      recordMergeOperation({
        strategy: "all-required",
        totalAgents: 3,
        successCount: 2,
        timeoutCount: 1,
        errorCount: 0,
        mergedStatus: "all_timeout",
      })
    );

    expect(message).toBe("[orchestration:merge]");
    expect(Object.keys(payload).sort()).toEqual([
      "orchestration.merge.error_count",
      "orchestration.merge.status",
      "orchestration.merge.strategy",
      "orchestration.merge.success_count",
      "orchestration.merge.timeout_count",
      "orchestration.merge.total_agents",
    ]);
  });

  it("recordCircuitBreakerEvent emits its documented OTel-style keys", () => {
    const { message, payload } = captureDebug(() =>
      recordCircuitBreakerEvent("agent-1", "trip", 3)
    );

    expect(message).toBe("[orchestration:circuit_breaker]");
    expect(Object.keys(payload).sort()).toEqual([
      "orchestration.circuit_breaker.agent_id",
      "orchestration.circuit_breaker.consecutive_timeouts",
      "orchestration.circuit_breaker.event",
    ]);
  });

  it("recordCircuitBreakerEvent only logs — it does not mutate breaker state", () => {
    // The documented distinction from `circuit-breaker-recorder.ts`: that module
    // decides whether a circuit trips; this one is pure observation. A breaker
    // passed nowhere near it cannot be affected, so the only observable effect
    // of calling it is exactly one log line.
    const spy = vi.spyOn(defaultLogger, "debug").mockImplementation(() => {});
    try {
      recordCircuitBreakerEvent("agent-1", "trip", 99);
      recordCircuitBreakerEvent("agent-1", "reset");
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("defaults consecutiveTimeouts to 0 when omitted", () => {
    const { payload } = captureDebug(() =>
      recordCircuitBreakerEvent("agent-1", "success")
    );
    expect(payload["orchestration.circuit_breaker.consecutive_timeouts"]).toBe(
      0
    );
  });

  it("defaults filtered_count to 0 when omitted", () => {
    const { payload } = captureDebug(() =>
      recordRoutingDecision({
        taskId: "t-2",
        strategy: "hash",
        selectedAgents: ["a"],
        reason: "hashed",
        candidateCount: 2,
      })
    );
    expect(payload["orchestration.routing.filtered_count"]).toBe(0);
  });
});
