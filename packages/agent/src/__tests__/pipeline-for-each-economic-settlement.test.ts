/**
 * F — `for_each` per-item economic settlement (defect 7).
 *
 * The pre-F reservation contract had `reserve` and nothing else: an
 * over-reservation was never returned, a failed iteration leaked its
 * reservation entirely, and `for_each` never reserved at all. These tests pin
 * the lifecycle on each of `runIteration`'s THREE distinct exits separately —
 * success, body error, and abort — because a settle path that is never called
 * is the failure mode this packet is most likely to ship.
 *
 * Note on surfaces: a mid-run guard fails the RUN (`state: "failed"`), it does
 * not reject — `pipeline-runtime.ts` translates any throw out of the graph walk
 * into a failed `PipelineRunResult`. So every fail-closed assertion below
 * checks `result.state` AND that nothing further executed.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";
import type { LoopBudgetHost } from "../pipeline/loop-executor.js";

/** A for_each loop whose body is two sequential nodes. */
function forEachPipeline(): PipelineDefinition {
  return {
    id: "for-each-settlement",
    name: "ForEachSettlement",
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

function tracingExecutor(
  runs: string[],
  failOn?: { item: string; nodeId: string }
): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode, ctx) => {
    const item = ctx.state["item"] as { id: string };
    runs.push(`${item.id}:${nodeId}`);
    if (failOn && item.id === failOn.item && nodeId === failOn.nodeId) {
      throw new Error(`simulated failure at ${item.id}/${nodeId}`);
    }
    return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
  };
}

const ITEMS = [{ id: "a" }, { id: "b" }];

/** Records every lifecycle call the host receives, in order. */
function recordingHost(options?: {
  reservedCostCents?: number;
  costPerNode?: number;
}) {
  const reserves: unknown[] = [];
  const settles: unknown[] = [];
  const releases: unknown[] = [];
  return {
    reserves,
    settles,
    releases,
    config: {
      mode: "strict" as const,
      itemBudgetCents: 100,
      reserve: (input: unknown) => {
        reserves.push(input);
        return {
          status: "reserved" as const,
          reservedCostCents: options?.reservedCostCents ?? 50,
        };
      },
      settle: (input: unknown) => {
        settles.push(input);
      },
      release: (input: unknown) => {
        releases.push(input);
      },
      reconcile: () => ({ status: "unknown" as const }),
      measureItemCost: (input: {
        bodyResults: Readonly<Record<string, unknown>>;
      }) => ({
        status: "known" as const,
        costCents:
          options?.costPerNode === undefined
            ? (options?.reservedCostCents ?? 50)
            : options.costPerNode * Object.keys(input.bodyResults).length,
      }),
    },
  };
}

describe("for_each per-item economic settlement (F)", () => {
  it("reserves once per item, not once per iteration or body node", async () => {
    const host = recordingHost();
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      loopIterationBudgetReservation: host.config,
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("completed");
    // Two items x two body nodes = four dispatches, but only TWO reservations.
    expect(runs).toHaveLength(4);
    expect(host.reserves).toHaveLength(2);
    expect(host.reserves[0]).toMatchObject({
      loopNodeId: "loop-items",
      itemIndex: 0,
      budgetCents: 100,
      bodyNodeIds: ["step-a", "step-b"],
    });
    // Item identity, not just an ordinal, distinguishes the two reservations.
    expect(host.reserves[1]).toMatchObject({ itemIndex: 1 });
  });

  // --- Exit 1 of 3: the item completes successfully. ---
  it("settles every completed item against its reservation", async () => {
    const host = recordingHost({ reservedCostCents: 50, costPerNode: 10 });
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor([]),
      loopIterationBudgetReservation: host.config,
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("completed");
    expect(host.settles).toHaveLength(2);
    expect(host.releases).toEqual([]);
    // Two body nodes at 10c each settles 20c of a 50c reservation, so 30c is
    // the delta the host can return. Pinned exactly, not with expect.anything.
    expect(host.settles[0]).toMatchObject({
      itemIndex: 0,
      reservedCostCents: 50,
      actualCostCents: 20,
    });
    expect(host.settles[1]).toMatchObject({
      itemIndex: 1,
      actualCostCents: 20,
    });
  });

  // --- Exit 2 of 3: a body node fails. ---
  it("releases rather than settles when a body node fails", async () => {
    const host = recordingHost();
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      // Item 'a' fails on its SECOND body node: the reservation is already
      // held, which is precisely the leak the pre-F contract could not fix.
      nodeExecutor: tracingExecutor(runs, { item: "a", nodeId: "step-b" }),
      loopIterationBudgetReservation: host.config,
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    // A plain body failure is NOT a budget breach: with `failFast` unset the
    // loop legitimately continues to item 1, which reserves and settles
    // normally. Packet F must not change that pre-existing semantics.
    expect(host.reserves).toHaveLength(2);
    // The FAILED item is released in full and never settled — that is the
    // leak the pre-F contract could not fix.
    expect(host.releases).toHaveLength(1);
    expect(host.releases[0]).toMatchObject({
      itemIndex: 0,
      reservedCostCents: 50,
      reason: "failed",
    });
    // ...and the surviving item settles, so exactly one of the two items is
    // reconciled on each path. No reservation is left outstanding.
    expect(host.settles).toHaveLength(1);
    expect(host.settles[0]).toMatchObject({ itemIndex: 1 });
  });

  // --- Exit 3 of 3: the run is aborted mid-item. ---
  it('releases with reason "aborted" when the signal aborts mid-item', async () => {
    const host = recordingHost();
    const controller = new AbortController();
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      signal: controller.signal,
      nodeExecutor: async (nodeId: string, _node: PipelineNode, ctx) => {
        const item = ctx.state["item"] as { id: string };
        // Abort after the first body node of the first item, so a reservation
        // is outstanding when the abort is observed.
        if (item.id === "a" && nodeId === "step-a") controller.abort();
        return { nodeId, output: "ok", durationMs: 1 };
      },
      loopIterationBudgetReservation: host.config,
    });

    await runtime.execute({ items: ITEMS });

    expect(host.reserves).toHaveLength(1);
    expect(host.settles).toEqual([]);
    expect(host.releases).toHaveLength(1);
    expect(host.releases[0]).toMatchObject({
      itemIndex: 0,
      reservedCostCents: 50,
      reason: "aborted",
    });
  });

  // --- The operator's money-semantics decision (08-16): fail closed. ---
  it("fails the loop closed when a settle overruns its reservation", async () => {
    // 2 body nodes x 40c = 80c actual against a 50c reservation.
    const host = recordingHost({ reservedCostCents: 50, costPerNode: 40 });
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      loopIterationBudgetReservation: host.config,
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    // The overrunning item IS settled — the money was really spent, so the
    // host must learn the true amount; the loop stops afterwards.
    expect(host.settles).toHaveLength(1);
    expect(host.settles[0]).toMatchObject({
      itemIndex: 0,
      actualCostCents: 80,
      reservedCostCents: 50,
    });
    // Fail-closed means item 1 never dispatches at all.
    expect(runs).toEqual(["a:step-a", "a:step-b"]);
    expect(host.reserves).toHaveLength(1);
  });

  it("fails closed when the ceiling is authored but no reservation is authoritative", async () => {
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      loopIterationBudgetReservation: {
        mode: "strict",
        itemBudgetCents: 100,
        reserve: () => ({ status: "unknown" as const }),
        settle: () => {},
        release: () => {},
        reconcile: () => ({ status: "unknown" as const }),
        measureItemCost: () => ({ status: "known" as const, costCents: 0 }),
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    // An unpriced item must not spend: nothing executed at all.
    expect(runs).toEqual([]);
  });

  it("fails closed when a reservation exceeds the authored ceiling", async () => {
    const runs: string[] = [];
    const releases: unknown[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      loopIterationBudgetReservation: {
        mode: "strict",
        itemBudgetCents: 100,
        reserve: () => ({
          status: "reserved" as const,
          reservedCostCents: 101,
        }),
        settle: () => {},
        release: (input) => {
          releases.push(input);
        },
        reconcile: () => ({ status: "unknown" as const }),
        measureItemCost: () => ({ status: "known" as const, costCents: 0 }),
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    expect(runs).toEqual([]);
    expect(releases).toHaveLength(1);
  });

  it.each([Number.NaN, -1, 1.5])(
    "blocks malformed reserved cost %s even when reconcile reports absent",
    async (reservedCostCents) => {
      const runs: string[] = [];
      const runtime = new PipelineRuntime({
        definition: forEachPipeline(),
        nodeExecutor: tracingExecutor(runs),
        loopIterationBudgetReservation: {
          mode: "strict",
          itemBudgetCents: 100,
          reserve: () => ({
            status: "reserved" as const,
            reservedCostCents,
          }),
          settle: () => {},
          release: () => {},
          reconcile: () => ({ status: "absent" as const }),
          measureItemCost: () => ({ status: "known" as const, costCents: 0 }),
        },
      });

      const result = await runtime.execute({ items: ITEMS });

      expect(result.state).toBe("failed");
      expect(result.error).toContain("malformed");
      expect(runs).toEqual([]);
    }
  );

  // --- Backward compatibility: widening must not break reserve-only hosts. ---
  it("leaves a reserve-only host on exactly its pre-F behaviour", async () => {
    const reserves: unknown[] = [];
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      // No settle, no release, and crucially no itemBudgetCents — this is the
      // shape every pre-F host has on disk today.
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
    // Absent an authored per-item ceiling, for_each takes NO reservation —
    // degrading to today's behaviour rather than failing closed.
    expect(reserves).toEqual([]);
  });

  it("fails closed when an untyped ceiling host omits strict settlement", async () => {
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => ({ status: "reserved" as const, reservedCostCents: 50 }),
      } as unknown as LoopBudgetHost,
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    expect(runs).toEqual([]);
  });

  it.each([
    ["unknown", { status: "unknown" as const, reason: "provider omitted usage" }],
    ["non-finite", { status: "known" as const, costCents: Number.NaN }],
  ])("fails closed on %s strict settlement cost instead of charging zero", async (_case, cost) => {
    const settles: unknown[] = [];
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: tracingExecutor(runs),
      loopIterationBudgetReservation: {
        mode: "strict",
        itemBudgetCents: 100,
        reserve: () => ({ status: "reserved" as const, reservedCostCents: 50 }),
        settle: (input) => {
          settles.push(input);
        },
        release: () => {},
        reconcile: () => ({ status: "unknown" as const }),
        measureItemCost: () => cost,
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    expect(runs).toEqual(["a:step-a", "a:step-b"]);
    expect(settles).toEqual([]);
    expect(result.error).toMatch(/usage\/cost is unknown/);
  });
});
