/**
 * Tests for the TeamRuntimeEvent -> DzupEventBus bridge.
 *
 * Team lifecycle events used to reach ONLY the runtime's per-instance
 * `onEvent` callback, never the process-wide bus. Because an otel
 * `MetricMapFragment` keys off `DzupEvent['type']`, that meant no team signal
 * could drive a metric — including the `skipped` verdict and consolidation
 * signals that exist specifically to be alerted on.
 *
 * These tests pin the bridge's contract: it forwards a deliberate subset,
 * never at the cost of `onEvent`, never with unbounded strings, and never in
 * a way that a failing bus can turn into a failed run.
 */
import { describe, expect, it, vi } from "vitest";
import { bridgeTeamEventsToBus } from "../team-runtime-bus-bridge.js";
import type { TeamRuntimeEvent } from "../team-runtime-events.js";

type BusEvent = { type: string } & Record<string, unknown>;

function fakeBus(): { emitted: BusEvent[]; emit: (e: BusEvent) => void } {
  const emitted: BusEvent[] = [];
  return { emitted, emit: (e) => emitted.push(e) };
}

/** Drive one team event through the bridge and return what reached the bus. */
function forward(event: TeamRuntimeEvent): BusEvent[] {
  const bus = fakeBus();
  const emit = bridgeTeamEventsToBus(() => {}, bus as never, "council");
  emit(event);
  return bus.emitted;
}

const AT = new Date("2026-07-29T00:00:00.000Z");

describe("bridgeTeamEventsToBus", () => {
  it("returns the emitter unchanged when no bus is wired", () => {
    const onEvent = vi.fn();
    // Identity, not a wrapper: the unobserved path keeps its exact previous
    // behaviour and cost.
    expect(bridgeTeamEventsToBus(onEvent, undefined, "council")).toBe(onEvent);
  });

  it("still delivers to onEvent when a bus is wired", () => {
    const onEvent = vi.fn();
    const bus = fakeBus();
    const emit = bridgeTeamEventsToBus(onEvent, bus as never, "council");
    const event: TeamRuntimeEvent = {
      type: "team_completed",
      teamId: "t",
      runId: "r",
      durationMs: 5,
      at: AT,
    };

    emit(event);

    // Bridging is additive — the host observer must not lose events to it.
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(event);
    expect(bus.emitted).toHaveLength(1);
  });

  it("forwards a completed run with its pattern and duration", () => {
    expect(
      forward({
        type: "team_completed",
        teamId: "t",
        runId: "r",
        durationMs: 42,
        at: AT,
      })
    ).toEqual([
      {
        type: "team:completed",
        teamId: "t",
        runId: "r",
        coordinatorPattern: "council",
        durationMs: 42,
      },
    ]);
  });

  it("drops the free-form error message from a failed run", () => {
    const [event] = forward({
      type: "team_failed",
      teamId: "t",
      runId: "r",
      error: "some unbounded message with a uuid 9f3c...",
      at: AT,
    });

    // Anything forwarded here is a candidate metric label; an error string is
    // unbounded and must not become one.
    expect(event).toEqual({
      type: "team:failed",
      teamId: "t",
      runId: "r",
      coordinatorPattern: "council",
    });
    expect(event).not.toHaveProperty("error");
  });

  it("forwards a scored verdict with its score", () => {
    expect(
      forward({
        type: "team_verdict_evaluated",
        teamId: "t",
        runId: "r",
        gate: "evaluation",
        outcome: "passed",
        score: 0.87,
        at: AT,
      })
    ).toEqual([
      {
        type: "team:verdict_evaluated",
        teamId: "t",
        runId: "r",
        gate: "evaluation",
        outcome: "passed",
        score: 0.87,
      },
    ]);
  });

  it("preserves the absence of a score on a skipped verdict", () => {
    const [event] = forward({
      type: "team_verdict_evaluated",
      teamId: "t",
      runId: "r",
      gate: "governance",
      outcome: "skipped",
      at: AT,
    });

    // A fabricated 0 or 1 would be averaged in by dashboards as though a real
    // gate had produced it.
    expect(event).not.toHaveProperty("score");
    expect(event).toMatchObject({ outcome: "skipped", gate: "governance" });
  });

  it("forwards the skip reason on a skipped verdict", () => {
    // Dropping `reason` here would collapse "a wired judge is failing" back
    // into "nobody wired a gate" at the bus boundary, silently undoing the
    // distinction downstream alerts route on. Nothing else catches that: the
    // metric would still be emitted, just permanently mislabelled.
    for (const reason of ["unwired", "scorer_failed"] as const) {
      expect(
        forward({
          type: "team_verdict_evaluated",
          teamId: "t",
          runId: "r",
          gate: "governance",
          outcome: "skipped",
          reason,
          at: AT,
        })
      ).toEqual([
        {
          type: "team:verdict_evaluated",
          teamId: "t",
          runId: "r",
          gate: "governance",
          outcome: "skipped",
          reason,
        },
      ]);
    }
  });

  it("omits reason entirely on a scored verdict", () => {
    // passed/rejected genuinely have no reason — the gate ran. Emitting one
    // would imply a skip that did not happen.
    const [event] = forward({
      type: "team_verdict_evaluated",
      teamId: "t",
      runId: "r",
      gate: "evaluation",
      outcome: "passed",
      score: 0.9,
      at: AT,
    });
    expect(event).not.toHaveProperty("reason");
  });

  it("forwards consolidation skips with their reason", () => {
    for (const reason of ["unwired", "failed"] as const) {
      expect(
        forward({
          type: "team_consolidation_skipped",
          teamId: "t",
          runId: "r",
          namespace: "t",
          reason,
          ...(reason === "failed" ? { error: "store unreachable" } : {}),
          at: AT,
        })
      ).toEqual([
        {
          type: "team:consolidation_skipped",
          teamId: "t",
          runId: "r",
          reason,
        },
      ]);
    }
  });

  it("does not forward per-participant or phase events", () => {
    // These fire once per participant per run; bridging them would multiply bus
    // traffic by team size for a debugging signal, not a fleet metric.
    const unbridged: TeamRuntimeEvent[] = [
      {
        type: "phase_changed",
        teamId: "t",
        runId: "r",
        from: "initializing",
        to: "planning",
        at: AT,
      },
      {
        type: "participant_started",
        teamId: "t",
        runId: "r",
        participantId: "p",
        role: "worker",
        at: AT,
      },
      {
        type: "participant_completed",
        teamId: "t",
        runId: "r",
        participantId: "p",
        role: "worker",
        success: true,
        durationMs: 1,
        at: AT,
      },
      {
        type: "team_consolidation_completed",
        teamId: "t",
        runId: "r",
        namespace: "t",
        at: AT,
      },
    ];

    for (const event of unbridged) {
      expect(forward(event), `${event.type} must not reach the bus`).toEqual(
        []
      );
    }
  });

  it("does not let a throwing bus fail the run", () => {
    const onEvent = vi.fn();
    const bus = {
      emit: () => {
        throw new Error("bus down");
      },
    };
    const emit = bridgeTeamEventsToBus(onEvent, bus as never, "council");

    // These signals are emitted from reporting-only paths — including a
    // non-fatal catch block — that are contractually not allowed to fail.
    expect(() =>
      emit({
        type: "team_consolidation_skipped",
        teamId: "t",
        runId: "r",
        namespace: "t",
        reason: "failed",
        at: AT,
      })
    ).not.toThrow();
    expect(onEvent).toHaveBeenCalledOnce();
  });
});
