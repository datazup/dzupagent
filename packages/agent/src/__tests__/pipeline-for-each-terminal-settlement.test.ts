/**
 * G2d — deterministic terminal settlement at every reservation boundary
 * (doc 27 §8 prerequisite 7).
 *
 * G2b hardened the RESERVE boundary: a reserve that threw became
 * outcome-unknown, blocking release and redispatch until reconciliation proved
 * the outcome. It left the other two boundaries raw, and they carry the same
 * defect. Verified empirically against the pre-G2d tree, not reasoned:
 *
 *   settle throws  ⇒ run failed with the bare transport string
 *                    "settle transport died"; `reconcile` was NEVER consulted
 *                    even when the host supplied it; no release was issued.
 *   release throws ⇒ identical.
 *
 * In both cases the item reached a terminal loop outcome while its reservation
 * sat in an unproven state, which is exactly what prereq 7 forbids: "fail-fast
 * terminal settlement for every started, completed, failed, unknown, and
 * cancelled item."
 *
 * The two boundaries are NOT symmetric, and the asymmetry is the substance of
 * this slice:
 *
 *   - a vanished SETTLE follows completed work that was already charged, so
 *     refunding it could return money the host legitimately took;
 *   - a vanished RELEASE follows work that never completed, so assuming it
 *     succeeded could strand a reservation forever.
 *
 * Neither can be guessed, so both route to `reconcile`, and the host is told
 * WHICH boundary vanished via the new `boundary` field — a host cannot
 * remediate correctly without it.
 *
 * Surface note (carried from F/G2b): a mid-run guard fails the RUN
 * (`state: "failed"`); it does not reject, and `PipelineRunResult.error` stays
 * undefined. Fail-closed messages are asserted on the `pipeline:failed` EVENT.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

function forEachPipeline(): PipelineDefinition {
  return {
    id: "for-each-terminal-settlement",
    name: "ForEachTerminalSettlement",
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

const ITEMS = [{ id: "a" }, { id: "b" }];

function okExecutor(): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode) => ({
    nodeId,
    output: "ok",
    durationMs: 1,
  });
}

/** Fails item `a`'s second body node, leaving its reservation to be released. */
function failingExecutor(): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode, ctx) => {
    const item = ctx.state["item"] as { id: string };
    if (item.id === "a" && nodeId === "step-b") {
      throw new Error("simulated body failure");
    }
    return { nodeId, output: "ok", durationMs: 1 };
  };
}

/**
 * Events are colon-delimited; a wrong name yields `undefined`, and
 * `JSON.stringify(undefined)` makes `toContain` THROW rather than fail
 * meaningfully. Capture and assert existence before matching.
 */
function failureMessage(events: { type: string; error?: string }[]): string {
  const failed = events.find((event) => event.type === "pipeline:failed");
  expect(failed, "no pipeline:failed event was emitted").toBeDefined();
  expect(failed?.error, "pipeline:failed carried no error").toBeTypeOf(
    "string"
  );
  return failed?.error as string;
}

describe("G2d — an unobservable settle is outcome-unknown (prereq 7)", () => {
  it("fails closed, naming boundary and reservation, when no reconcile exists", async () => {
    const events: { type: string; error?: string }[] = [];
    const calls: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: okExecutor(),
      onEvent: (event: { type: string; error?: string }) =>
        events.push(event),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: (input) => {
          calls.push(`reserve:${input.itemIndex}`);
          return { status: "reserved" as const, reservedCostCents: 50 };
        },
        settle: (input) => {
          calls.push(`settle:${input.itemIndex}`);
          throw new Error("settle transport died");
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    const message = failureMessage(events);
    // The pre-G2d tree surfaced the bare transport string. An operator needs
    // to locate the ledger row, so the message must carry the item, the
    // deterministic reservation id, and WHICH call vanished.
    expect(message).toContain("outcome-unknown");
    expect(message).toContain("its settle could not be observed");
    expect(message).toContain("item 0");
    expect(message).toContain("resv:v1:");
    expect(message).toContain("settle transport died");
    // Fail-fast: item 1 must never be reserved once item 0 is unaccounted.
    expect(calls).toEqual(["reserve:0", "settle:0"]);
  });

  it("stays blocked when reconcile answers unknown", async () => {
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: okExecutor(),
      onEvent: (event: { type: string; error?: string }) =>
        events.push(event),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => ({
          status: "reserved" as const,
          reservedCostCents: 50,
        }),
        settle: () => {
          throw new Error("settle transport died");
        },
        // A host that cannot prove the outcome proves nothing. Fail closed.
        reconcile: () => ({ status: "unknown" as const }),
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    expect(failureMessage(events)).toContain("outcome-unknown");
  });

  it("stays blocked when reconcile itself throws", async () => {
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: okExecutor(),
      onEvent: (event: { type: string; error?: string }) =>
        events.push(event),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => ({
          status: "reserved" as const,
          reservedCostCents: 50,
        }),
        settle: () => {
          throw new Error("settle transport died");
        },
        reconcile: () => {
          throw new Error("reconcile also died");
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    const message = failureMessage(events);
    expect(message).toContain("reconciliation failed");
    expect(message).toContain("reconcile also died");
  });

  it("completes the run when reconcile proves the reservation released", async () => {
    const calls: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: okExecutor(),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: (input) => {
          calls.push(`reserve:${input.itemIndex}`);
          return { status: "reserved" as const, reservedCostCents: 50 };
        },
        settle: (input) => {
          calls.push(`settle:${input.itemIndex}`);
          throw new Error("settle transport died");
        },
        reconcile: (input) => {
          calls.push(`reconcile:${input.itemIndex}`);
          return { status: "released" as const };
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    // The item's WORK succeeded; only the settle acknowledgement was lost.
    // Once the host proves nothing is outstanding, the item is terminally
    // settled and the run is legitimately complete — a failure here would
    // discard good work over a recovered bookkeeping call.
    expect(result.state).toBe("completed");
    expect(calls).toEqual([
      "reserve:0",
      "settle:0",
      "reconcile:0",
      "reserve:1",
      "settle:1",
      "reconcile:1",
    ]);
  });

  it("tells the host that the SETTLE boundary vanished", async () => {
    const boundaries: (string | undefined)[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: okExecutor(),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => ({
          status: "reserved" as const,
          reservedCostCents: 50,
        }),
        settle: () => {
          throw new Error("settle transport died");
        },
        reconcile: (input) => {
          boundaries.push(input.boundary);
          return { status: "released" as const };
        },
      },
    });

    await runtime.execute({ items: ITEMS });

    // A vanished settle may have CHARGED the item; a vanished release may have
    // REFUNDED it. Remediation differs, so the boundary is not decorative.
    expect(boundaries[0]).toBe("settle");
  });
});

describe("G2d — an unobservable release is outcome-unknown (prereq 7)", () => {
  it("reports the unaccounted reservation, not the body error that caused it", async () => {
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: failingExecutor(),
      onEvent: (event: { type: string; error?: string }) =>
        events.push(event),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => ({
          status: "reserved" as const,
          reservedCostCents: 50,
        }),
        release: () => {
          throw new Error("release transport died");
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    const message = failureMessage(events);
    // The body error is recorded FIRST, so `??=` would have reported it and
    // silently hidden the unaccounted reservation. A failed item is an
    // expected outcome an author can handle; money in an unknown state is an
    // integrity breach, so it must win.
    expect(message).toContain("outcome-unknown");
    expect(message).toContain("its release could not be observed");
    expect(message).not.toContain("simulated body failure");
  });

  it("tells the host that the RELEASE boundary vanished", async () => {
    const boundaries: (string | undefined)[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: failingExecutor(),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => ({
          status: "reserved" as const,
          reservedCostCents: 50,
        }),
        release: () => {
          throw new Error("release transport died");
        },
        reconcile: (input) => {
          boundaries.push(input.boundary);
          return { status: "released" as const };
        },
      },
    });

    await runtime.execute({ items: ITEMS });

    expect(boundaries[0]).toBe("release");
  });

  it("surfaces the body error once reconcile proves the release landed", async () => {
    const events: { type: string; error?: string }[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: failingExecutor(),
      onEvent: (event: { type: string; error?: string }) =>
        events.push(event),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => ({
          status: "reserved" as const,
          reservedCostCents: 50,
        }),
        release: () => {
          throw new Error("release transport died");
        },
        reconcile: () => ({ status: "absent" as const }),
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    // Nothing is outstanding, so the reservation no longer masks the real
    // cause. This pins the precedence in BOTH directions — the previous test
    // alone would pass a guard that always reported outcome-unknown.
    expect(result.state).toBe("failed");
    const message = failureMessage(events);
    expect(message).toContain("simulated body failure");
    expect(message).not.toContain("outcome-unknown");
  });
});

describe("G2d — boundaries that were already terminal stay unchanged", () => {
  it("keeps a clean settle path free of any reconcile call", async () => {
    const calls: string[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: okExecutor(),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: (input) => {
          calls.push(`reserve:${input.itemIndex}`);
          return { status: "reserved" as const, reservedCostCents: 50 };
        },
        settle: (input) => {
          calls.push(`settle:${input.itemIndex}`);
        },
        reconcile: (input) => {
          calls.push(`reconcile:${input.itemIndex}`);
          return { status: "released" as const };
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    // Reconciliation is a RECOVERY path. A host that pays per reconcile call
    // must not be billed for one on the happy path.
    expect(result.state).toBe("completed");
    expect(calls).toEqual([
      "reserve:0",
      "settle:0",
      "reserve:1",
      "settle:1",
    ]);
  });

  it("still fails closed on a settled overrun rather than reconciling it", async () => {
    const events: { type: string; error?: string }[] = [];
    const reconciles: unknown[] = [];
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: okExecutor(),
      onEvent: (event: { type: string; error?: string }) =>
        events.push(event),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => ({
          status: "reserved" as const,
          reservedCostCents: 50,
        }),
        settle: () => undefined,
        // An overrun is an ANSWERED, observed settlement — the ceiling was
        // breached. It is not outcome-unknown, so widening the return type
        // must not have rerouted it into reconciliation.
        extractItemCostCents: () => 400,
        reconcile: (input) => {
          reconciles.push(input);
          return { status: "released" as const };
        },
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    expect(result.state).toBe("failed");
    expect(failureMessage(events)).toContain("exceeding its 50-cent reservation");
    expect(reconciles).toHaveLength(0);
  });

  it("leaves a reserve-only host byte-identical to its pre-G2d behaviour", async () => {
    const runtime = new PipelineRuntime({
      definition: forEachPipeline(),
      nodeExecutor: okExecutor(),
      loopIterationBudgetReservation: {
        itemBudgetCents: 100,
        reserve: () => ({
          status: "reserved" as const,
          reservedCostCents: 50,
        }),
      },
    });

    const result = await runtime.execute({ items: ITEMS });

    // Absent settle/release there is nothing to observe and nothing can
    // vanish, so the widened contract must not fail a host closed.
    expect(result.state).toBe("completed");
  });
});
