/**
 * Result-surface repair: a failed run must say WHY on the run result.
 *
 * Before this, every failure path emitted its reason on the `pipeline:failed`
 * event and then dropped it: `PipelineRunResult` had no `error` field at all.
 * A caller holding the run result could see THAT a run failed but not why, and
 * a caller that does not subscribe to the event bus had no way to recover the
 * reason. That is worst for fail-closed denials — a `for_each` budget stop —
 * where the reason is the entire point of stopping.
 *
 * These tests pin the reason on the run result across DISTINCT failure paths,
 * because they are separate constructors in separate files and fixing one says
 * nothing about the others. Each asserts the message content, not merely that
 * some string is present: a repair that surfaced `""` or `"failed"` would
 * satisfy a presence check while telling the caller nothing.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

const ITEMS = [{ id: "a" }, { id: "b" }];

/** A for_each loop whose body is one node. */
function forEachPipeline(): PipelineDefinition {
  return {
    id: "run-result-error-surface",
    name: "RunResultErrorSurface",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "loop-items",
    nodes: [
      {
        id: "loop-items",
        type: "loop",
        bodyNodeIds: ["step-a"],
        maxIterations: 1000,
        continuePredicateName: "forEach__item__predicate",
        forEach: {
          source: "$.items",
          as: "item",
          order: "input",
          concurrency: 1,
        },
      } as unknown as PipelineNode,
      { id: "step-a", type: "agent", agentName: "a" } as unknown as PipelineNode,
    ],
    edges: [],
  };
}

/** A single-node pipeline, for the plain thrown-error path. */
function singleNodePipeline(): PipelineDefinition {
  return {
    id: "run-result-error-surface-single",
    name: "RunResultErrorSurfaceSingle",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "step-a",
    nodes: [
      { id: "step-a", type: "agent", agentName: "a" } as unknown as PipelineNode,
    ],
    edges: [],
  };
}

const okExecutor: NodeExecutor = async (nodeId) => ({
  nodeId,
  output: "ok",
  durationMs: 1,
});

describe("PipelineRunResult.error (result-surface repair)", () => {
  it("carries the fail-closed reason when a for_each item is unpriced", async () => {
    // The packet's motivating case. `reserve` returns `unknown`, so no item may
    // spend and the run stops before dispatching anything.
    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: async (nodeId, _node, ctx) => {
        runs.push(nodeId);
        ctx.state["itemStatus"] = "ok";
        return { nodeId, output: "ok", durationMs: 1 };
      },
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
    // Fail-closed really did stop everything — otherwise a surfaced reason
    // would be describing a run that dispatched anyway.
    expect(runs).toEqual([]);
    // The reason is now on the RESULT, not only on the event bus.
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe("");
    // Content, not just presence: it must name the reservation problem.
    expect(result.error).toMatch(/reserv|budget|unknown|unpriced/i);
  });

  it("carries the fail-closed reason when a reservation exceeds the ceiling", async () => {
    // A DIFFERENT denial reason down the same path: the two must not collapse
    // onto one generic string, or the surface is decorative.
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: okExecutor,
      loopIterationBudgetReservation: {
        mode: "strict",
        itemBudgetCents: 100,
        reserve: () => ({
          status: "reserved" as const,
          reservedCostCents: 101,
        }),
        settle: () => {},
        release: () => {},
        reconcile: () => ({ status: "unknown" as const }),
        measureItemCost: () => ({ status: "known" as const, costCents: 0 }),
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe("");
    expect(result.error).toMatch(/ceiling|exceed|budget|101|100/i);
  });

  it("carries the thrown message when a node throws (runFromNode catch path)", async () => {
    // A separate constructor in a separate file (`pipeline-runtime.ts`), so it
    // needs its own proof. The exact thrown message must survive.
    const runtime = new PipelineRuntime({
      definition: singleNodePipeline(),
      nodeExecutor: async () => {
        throw new Error("node blew up: disk unavailable");
      },
    });

    const result = await runtime.execute({});

    expect(result.state).toBe("failed");
    expect(result.error).toBe("node blew up: disk unavailable");
  });

  it("leaves error undefined on a successful run", async () => {
    // The field is additive and must not appear when nothing failed, or
    // `if (result.error)` becomes an unreliable failure test for every caller.
    const runtime = new PipelineRuntime({
      definition: singleNodePipeline(),
      nodeExecutor: okExecutor,
    });

    const result = await runtime.execute({});

    expect(result.state).toBe("completed");
    expect(result.error).toBeUndefined();
  });

  it("keeps the run result and the pipeline:failed event telling the same story", async () => {
    // The whole point is that a caller who does NOT subscribe to the bus gets
    // the same information as one who does. If these two ever diverge, the
    // result surface is actively misleading — worse than absent.
    const events: string[] = [];
    const runtime = new PipelineRuntime({
      definition: singleNodePipeline(),
      nodeExecutor: async () => {
        throw new Error("divergence check");
      },
      onEvent: (event) => {
        if (event.type === "pipeline:failed") {
          events.push(event.error);
        }
      },
    });

    const result = await runtime.execute({});

    expect(result.state).toBe("failed");
    expect(events).toHaveLength(1);
    expect(result.error).toBe(events[0]);
  });
});
