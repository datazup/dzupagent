/**
 * G2b — deterministic reservation identity and outcome-unknown reconciliation
 * (doc 27 §8 prerequisites 5 and 6).
 *
 * F gave `for_each` a reserve/settle/release lifecycle but left two clauses of
 * admission precondition 3 open, and one of them was an outright leak:
 *
 * A `reserve` that THREW was collapsed into the same branch as a host that
 * *answered* `{ status: "unknown" }`. Those are not the same fact. An answered
 * unknown means the host holds nothing. A thrown reserve may have written a
 * ledger row before the transport died — so the reservation's existence is
 * genuinely unknown, and the pre-G2b runtime issued no release for it, ever.
 * Verified against the pre-G2b tree: releases came back `[]`.
 *
 * Prereq 6 requires that case be treated as outcome-unknown — block release and
 * redispatch until reconciliation proves the outcome. Prereq 5 requires a
 * deterministic reservation ID so a host can correlate, and so a replayed
 * reserve is recognisable as the SAME reservation rather than a second one.
 *
 * Surface note (carried from F): a mid-run guard fails the RUN
 * (`state: "failed"`); it does not reject. Every fail-closed assertion below
 * checks `result.state` AND that nothing further executed.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { deriveItemReservationId } from "../pipeline/loop-executor/for-each-loop.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

function forEachPipeline(): PipelineDefinition {
  return {
    id: "for-each-reconcile",
    name: "ForEachReconcile",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "loop-items",
    nodes: [
      {
        id: "loop-items",
        type: "loop",
        bodyNodeIds: ["step-a", "step-b"],
        maxIterations: 1000,
        continuePredicateName: "forEach__item__predicate",
        forEach: {
          source: "$.items",
          as: "item",
          order: "input",
          concurrency: 1,
          empty: { body: "skip", aggregate: "empty-array" },
        },
      },
      { id: "step-a", type: "agent", agentId: "a", timeoutMs: 5000 },
      { id: "step-b", type: "agent", agentId: "b", timeoutMs: 5000 },
    ],
    edges: [],
  };
}

function tracingExecutor(runs: string[]): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode, ctx) => {
    const item = ctx.state["item"] as { id: string };
    runs.push(`${item.id}:${nodeId}`);
    return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
  };
}

const ITEMS = [{ id: "a" }, { id: "b" }];

/**
 * The failure message surfaces on the `pipeline:failed` runtime event, not on
 * `PipelineRunResult` — this fail-closed path leaves `result.error` undefined
 * and `nodeResults` empty, which is pre-existing behaviour shared with F's
 * denial path (verified against the F-era tree, not assumed).
 *
 * Events are colon-delimited; a wrong name yields `undefined`, and
 * `JSON.stringify(undefined)` makes `toContain` THROW rather than fail
 * meaningfully. So capture the event and assert it exists before matching.
 */
function failureMessage(events: { type: string; error?: string }[]): string {
  const failed = events.find((event) => event.type === "pipeline:failed");
  expect(failed, "no pipeline:failed event was emitted").toBeDefined();
  expect(failed?.error, "pipeline:failed carried no error").toBeTypeOf(
    "string"
  );
  return failed?.error as string;
}

describe("G2b — deterministic reservation ID (prereq 5)", () => {
  it("derives a stable id for the same item attempt", () => {
    const first = deriveItemReservationId({
      runId: "run-1",
      loopNodeId: "loop-items",
      itemIndex: 3,
      attempt: 0,
    });
    const replayed = deriveItemReservationId({
      runId: "run-1",
      loopNodeId: "loop-items",
      itemIndex: 3,
      attempt: 0,
    });
    // Determinism is the whole point: a reserve replayed after a crash must
    // present the identical id so the host does not open a second reservation.
    expect(replayed).toBe(first);
    expect(first).toBe("resv:v1:run-1:item:loop-items:3");
  });

  it("distinguishes item, loop, run, and attempt", () => {
    const base = {
      runId: "run-1",
      loopNodeId: "loop-items",
      itemIndex: 3,
      attempt: 0,
    };
    // Vary exactly ONE dimension at a time, holding the rest fixed, so each
    // assertion pins that dimension rather than passing incidentally.
    expect(deriveItemReservationId({ ...base, itemIndex: 4 })).not.toBe(
      deriveItemReservationId(base)
    );
    expect(deriveItemReservationId({ ...base, runId: "run-2" })).not.toBe(
      deriveItemReservationId(base)
    );
    expect(deriveItemReservationId({ ...base, loopNodeId: "other" })).not.toBe(
      deriveItemReservationId(base)
    );
    // A re-dispatch is a DIFFERENT reservation from the first attempt.
    expect(deriveItemReservationId({ ...base, attempt: 1 })).toBe(
      "resv:v1:run-1:item:loop-items:3:attempt:1"
    );
  });

  it("omits the attempt segment at attempt 0, mirroring the E2 key", () => {
    // Matches `scopeSegment`'s rule exactly: a first attempt keeps the shortest
    // form rather than gaining an `:attempt:0` tail.
    expect(
      deriveItemReservationId({
        runId: "r",
        loopNodeId: "l",
        itemIndex: 0,
        attempt: 0,
      })
    ).not.toContain("attempt");
  });

  it("presents the same id to reserve and to settle", async () => {
    const reserves: { reservationId?: string }[] = [];
    const settles: { reservationId?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: (input) => {
          reserves.push(input);
          return { status: "reserved" as const, reservedCostCents: 50 };
        },
        settle: (input) => {
          settles.push(input);
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("completed");
    // A settle the host cannot correlate to its reserve is useless; pin that
    // the SAME id crosses both calls, and that the two items differ.
    expect(reserves[0]?.reservationId).toBeDefined();
    expect(settles[0]?.reservationId).toBe(reserves[0]?.reservationId);
    expect(settles[1]?.reservationId).toBe(reserves[1]?.reservationId);
    expect(reserves[0]?.reservationId).not.toBe(reserves[1]?.reservationId);
  });

  it("presents the same id to reserve and to release on a failure path", async () => {
    const reserves: { reservationId?: string }[] = [];
    const releases: { reservationId?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: async (nodeId: string, _node: PipelineNode, ctx) => {
        const item = ctx.state["item"] as { id: string };
        if (item.id === "a" && nodeId === "step-b") {
          throw new Error("simulated body failure");
        }
        return { nodeId, output: "ok", durationMs: 1 };
      },
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: (input) => {
          reserves.push(input);
          return { status: "reserved" as const, reservedCostCents: 50 };
        },
        release: (input) => {
          releases.push(input);
        },
      },
    });

    await runtime.execute({ items: ITEMS });

    expect(releases).toHaveLength(1);
    expect(releases[0]?.reservationId).toBe(reserves[0]?.reservationId);
  });
});

describe("G2b — outcome-unknown reconciliation (prereq 6)", () => {
  it("blocks the item closed when reserve throws and no reconcile exists", async () => {
    const runs: string[] = [];
    const releases: unknown[] = [];
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      onEvent: (event) => events.push(event),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => {
          throw new Error("transport died after the ledger write");
        },
        release: (input) => {
          releases.push(input);
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    // Redispatch is blocked: nothing executed, and item 1 never even reserved.
    expect(runs).toEqual([]);
    // Release is ALSO blocked — this is the half that distinguishes prereq 6
    // from an ordinary denial. Releasing blind would return money the host may
    // never have taken. This is the exact leak verified on the pre-G2b tree.
    expect(releases).toEqual([]);
    expect(failureMessage(events)).toContain("outcome-unknown");
  });

  it("stays blocked when reconcile cannot prove the outcome", async () => {
    const runs: string[] = [];
    const reconciles: { reservationId: string; reason: string }[] = [];
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      onEvent: (event) => events.push(event),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => {
          throw new Error("transport died");
        },
        reconcile: (input) => {
          reconciles.push(input);
          return { status: "unknown" as const };
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    expect(runs).toEqual([]);
    // Reconciliation was attempted and carried the identity plus the cause...
    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]?.reservationId).toContain("item:loop-items:0");
    expect(reconciles[0]?.reason).toContain("transport died");
    // ...but an `unknown` answer is not a proof, so the item stays blocked.
    expect(failureMessage(events)).toContain("outcome-unknown");
  });

  it("stays blocked when reconcile itself throws", async () => {
    const runs: string[] = [];
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      onEvent: (event) => events.push(event),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => {
          throw new Error("transport died");
        },
        reconcile: () => {
          throw new Error("reconcile transport also died");
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    // A reconcile that fails proves nothing — it must not be read as a clear.
    expect(result.state).toBe("failed");
    expect(runs).toEqual([]);
    expect(failureMessage(events)).toContain("reconciliation failed");
  });

  it.each([["released"], ["absent"]] as const)(
    'accepts "%s" as proof that nothing is outstanding',
    async (status) => {
      const runs: string[] = [];
      const events: { type: string; error?: string }[] = [];
      const runtime = new PipelineRuntime({
        definition: forEachPipeline(),
        nodeExecutor: tracingExecutor(runs),
        onEvent: (event) => events.push(event),
        loopIterationBudgetReservation: {
          itemBudgetCents: 100,
          reserve: () => {
            throw new Error("transport died");
          },
          reconcile: () => ({ status }),
        },
      });

      const result = await runtime.execute({ items: ITEMS });

      // Proof clears the OUTCOME-UNKNOWN state, but the item is still unpriced,
      // so it must not dispatch. The distinction is in the message: no longer
      // blocked on an unresolved reservation.
      expect(result.state).toBe("failed");
      expect(runs).toEqual([]);
      const message = failureMessage(events);
      expect(message).toContain("not outstanding");
      expect(message).not.toContain("outcome-unknown");
    }
  );

  it("does not consult reconcile when the host cleanly answers unknown", async () => {
    const runs: string[] = [];
    const reconciles: unknown[] = [];
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      onEvent: (event) => events.push(event),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        // ANSWERED unknown — the host holds nothing. This is a clean denial and
        // must keep its pre-G2b behaviour, not become an outcome-unknown block.
        reserve: () => ({ status: "unknown" as const }),
        reconcile: () => {
          reconciles.push(true);
          return { status: "absent" as const };
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    expect(runs).toEqual([]);
    expect(reconciles).toEqual([]);
    expect(failureMessage(events)).toContain(
      "no authoritative conservative reservation"
    );
  });

  it("leaves a reserve-only host on exactly its pre-G2b behaviour", async () => {
    const runs: string[] = [];
    const reserves: unknown[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      // The shape every pre-G2b host has on disk: reserve only, no ceiling.
      loopIterationBudgetReservation: {
        reserve: (input) => {
          reserves.push(input);
          return { status: "reserved", reservedCostCents: 8 };
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("completed");
    expect(runs).toHaveLength(4);
    expect(reserves).toEqual([]);
  });
});
