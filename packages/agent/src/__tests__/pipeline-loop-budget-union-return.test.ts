/**
 * Union-return sweep — loop budget settle/release seams.
 *
 * Six declaration sites in `pipeline/loop-executor/types.ts` carried
 * `=> void | Promise<void>`:
 *
 *   - `LoopBudgetLifecycle.settle?` / `release?`      (compatibility host)
 *   - `LoopBudgetStrictHost.settle` / `release`       (strict host)
 *   - `LoopResumeOptions.settleIterationBudget?` / `releaseIterationBudget?`
 *
 * Every consuming call site AWAITS these seams (`for-each-loop.ts` and
 * `predicate-loop-economics.ts`, first-attempt and reconcile-retry paths
 * alike), and `loop-node-handler.ts` bridges the host methods into the resume
 * seams with expression-bodied arrows. So all six narrow to `=> unknown`:
 * `await` on `unknown` is well-typed, and `=> void` would lie about a result
 * the runtime genuinely waits on.
 *
 * Two kinds of lock below:
 *
 * 1. TYPE locks — every supplier is EXPRESSION-BODIED over an `Array.push`,
 *    so its body evaluates to `number`. TypeScript's void-returning-function
 *    leniency admits that against `=> void`, but NOT against the union
 *    `=> void | Promise<void>` (TS2322). Reverting any site to the union
 *    fails `yarn typecheck:tests` (vitest itself does not typecheck).
 *
 * 2. AWAIT-DROP locks — mutation runs on 2026-08-19 dropped each `await` on
 *    these seams in turn (alternative semantics: fire-and-forget via `void`).
 *    FIVE of the eight awaits survived the whole loop-family suite:
 *      - for-each first settle          (`for-each-loop.ts` settleItem)
 *      - for-each release               (`for-each-loop.ts` releaseItem)
 *      - for-each reconcile-retry settle
 *      - predicate reconcile-retry settle
 *      - predicate reconcile-retry release
 *    Each gets a DEFERRED GATE here: the host hands back an explicitly
 *    deferred promise and the test asserts the run is STILL PENDING after the
 *    microtask queue drains, then releases the gate. A plain microtask flush
 *    cannot detect an await-drop (the fire-and-forget promise settles in the
 *    same turns the run does); an unresolved gate can — a non-awaiting
 *    executor completes the run while the gate is still held.
 *
 * Real timers are deliberately avoided: `no-restricted-syntax` makes a real
 * `setTimeout` an ERROR in a non-baselined test file such as this one.
 */
import { describe, expect, it } from "vitest";

import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
import type {
  LoopBudgetCompatibilityHost,
  LoopBudgetReleaseInput,
  LoopBudgetSettlementInput,
  LoopBudgetStrictHost,
  LoopResumeOptions,
} from "../pipeline/loop-executor.js";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

/** An explicitly deferred gate the host can hold a lifecycle call open with. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Drains the microtask queue without real timers. */
async function flushMicrotasks(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

/** Flushes microtasks until `cond` holds (bounded so a miss cannot hang). */
async function flushUntil(cond: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns && !cond(); i += 1) {
    await Promise.resolve();
  }
}

/** Observes settlement of a promise without consuming its rejection. */
function track<T>(promise: Promise<T>): {
  done: () => boolean;
  value: Promise<T>;
} {
  let settled = false;
  const value = promise.then(
    (v) => {
      settled = true;
      return v;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    }
  );
  return { done: () => settled, value };
}

/** A single-item `for_each` loop with one body node. */
function forEachDefinition(): PipelineDefinition {
  return {
    id: "loop-budget-union-return",
    name: "LoopBudgetUnionReturn",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "loop-items",
    nodes: [
      {
        id: "loop-items",
        type: "loop",
        bodyNodeIds: ["step"],
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
      { id: "step", type: "agent", agentId: "step", timeoutMs: 5000 },
    ],
    edges: [],
  };
}

/** A one-iteration predicate loop with one body node. */
function predicateDefinition(): PipelineDefinition {
  return {
    id: "loop-budget-union-return-predicate",
    name: "LoopBudgetUnionReturnPredicate",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "loop",
    nodes: [
      {
        id: "loop",
        type: "loop",
        bodyNodeIds: ["body"],
        maxIterations: 1,
        continuePredicateName: "continue",
        typedWhile: {
          conditionSchema: "dzupagent.flowTypedCondition/v1",
          condition: { op: "literal", value: true },
          onExhausted: "continue",
          iterationBudgetCents: 10,
        },
      },
      { id: "body", type: "agent", agentId: "body", timeoutMs: 1000 },
    ],
    edges: [],
  };
}

function okExecutor(): NodeExecutor {
  return async (nodeId: string) => ({ nodeId, output: "ok", durationMs: 1 });
}

function failingExecutor(): NodeExecutor {
  return async (nodeId: string, _node: PipelineNode) => ({
    nodeId,
    output: null,
    durationMs: 1,
    error: "failed body",
  });
}

const SETTLE_INPUT: LoopBudgetSettlementInput = {
  loopNodeId: "loop",
  iteration: 1,
  reservedCostCents: 8,
  actualCostCents: 3,
};

const RELEASE_INPUT: LoopBudgetReleaseInput = {
  loopNodeId: "loop",
  iteration: 1,
  reservedCostCents: 8,
  reason: "failed",
};

describe("union-return lock: loop budget seam types (=> unknown)", () => {
  it("accepts expression-bodied settle/release on the strict host and settles through the runtime", async () => {
    const settles: LoopBudgetSettlementInput[] = [];
    const releases: LoopBudgetReleaseInput[] = [];
    const host: LoopBudgetStrictHost = {
      mode: "strict",
      itemBudgetCents: 100,
      reserve: () => ({ status: "reserved", reservedCostCents: 50 }),
      // Expression-bodied on purpose: the body evaluates to `number`, which
      // the old `=> void | Promise<void>` union rejected with TS2322.
      settle: (input) => settles.push(input),
      release: (input) => releases.push(input),
      reconcile: () => ({ status: "unknown" }),
      measureItemCost: () => ({ status: "known", costCents: 10 }),
    };

    const result = await new PipelineRuntime({
      definition: forEachDefinition(),
      nodeExecutor: okExecutor(),
      loopIterationBudgetReservation: host,
    }).execute({ items: [{ id: "a" }] });

    expect(result.state).toBe("completed");
    expect(releases).toEqual([]);
    expect(settles).toEqual([
      expect.objectContaining({
        loopNodeId: "loop-items",
        itemIndex: 0,
        reservedCostCents: 50,
        actualCostCents: 10,
      }),
    ]);
  });

  it("accepts expression-bodied optional settle/release on the compatibility host", () => {
    const calls: unknown[] = [];
    const host: LoopBudgetCompatibilityHost = {
      reserve: () => ({ status: "reserved", reservedCostCents: 8 }),
      settle: (input) => calls.push(input),
      release: (input) => calls.push(input),
    };

    // Exercised through the declared optional members so the lock is not
    // vacuous at runtime either.
    host.settle?.(SETTLE_INPUT);
    host.release?.(RELEASE_INPUT);
    expect(calls).toEqual([SETTLE_INPUT, RELEASE_INPUT]);
  });

  it("accepts expression-bodied resume seams on LoopResumeOptions", () => {
    const calls: unknown[] = [];
    const resume: LoopResumeOptions = {
      settleIterationBudget: (input) => calls.push(input),
      releaseIterationBudget: (input) => calls.push(input),
    };

    resume.settleIterationBudget?.(SETTLE_INPUT);
    resume.releaseIterationBudget?.(RELEASE_INPUT);
    expect(calls).toEqual([SETTLE_INPUT, RELEASE_INPUT]);
  });
});

describe("await-drop lock: for_each settle/release are genuinely awaited", () => {
  it("holds the run open while the first settle is pending (deferred gate)", async () => {
    const gate = deferred();
    const settles: LoopBudgetSettlementInput[] = [];
    const host: LoopBudgetStrictHost = {
      mode: "strict",
      itemBudgetCents: 100,
      reserve: () => ({ status: "reserved", reservedCostCents: 50 }),
      settle: (input) => {
        settles.push(input);
        return gate.promise;
      },
      release: () => undefined,
      reconcile: () => ({ status: "unknown" }),
      measureItemCost: () => ({ status: "known", costCents: 10 }),
    };

    const run = track(
      new PipelineRuntime({
        definition: forEachDefinition(),
        nodeExecutor: okExecutor(),
        loopIterationBudgetReservation: host,
      }).execute({ items: [{ id: "a" }] })
    );

    await flushUntil(() => settles.length === 1);
    expect(settles).toHaveLength(1);
    // The settle promise is still pending, so an awaiting executor cannot
    // have finished. A fire-and-forget mutant completes the run right here.
    await flushMicrotasks();
    expect(run.done()).toBe(false);

    gate.release();
    const result = await run.value;
    expect(result.state).toBe("completed");
  });

  it("holds the run open while a failed item's release is pending (deferred gate)", async () => {
    const gate = deferred();
    const releases: LoopBudgetReleaseInput[] = [];
    const host: LoopBudgetStrictHost = {
      mode: "strict",
      itemBudgetCents: 100,
      reserve: () => ({ status: "reserved", reservedCostCents: 50 }),
      settle: () => undefined,
      release: (input) => {
        releases.push(input);
        return gate.promise;
      },
      reconcile: () => ({ status: "unknown" }),
      measureItemCost: () => ({ status: "known", costCents: 10 }),
    };

    const run = track(
      new PipelineRuntime({
        definition: forEachDefinition(),
        nodeExecutor: failingExecutor(),
        loopIterationBudgetReservation: host,
      }).execute({ items: [{ id: "a" }] })
    );

    await flushUntil(() => releases.length === 1);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ reason: "failed" });
    await flushMicrotasks();
    expect(run.done()).toBe(false);

    gate.release();
    const result = await run.value;
    expect(result.state).toBe("failed");
  });

  it("holds the run open while a reconcile-authorized settle RETRY is pending (deferred gate)", async () => {
    const gate = deferred();
    const settles: LoopBudgetSettlementInput[] = [];
    const host: LoopBudgetStrictHost = {
      mode: "strict",
      itemBudgetCents: 100,
      reserve: () => ({ status: "reserved", reservedCostCents: 50 }),
      settle: (input) => {
        settles.push(input);
        if (settles.length === 1) {
          throw new Error("settle acknowledgement lost");
        }
        return gate.promise;
      },
      release: () => undefined,
      // The hold remains, so the executor is authorized to retry the settle.
      reconcile: () => ({ status: "reserved", reservedCostCents: 50 }),
      measureItemCost: () => ({ status: "known", costCents: 10 }),
    };

    const run = track(
      new PipelineRuntime({
        definition: forEachDefinition(),
        nodeExecutor: okExecutor(),
        loopIterationBudgetReservation: host,
      }).execute({ items: [{ id: "a" }] })
    );

    await flushUntil(() => settles.length === 2);
    expect(settles).toHaveLength(2);
    await flushMicrotasks();
    expect(run.done()).toBe(false);

    gate.release();
    const result = await run.value;
    expect(result.state).toBe("completed");
  });
});

describe("await-drop lock: predicate-loop settle/release retries are genuinely awaited", () => {
  it("holds the run open while a reconcile-authorized settle RETRY is pending (deferred gate)", async () => {
    const gate = deferred();
    const settles: LoopBudgetSettlementInput[] = [];
    const host: LoopBudgetStrictHost = {
      mode: "strict",
      reserve: () => ({ status: "reserved", reservedCostCents: 8 }),
      settle: (input) => {
        settles.push(input);
        if (settles.length === 1) {
          throw new Error("settle acknowledgement lost");
        }
        return gate.promise;
      },
      release: () => undefined,
      reconcile: () => ({ status: "reserved", reservedCostCents: 8 }),
      measureItemCost: () => ({ status: "known", costCents: 3 }),
    };

    const run = track(
      new PipelineRuntime({
        definition: predicateDefinition(),
        predicates: { continue: () => false },
        nodeExecutor: okExecutor(),
        loopIterationBudgetReservation: host,
      }).execute()
    );

    await flushUntil(() => settles.length === 2);
    expect(settles).toHaveLength(2);
    await flushMicrotasks();
    expect(run.done()).toBe(false);

    gate.release();
    const result = await run.value;
    expect(result.state).toBe("completed");
  });

  it("holds the run open while a reconcile-authorized release RETRY is pending (deferred gate)", async () => {
    const gate = deferred();
    const releases: LoopBudgetReleaseInput[] = [];
    const host: LoopBudgetStrictHost = {
      mode: "strict",
      reserve: () => ({ status: "reserved", reservedCostCents: 8 }),
      settle: () => undefined,
      release: (input) => {
        releases.push(input);
        if (releases.length === 1) {
          throw new Error("release acknowledgement lost");
        }
        return gate.promise;
      },
      reconcile: () => ({ status: "reserved", reservedCostCents: 8 }),
      measureItemCost: () => ({ status: "known", costCents: 3 }),
    };

    const run = track(
      new PipelineRuntime({
        definition: predicateDefinition(),
        predicates: { continue: () => false },
        nodeExecutor: failingExecutor(),
        loopIterationBudgetReservation: host,
      }).execute()
    );

    await flushUntil(() => releases.length === 2);
    expect(releases).toHaveLength(2);
    await flushMicrotasks();
    expect(run.done()).toBe(false);

    gate.release();
    const result = await run.value;
    expect(result.state).toBe("failed");
  });
});
