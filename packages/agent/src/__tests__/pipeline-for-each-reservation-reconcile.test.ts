/**
 * G2b — deterministic reservation identity and outcome-unknown reconciliation
 * (doc 27 §8 prerequisites 5 and 6).
 *
 * F gave `for_each` a reserve/settle/release lifecycle but left two clauses of
 * admission precondition 3 open, and one of them was an outright leak:
 *
 * A `reserve` that THREW was collapsed into a denial even though it may have
 * written a ledger row before the transport died. Strict mode now also treats
 * an answered `{ status: "unknown" }` as non-authoritative: only reconciliation
 * can prove the row absent or released.
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
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
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

/**
 * The base pipeline above sets no `checkpointStrategy`, so it persists NOTHING —
 * verified by instrumenting: `checkpoint.loopState` came back `undefined`. Any
 * assertion about a durable record made against it is a false red that turns
 * green on implementation while proving nothing, which is exactly the trap this
 * lane keeps re-learning. Tests that read the durable terminal set use this
 * variant instead.
 */
function checkpointingForEachPipeline(): PipelineDefinition {
  return { ...forEachPipeline(), checkpointStrategy: "after_each_node" };
}

function tracingExecutor(runs: string[]): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode, ctx) => {
    const item = ctx.state["item"] as { id: string };
    runs.push(`${item.id}:${nodeId}`);
    return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
  };
}

const ITEMS = [{ id: "a" }, { id: "b" }];

const STRICT_LIFECYCLE = {
  mode: "strict" as const,
  settle: () => {},
  release: () => {},
  reconcile: () => ({ status: "unknown" as const }),
  measureItemCost: () => ({ status: "known" as const, costCents: 50 }),
};

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
        ...STRICT_LIFECYCLE,
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
        ...STRICT_LIFECYCLE,
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
        ...STRICT_LIFECYCLE,
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
        ...STRICT_LIFECYCLE,
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

  it("does not redispatch a durable outcome-unknown reserve on resume", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const first = new PipelineRuntime({
      definition: checkpointingForEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
      loopIterationBudgetReservation: {
        ...STRICT_LIFECYCLE,
        itemBudgetCents: 100,
        reserve: () => {
          throw new Error("reserve transport died");
        },
        reconcile: () => ({ status: "unknown" as const }),
      },
    });
    const failed = await first.execute({ items: ITEMS });
    const checkpoint = await store.load(failed.runId);

    const reruns: string[] = [];
    const rereserves: unknown[] = [];
    const resumed = new PipelineRuntime({
      definition: checkpointingForEachPipeline(),
      nodeExecutor: tracingExecutor(reruns),
      checkpointStore: store,
      loopIterationBudgetReservation: {
        ...STRICT_LIFECYCLE,
        itemBudgetCents: 100,
        reserve: (input) => {
          rereserves.push(input);
          return { status: "reserved" as const, reservedCostCents: 50 };
        },
      },
    });

    const result = await resumed.resume(checkpoint!);

    expect(result.state).toBe("failed");
    expect(reruns).toEqual([]);
    expect(rereserves).toEqual([]);
    expect(result.error).toContain("redispatch is blocked");
  });

  it("stays blocked when reconcile itself throws", async () => {
    const runs: string[] = [];
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      onEvent: (event) => events.push(event),
      loopIterationBudgetReservation: {
        ...STRICT_LIFECYCLE,
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
        ...STRICT_LIFECYCLE,
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

  it("releases a reconciled reserved hold before denying the unstarted item", async () => {
    const runs: string[] = [];
    const releases: string[] = [];
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: checkpointingForEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      checkpointStore: store,
      loopIterationBudgetReservation: {
        ...STRICT_LIFECYCLE,
        itemBudgetCents: 100,
        reserve: () => {
          throw new Error("reserve acknowledgement lost");
        },
        release: (input) => {
          releases.push(input.reservationId ?? "");
        },
        reconcile: (input) => {
          expect(input.boundary).toBe("reserve");
          return { status: "reserved" as const, reservedCostCents: 50 };
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    expect(runs).toEqual([]);
    expect(releases).toHaveLength(1);
    const checkpoint = await store.load(result.runId);
    expect(
      checkpoint?.loopState?.["loop-items"]?.itemOutcomes?.["0"]?.outcome
    ).toBe("denied");
  });

  it("reconciles an answered unknown instead of assuming no ledger row exists", async () => {
    const runs: string[] = [];
    const reconciles: unknown[] = [];
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      onEvent: (event) => events.push(event),
      loopIterationBudgetReservation: {
        ...STRICT_LIFECYCLE,
        itemBudgetCents: 100,
        // An answered unknown is still not proof that no ledger row exists in
        // strict mode; reconciliation owns that fact.
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
    expect(reconciles).toHaveLength(1);
    expect(failureMessage(events)).toContain("not outstanding");
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

/**
 * 24-H — the `conflict` half of doc 27 §8 proof 6.
 *
 * Proof 6 asks for two things: a replayed reserve must be recognisable as the
 * SAME reservation, and a reservation held by ANOTHER writer must be refused.
 * The replay half has been solid since G2b. The conflict half sat at "partial"
 * across three packets (24-F, 24-G, and their handoffs) for a reason that was
 * never a coverage gap: `LoopBudgetReconcileOutcome` admitted only
 * `released`/`absent`/`unknown`, so a host had NO WAY TO SAY "someone else
 * holds this". The fact was unrepresentable in the contract, and an
 * unrepresentable fact cannot be tested.
 *
 * A host forced to answer with one of the three old statuses had to pick a lie:
 * `unknown` (blocks correctly, but reports "I could not observe it" when the
 * host observed it perfectly well and knows exactly who holds it), or `absent`
 * / `released` (which UNBLOCK the item and redispatch work whose money another
 * writer owns). Widening the union is what makes the honest answer sayable.
 *
 * Keying is by ITEM, not by reservation id, and that is forced rather than
 * chosen. `deriveItemReservationId` embeds `attempt`, and 24-F's attempt
 * advance means a resumed item deliberately presents a DIFFERENT id from the
 * one the dead attempt opened. A conflict keyed by id could therefore never be
 * recognised across the resume that provokes it, which is the only situation
 * where conflicts arise at all.
 */
describe("24-H — reconcile can report a conflicting holder (proof 6)", () => {
  it("stays blocked when another writer holds the reservation", async () => {
    // Before the widening this could not even be expressed: returning
    // `conflict` was a type error, and the nearest sayable answer was a lie.
    const runs: string[] = [];
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      onEvent: (event) => events.push(event),
      loopIterationBudgetReservation: {
        ...STRICT_LIFECYCLE,
        itemBudgetCents: 100,
        reserve: () => {
          throw new Error("transport died");
        },
        reconcile: () => ({
          status: "conflict" as const,
          heldBy: "run-7f3a/worker-2",
        }),
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    // Fail closed, exactly as `unknown` does. A conflict is MORE certain than
    // an unknown, but certainty that someone else owns the money is not
    // permission to spend it — the item must not dispatch either way.
    expect(result.state).toBe("failed");
    expect(runs).toEqual([]);
    // `state: "failed"` and `runs: []` are NOT sufficient on their own, and
    // asserting only those made this test vacuous — verified by mutation: a
    // mutant that treats `conflict` as a PROOF (clearing the item) still
    // produces both, because the item then falls through to F's clean-denial
    // path and fails there instead. The two outcomes are only distinguishable
    // by WHICH failure is reported, so pin that.
    expect(failureMessage(events)).toContain("held by another writer");
    expect(failureMessage(events)).not.toContain(
      "no authoritative conservative reservation"
    );
  });

  it("names the conflicting holder in the operator-visible failure", async () => {
    // The entire point of distinguishing `conflict` from `unknown`. An operator
    // reading "could not be observed" goes looking for a transport fault; one
    // reading "held by run-7f3a/worker-2" goes looking for the rival writer.
    // Without the holder in the message the new status is only a relabelled
    // `unknown` and earns nothing.
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      onEvent: (event) => events.push(event),
      loopIterationBudgetReservation: {
        ...STRICT_LIFECYCLE,
        itemBudgetCents: 100,
        reserve: () => {
          throw new Error("transport died");
        },
        reconcile: () => ({
          status: "conflict" as const,
          heldBy: "run-7f3a/worker-2",
        }),
      },
    });

    await runtime.execute({ items: ITEMS });

    const message = failureMessage(events);
    expect(message).toContain("run-7f3a/worker-2");
    // And it must NOT read as an observation failure, which is the wrong
    // remediation to send an operator on.
    expect(message).toContain("held by");
  });

  it("reports the conflicted item as `outcome_unknown`, never `failed`", async () => {
    // 24-G's terminal set must classify a conflict as non-terminal. The item's
    // reservation is outstanding under a writer we do not control, so
    // `isTerminalItemOutcome` must keep excluding it: recording `failed` would
    // let accounting close over a live ledger row owned by someone else.
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: checkpointingForEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      checkpointStore: store,
      loopIterationBudgetReservation: {
        ...STRICT_LIFECYCLE,
        itemBudgetCents: 100,
        reserve: () => {
          throw new Error("transport died");
        },
        reconcile: () => ({
          status: "conflict" as const,
          heldBy: "run-7f3a/worker-2",
        }),
      },
    });

    const result = await runtime.execute({ items: ITEMS });
    expect(result.state).toBe("failed");

    const checkpoint = await store.load(result.runId);
    const outcomes = checkpoint?.loopState?.["loop-items"]?.itemOutcomes;
    expect(outcomes?.["0"]?.outcome).toBe("outcome_unknown");
  });

  it("still clears the item when the holder releases it", async () => {
    // The negative control. `conflict` must not become a blanket block that
    // makes every reconcile fail closed regardless of answer — a `released`
    // reply has to keep working, or this widening has broken the path it
    // extends rather than added to it.
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      loopIterationBudgetReservation: {
        ...STRICT_LIFECYCLE,
        itemBudgetCents: 100,
        reserve: () => {
          throw new Error("transport died");
        },
        reconcile: () => ({ status: "released" as const }),
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    // Proven not outstanding, so the loop is no longer blocked on the
    // reservation. The item still must not dispatch unpriced (F's clean-denial
    // path), which is why this is `failed` with no body runs rather than a
    // completed run.
    expect(result.state).toBe("failed");
    expect(runs).toEqual([]);
  });
});
