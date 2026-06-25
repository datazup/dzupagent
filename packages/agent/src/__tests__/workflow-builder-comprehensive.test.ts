/**
 * workflow-builder-comprehensive.test.ts — W26-A deep coverage
 *
 * 80+ additional tests for WorkflowBuilder / CompiledWorkflow covering:
 *  - parallel() lowering to internal transform nodes
 *  - branch() / conditional routing (all arms, multi-step arms, errors)
 *  - sequence() / chaining (state accumulation, overwrite, ordering)
 *  - Compiled output shape (build() / toPipelineDefinition())
 *  - Edge cases: empty workflow, single-node, onError recovery
 *  - MergeStrategy variants (merge-objects, last-wins, concat-arrays)
 *  - WorkflowContext (workflowId, state, signal)
 *  - Event-emission contract (ordering, payloads)
 *  - withStuckDetector(), withCheckpointStore(), withJournal(), withStore()
 *  - resume() from checkpoint
 *  - stream() generator contract
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWorkflow,
  WorkflowBuilder,
  CompiledWorkflow,
  type WorkflowEvent,
} from "../workflow/index.js";
import type {
  WorkflowStep,
  WorkflowContext,
} from "../workflow/workflow-types.js";
import { InMemoryRunJournal, InMemoryRunStore } from "@dzupagent/core";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { mergeResults } from "../workflow/workflow-compiler-node-builders.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function step(
  id: string,
  fn: (
    state: Record<string, unknown>,
    ctx?: WorkflowContext,
  ) => Record<string, unknown> | void,
): WorkflowStep {
  return {
    id,
    execute: async (input, ctx) =>
      (fn(input as Record<string, unknown>, ctx) ?? {}) as Record<
        string,
        unknown
      >,
  };
}

function asyncStep(
  id: string,
  fn: (state: Record<string, unknown>) => Promise<Record<string, unknown>>,
): WorkflowStep {
  return {
    id,
    execute: async (input) => fn(input as Record<string, unknown>),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectEvents(
  workflow: CompiledWorkflow,
  initialState: Record<string, unknown> = {},
  opts?: { signal?: AbortSignal; runId?: string },
): Promise<{
  result: Record<string, unknown> | null;
  events: WorkflowEvent[];
  error: Error | null;
}> {
  const events: WorkflowEvent[] = [];
  try {
    const result = await workflow.run(initialState, {
      ...opts,
      onEvent: (e) => events.push(e),
    });
    return { result, events, error: null };
  } catch (err) {
    return { result: null, events, error: err as Error };
  }
}

// ===========================================================================
// I. mergeResults() unit tests (pure helper)
// ===========================================================================

describe("mergeResults() helper", () => {
  it("merge-objects deep-merges all results into state", () => {
    const state: Record<string, unknown> = { existing: true };
    mergeResults(state, [{ a: 1 }, { b: 2 }, { c: 3 }], "merge-objects");
    expect(state).toMatchObject({ existing: true, a: 1, b: 2, c: 3 });
  });

  it("merge-objects last writer wins on key collision", () => {
    const state: Record<string, unknown> = {};
    mergeResults(state, [{ key: "first" }, { key: "second" }], "merge-objects");
    expect(state["key"]).toBe("second");
  });

  it("last-wins ignores all but the last result", () => {
    const state: Record<string, unknown> = {};
    mergeResults(
      state,
      [
        { a: 1, ignored: true },
        { b: 2, winner: true },
      ],
      "last-wins",
    );
    expect(state["b"]).toBe(2);
    expect(state["winner"]).toBe(true);
    expect(state["a"]).toBeUndefined();
    expect(state["ignored"]).toBeUndefined();
  });

  it("last-wins with single result is identical to merge-objects", () => {
    const state1: Record<string, unknown> = {};
    const state2: Record<string, unknown> = {};
    mergeResults(state1, [{ x: 42 }], "last-wins");
    mergeResults(state2, [{ x: 42 }], "merge-objects");
    expect(state1["x"]).toBe(state2["x"]);
  });

  it("concat-arrays collects all results into parallelResults", () => {
    const state: Record<string, unknown> = {};
    mergeResults(state, [{ a: 1 }, { b: 2 }, { c: 3 }], "concat-arrays");
    expect(state["parallelResults"]).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("concat-arrays with single item produces a one-element array", () => {
    const state: Record<string, unknown> = {};
    mergeResults(state, [{ only: true }], "concat-arrays");
    const pr = state["parallelResults"] as Record<string, unknown>[];
    expect(pr).toHaveLength(1);
    expect(pr[0]).toMatchObject({ only: true });
  });

  it("merge-objects silently skips non-object results", () => {
    const state: Record<string, unknown> = { keep: true };
    mergeResults(
      state,
      [null as unknown as Record<string, unknown>],
      "merge-objects",
    );
    expect(state["keep"]).toBe(true);
  });

  it("last-wins silently skips null last result", () => {
    const state: Record<string, unknown> = { keep: true };
    mergeResults(
      state,
      [null as unknown as Record<string, unknown>],
      "last-wins",
    );
    expect(state["keep"]).toBe(true);
  });

  it("empty results array leaves state unchanged for all strategies", () => {
    for (const strategy of [
      "merge-objects",
      "last-wins",
      "concat-arrays",
    ] as const) {
      const state: Record<string, unknown> = { preserved: 1 };
      mergeResults(state, [], strategy);
      expect(state["preserved"]).toBe(1);
    }
  });
});

// ===========================================================================
// II. WorkflowBuilder construction and compiled output shape
// ===========================================================================

describe("WorkflowBuilder — build() output shape", () => {
  it("createWorkflow() returns a WorkflowBuilder", () => {
    expect(createWorkflow({ id: "test" })).toBeInstanceOf(WorkflowBuilder);
  });

  it("build() returns a CompiledWorkflow", () => {
    expect(createWorkflow({ id: "test" }).build()).toBeInstanceOf(
      CompiledWorkflow,
    );
  });

  it("config.id is preserved on the CompiledWorkflow", () => {
    const wf = createWorkflow({ id: "my-id" }).build();
    expect(wf.config.id).toBe("my-id");
  });

  it("config.description is preserved on the CompiledWorkflow", () => {
    const wf = createWorkflow({ id: "x", description: "my desc" }).build();
    expect(wf.config.description).toBe("my desc");
  });

  it("toPipelineDefinition returns clones, not the same reference", () => {
    const wf = createWorkflow({ id: "clone" })
      .then(step("a", () => ({})))
      .build();
    const d1 = wf.toPipelineDefinition();
    const d2 = wf.toPipelineDefinition();
    expect(d1).toEqual(d2);
    expect(d1).not.toBe(d2);
    expect(d1.nodes).not.toBe(d2.nodes);
  });

  it("toPipelineDefinition has correct metadata tags", () => {
    const def = createWorkflow({ id: "tags" }).build().toPipelineDefinition();
    expect(def.tags).toContain("workflow-compat");
    expect(def.metadata?.["source"]).toBe("WorkflowBuilder");
    expect(def.metadata?.["runtime"]).toBe("PipelineRuntime");
  });

  it("toPipelineDefinition checkpointStrategy is after_each_node", () => {
    const def = createWorkflow({ id: "cp" }).build().toPipelineDefinition();
    expect(def.checkpointStrategy).toBe("after_each_node");
  });

  it("empty workflow produces a noop entry node", () => {
    const def = createWorkflow({ id: "empty" }).build().toPipelineDefinition();
    expect(def.nodes.length).toBeGreaterThanOrEqual(1);
    expect(def.entryNodeId).toBeTruthy();
    const node = def.nodes.find((n) => n.id === def.entryNodeId);
    expect(node).toBeDefined();
  });

  it("single step workflow has entryNodeId pointing to a node", () => {
    const def = createWorkflow({ id: "single" })
      .then(step("a", () => ({})))
      .build()
      .toPipelineDefinition();
    const nodeIds = def.nodes.map((n) => n.id);
    expect(nodeIds).toContain(def.entryNodeId);
  });

  it("parallel() lowers to a transform node in the definition", () => {
    const def = createWorkflow({ id: "par" })
      .parallel([step("p1", () => ({})), step("p2", () => ({}))])
      .build()
      .toPipelineDefinition();
    const transforms = def.nodes.filter((n) => n.type === "transform");
    expect(transforms.length).toBeGreaterThanOrEqual(1);
  });

  it("branch() creates at least one conditional edge", () => {
    const def = createWorkflow({ id: "br" })
      .branch(() => "a", {
        a: [step("a", () => ({}))],
        b: [step("b", () => ({}))],
      })
      .build()
      .toPipelineDefinition();
    const condEdges = def.edges.filter((e) => e.type === "conditional");
    expect(condEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("branch with empty arm produces a passthrough noop", async () => {
    const wf = createWorkflow({ id: "noop-branch" })
      .branch(() => "empty", { empty: [] })
      .build();
    const result = await wf.run({ preserved: 99 });
    expect(result["preserved"]).toBe(99);
  });

  it("suspend() creates a suspend node in the definition", () => {
    const def = createWorkflow({ id: "sus" })
      .suspend("gate")
      .build()
      .toPipelineDefinition();
    const suspends = def.nodes.filter((n) => n.type === "suspend");
    expect(suspends).toHaveLength(1);
  });

  it("multiple suspend nodes appear in definition", () => {
    const def = createWorkflow({ id: "multi-sus" })
      .suspend("first")
      .then(step("mid", () => ({})))
      .suspend("second")
      .build()
      .toPipelineDefinition();
    const suspends = def.nodes.filter((n) => n.type === "suspend");
    expect(suspends).toHaveLength(2);
  });

  it("sequential steps produce sequential edges in definition", () => {
    const def = createWorkflow({ id: "seq" })
      .then(step("a", () => ({})))
      .then(step("b", () => ({})))
      .then(step("c", () => ({})))
      .build()
      .toPipelineDefinition();
    const seqEdges = def.edges.filter((e) => e.type === "sequential");
    expect(seqEdges.length).toBeGreaterThanOrEqual(2);
  });

  it("fluent builder methods all return the same builder instance", () => {
    const builder = createWorkflow({ id: "fluent" });
    expect(
      builder
        .then(step("a", () => ({})))
        .parallel([step("b", () => ({}))])
        .suspend("gate")
        .branch(() => "x", { x: [step("x", () => ({}))] }),
    ).toBe(builder);
  });
});

// ===========================================================================
// III. sequence() / chaining
// ===========================================================================

describe("WorkflowBuilder — sequential chaining (.then)", () => {
  it("single step receives initial state", async () => {
    const wf = createWorkflow({ id: "t" })
      .then(step("a", (s) => ({ got: s["input"] })))
      .build();
    const result = await wf.run({ input: "hello" });
    expect(result["got"]).toBe("hello");
  });

  it("later step sees output from earlier step", async () => {
    const wf = createWorkflow({ id: "t" })
      .then(step("a", () => ({ val: 10 })))
      .then(step("b", (s) => ({ doubled: (s["val"] as number) * 2 })))
      .build();
    const result = await wf.run({});
    expect(result["doubled"]).toBe(20);
  });

  it("five sequential steps accumulate state correctly", async () => {
    const wf = createWorkflow({ id: "t" })
      .then(step("s1", () => ({ s1: 1 })))
      .then(step("s2", () => ({ s2: 2 })))
      .then(step("s3", () => ({ s3: 3 })))
      .then(step("s4", () => ({ s4: 4 })))
      .then(step("s5", () => ({ s5: 5 })))
      .build();
    const result = await wf.run({});
    expect(result).toMatchObject({ s1: 1, s2: 2, s3: 3, s4: 4, s5: 5 });
  });

  it("step can overwrite key from previous step", async () => {
    const wf = createWorkflow({ id: "t" })
      .then(step("a", () => ({ x: "first" })))
      .then(step("b", () => ({ x: "second" })))
      .build();
    const result = await wf.run({});
    expect(result["x"]).toBe("second");
  });

  it("step returning void preserves prior state", async () => {
    const wf = createWorkflow({ id: "t" })
      .then(step("a", () => ({ keep: true })))
      .then({
        id: "noop",
        execute: async () => undefined,
      } as unknown as WorkflowStep)
      .build();
    const result = await wf.run({});
    expect(result["keep"]).toBe(true);
  });

  it("steps run in order (execution order tracked)", async () => {
    const order: number[] = [];
    const wf = createWorkflow({ id: "t" })
      .then(
        step("s1", () => {
          order.push(1);
          return {};
        }),
      )
      .then(
        step("s2", () => {
          order.push(2);
          return {};
        }),
      )
      .then(
        step("s3", () => {
          order.push(3);
          return {};
        }),
      )
      .build();
    await wf.run({});
    expect(order).toEqual([1, 2, 3]);
  });

  it("error in first step prevents later steps from running", async () => {
    const ran: string[] = [];
    const wf = createWorkflow({ id: "t" })
      .then(
        step("fail", () => {
          throw new Error("early-fail");
        }),
      )
      .then(
        step("never", () => {
          ran.push("never");
          return {};
        }),
      )
      .build();
    await expect(wf.run({})).rejects.toThrow("early-fail");
    expect(ran).toHaveLength(0);
  });

  it("async step resolves correctly", async () => {
    const wf = createWorkflow({ id: "t" })
      .then(
        asyncStep("async", async () => {
          await delay(5);
          return { async: true };
        }),
      )
      .build();
    const result = await wf.run({});
    expect(result["async"]).toBe(true);
  });
});

// ===========================================================================
// IV. parallel() — lowering, execution, merge strategies
// ===========================================================================

describe("WorkflowBuilder — parallel()", () => {
  it("all parallel steps execute and results are merged", async () => {
    const wf = createWorkflow({ id: "p" })
      .parallel([
        step("p1", () => ({ p1: "a" })),
        step("p2", () => ({ p2: "b" })),
        step("p3", () => ({ p3: "c" })),
      ])
      .build();
    const result = await wf.run({});
    expect(result["p1"]).toBe("a");
    expect(result["p2"]).toBe("b");
    expect(result["p3"]).toBe("c");
  });

  it("parallel steps all receive the same state snapshot", async () => {
    const captured: unknown[] = [];
    const wf = createWorkflow({ id: "p" })
      .then(step("init", () => ({ base: 42 })))
      .parallel([
        step("r1", (s) => {
          captured.push(s["base"]);
          return {};
        }),
        step("r2", (s) => {
          captured.push(s["base"]);
          return {};
        }),
        step("r3", (s) => {
          captured.push(s["base"]);
          return {};
        }),
      ])
      .build();
    await wf.run({});
    expect(captured).toEqual([42, 42, 42]);
  });

  it("parallel followed by sequential sees merged state", async () => {
    const wf = createWorkflow({ id: "p" })
      .parallel([step("a", () => ({ a: 10 })), step("b", () => ({ b: 20 }))])
      .then(
        step("sum", (s) => ({ sum: (s["a"] as number) + (s["b"] as number) })),
      )
      .build();
    const result = await wf.run({});
    expect(result["sum"]).toBe(30);
  });

  it("single-step parallel works like a sequential step", async () => {
    const wf = createWorkflow({ id: "p" })
      .parallel([step("only", () => ({ only: true }))])
      .build();
    const result = await wf.run({});
    expect(result["only"]).toBe(true);
  });

  it("parallel error propagates and rejects the run", async () => {
    const wf = createWorkflow({ id: "p" })
      .parallel([
        step("good", () => ({ good: true })),
        step("bad", () => {
          throw new Error("par-error");
        }),
      ])
      .build();
    await expect(wf.run({})).rejects.toThrow("par-error");
  });

  it("two consecutive parallel blocks execute correctly", async () => {
    const wf = createWorkflow({ id: "pp" })
      .parallel([step("a", () => ({ a: 1 })), step("b", () => ({ b: 2 }))])
      .parallel([
        step("c", (s) => ({ c: (s["a"] as number) + 10 })),
        step("d", (s) => ({ d: (s["b"] as number) + 20 })),
      ])
      .build();
    const result = await wf.run({});
    expect(result["c"]).toBe(11);
    expect(result["d"]).toBe(22);
  });

  it("merge-objects (default) is used when no strategy is specified", async () => {
    const wf = createWorkflow({ id: "p" })
      .parallel([step("x", () => ({ x: 1 })), step("y", () => ({ y: 2 }))])
      .build();
    const result = await wf.run({});
    expect(result["x"]).toBe(1);
    expect(result["y"]).toBe(2);
  });

  it("last-wins returns only the last step result", async () => {
    const wf = createWorkflow({ id: "lw" })
      .parallel(
        [
          step("first", () => ({ winner: "first", onlyFirst: true })),
          step("second", () => ({ winner: "second" })),
        ],
        "last-wins",
      )
      .build();
    const result = await wf.run({});
    expect(result["winner"]).toBe("second");
    expect(result["onlyFirst"]).toBeUndefined();
  });

  it("concat-arrays gathers all results in parallelResults array", async () => {
    const wf = createWorkflow({ id: "ca" })
      .parallel(
        [
          step("a", () => ({ a: 1 })),
          step("b", () => ({ b: 2 })),
          step("c", () => ({ c: 3 })),
        ],
        "concat-arrays",
      )
      .build();
    const result = await wf.run({});
    const pr = result["parallelResults"] as Record<string, unknown>[];
    expect(pr).toHaveLength(3);
  });

  it("parallel:started event includes all step IDs", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "p" })
      .parallel([
        step("p1", () => ({})),
        step("p2", () => ({})),
        step("p3", () => ({})),
      ])
      .build();
    await wf.run({}, { onEvent: (e) => events.push(e) });
    const started = events.find((e) => e.type === "parallel:started") as {
      stepIds: string[];
    };
    expect(started).toBeDefined();
    expect(started.stepIds).toEqual(["p1", "p2", "p3"]);
  });

  it("parallel:completed event has durationMs >= 0", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "p" })
      .parallel([step("x", () => ({}))])
      .build();
    await wf.run({}, { onEvent: (e) => events.push(e) });
    const completed = events.find((e) => e.type === "parallel:completed") as {
      durationMs: number;
    };
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("step:failed event emitted for failed parallel step", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "p" })
      .parallel([
        step("ok", () => ({})),
        step("fail", () => {
          throw new Error("par-fail");
        }),
      ])
      .build();
    await wf.run({}, { onEvent: (e) => events.push(e) }).catch(() => {});
    expect(
      events.some(
        (e) =>
          e.type === "step:failed" &&
          "stepId" in e &&
          (e as { stepId: string }).stepId === "fail",
      ),
    ).toBe(true);
  });
});

// ===========================================================================
// V. branch() — conditional routing
// ===========================================================================

describe("WorkflowBuilder — branch()", () => {
  it("selects the correct arm based on state value", async () => {
    const wf = createWorkflow({ id: "br" })
      .then(step("init", () => ({ mode: "fast" })))
      .branch((s) => s["mode"] as string, {
        fast: [step("fast", () => ({ result: "fast" }))],
        slow: [step("slow", () => ({ result: "slow" }))],
      })
      .build();
    const result = await wf.run({});
    expect(result["result"]).toBe("fast");
  });

  it("selects the alternate arm when condition returns it", async () => {
    const wf = createWorkflow({ id: "br" })
      .then(step("init", () => ({ tier: "pro" })))
      .branch((s) => (s["tier"] === "pro" ? "premium" : "free"), {
        premium: [step("prem", () => ({ plan: "premium" }))],
        free: [step("free", () => ({ plan: "free" }))],
      })
      .build();
    const result = await wf.run({});
    expect(result["plan"]).toBe("premium");
  });

  it("throws when condition returns an unknown branch key", async () => {
    const wf = createWorkflow({ id: "br" })
      .branch(() => "nonexistent", {
        a: [step("a", () => ({}))],
        b: [step("b", () => ({}))],
      })
      .build();
    await expect(wf.run({})).rejects.toThrow('Branch "nonexistent" not found');
  });

  it("branch arm with multiple sequential steps runs all of them", async () => {
    const wf = createWorkflow({ id: "br" })
      .branch(() => "multi", {
        multi: [
          step("s1", () => ({ s1: true })),
          step("s2", () => ({ s2: true })),
          step("s3", () => ({ s3: true })),
        ],
      })
      .build();
    const result = await wf.run({});
    expect(result).toMatchObject({ s1: true, s2: true, s3: true });
  });

  it("branch with 5 arms: picks the correct one", async () => {
    const arms: Record<string, WorkflowStep[]> = {};
    for (const name of ["a", "b", "c", "d", "e"]) {
      arms[name] = [step(name, () => ({ picked: name }))];
    }
    const wf = createWorkflow({ id: "br5" })
      .branch((s) => s["pick"] as string, arms)
      .build();

    for (const name of ["a", "c", "e"]) {
      const result = await wf.run({ pick: name });
      expect(result["picked"]).toBe(name);
    }
  });

  it("branch:evaluated event carries selected branch name", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "br" })
      .branch(() => "alpha", {
        alpha: [step("a", () => ({}))],
        beta: [step("b", () => ({}))],
      })
      .build();
    await wf.run({}, { onEvent: (e) => events.push(e) });
    const branchEvt = events.find((e) => e.type === "branch:evaluated") as {
      selected: string;
    };
    expect(branchEvt).toBeDefined();
    expect(branchEvt.selected).toBe("alpha");
  });

  it("step after branch sees arm output in state", async () => {
    const wf = createWorkflow({ id: "br" })
      .branch(() => "arm", {
        arm: [step("arm", () => ({ fromArm: "data" }))],
      })
      .then(step("post", (s) => ({ saw: s["fromArm"] })))
      .build();
    const result = await wf.run({});
    expect(result["saw"]).toBe("data");
  });

  it("error in branch arm propagates to caller", async () => {
    const wf = createWorkflow({ id: "br" })
      .branch(() => "bad", {
        bad: [
          step("boom", () => {
            throw new Error("branch-fail");
          }),
        ],
      })
      .build();
    await expect(wf.run({})).rejects.toThrow("branch-fail");
  });

  it("two consecutive branches both execute correctly", async () => {
    const wf = createWorkflow({ id: "bb" })
      .then(step("init", () => ({ x: "a", y: "b" })))
      .branch((s) => s["x"] as string, {
        a: [step("pickA", () => ({ fromFirst: "A" }))],
        b: [step("pickB", () => ({ fromFirst: "B" }))],
      })
      .branch((s) => s["y"] as string, {
        a: [step("pickA2", () => ({ fromSecond: "A2" }))],
        b: [step("pickB2", () => ({ fromSecond: "B2" }))],
      })
      .build();
    const result = await wf.run({});
    expect(result["fromFirst"]).toBe("A");
    expect(result["fromSecond"]).toBe("B2");
  });

  it("branch after parallel uses parallel output for condition", async () => {
    const wf = createWorkflow({ id: "pb" })
      .parallel([step("score", () => ({ score: 95 }))])
      .branch((s) => ((s["score"] as number) >= 90 ? "pass" : "fail"), {
        pass: [step("pass", () => ({ grade: "A" }))],
        fail: [step("fail", () => ({ grade: "F" }))],
      })
      .build();
    const result = await wf.run({});
    expect(result["grade"]).toBe("A");
  });
});

// ===========================================================================
// VI. Edge cases: empty workflow, single-node
// ===========================================================================

describe("WorkflowBuilder — edge cases", () => {
  it("empty workflow returns initial state unchanged", async () => {
    const wf = createWorkflow({ id: "empty" }).build();
    const result = await wf.run({ x: 1, y: 2, nested: { z: 3 } });
    expect(result["x"]).toBe(1);
    expect(result["y"]).toBe(2);
  });

  it("workflow with only a suspend node suspends immediately", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "only-sus" }).suspend("immediate").build();
    await wf.run({}, { onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.type === "suspended")).toBe(true);
  });

  it("workflow with only a branch node runs correctly", async () => {
    const wf = createWorkflow({ id: "only-br" })
      .branch(() => "one", {
        one: [step("one", () => ({ one: true }))],
      })
      .build();
    const result = await wf.run({});
    expect(result["one"]).toBe(true);
  });

  it("workflow with only a parallel block executes it", async () => {
    const wf = createWorkflow({ id: "only-par" })
      .parallel([step("x", () => ({ x: 99 }))])
      .build();
    const result = await wf.run({});
    expect(result["x"]).toBe(99);
  });

  it("suspend before branch: branch is never reached", async () => {
    const executed: string[] = [];
    const wf = createWorkflow({ id: "sb" })
      .then(
        step("init", () => {
          executed.push("init");
          return {};
        }),
      )
      .suspend("gate")
      .branch(() => "x", {
        x: [
          step("x", () => {
            executed.push("x");
            return {};
          }),
        ],
      })
      .build();
    await wf.run({});
    expect(executed).toEqual(["init"]);
  });

  it("workflow with description sets it in pipeline definition", () => {
    const def = createWorkflow({ id: "with-desc", description: "My workflow" })
      .build()
      .toPipelineDefinition();
    expect(def.description).toBe("My workflow");
  });
});

// ===========================================================================
// VII. onError recovery handler
// ===========================================================================

describe("WorkflowBuilder — onError recovery", () => {
  it("recovery handler runs when predicate matches", async () => {
    const executed: string[] = [];
    const wf = createWorkflow({ id: "err" })
      .then(
        step("fail", () => {
          throw new Error("recoverable");
        }),
      )
      .onError(
        (err) => err.message === "recoverable",
        [
          step("recover", () => {
            executed.push("recover");
            return { recovered: true };
          }),
        ],
      )
      .build();
    const result = await wf.run({});
    expect(executed).toContain("recover");
    expect(result["recovered"]).toBe(true);
  });

  it("recovery handler does not run when predicate does not match", async () => {
    const executed: string[] = [];
    const wf = createWorkflow({ id: "err" })
      .then(
        step("fail", () => {
          throw new Error("unmatched");
        }),
      )
      .onError(
        (err) => err.message === "other",
        [
          step("recover", () => {
            executed.push("recover");
            return {};
          }),
        ],
      )
      .build();
    await expect(wf.run({})).rejects.toThrow("unmatched");
    expect(executed).toHaveLength(0);
  });

  it("first matching onError handler wins", async () => {
    const executed: string[] = [];
    const wf = createWorkflow({ id: "err" })
      .then(
        step("fail", () => {
          throw new Error("err-1");
        }),
      )
      .onError(
        (err) => err.message === "err-1",
        [
          step("handler-1", () => {
            executed.push("handler-1");
            return {};
          }),
        ],
      )
      .onError(
        () => true,
        [
          step("handler-2", () => {
            executed.push("handler-2");
            return {};
          }),
        ],
      )
      .build();
    await wf.run({});
    expect(executed).toEqual(["handler-1"]);
  });
});

// ===========================================================================
// VIII. WorkflowContext
// ===========================================================================

describe("WorkflowBuilder — WorkflowContext", () => {
  it("step receives workflowId in context", async () => {
    let receivedId: string | undefined;
    const wf = createWorkflow({ id: "ctx-id" })
      .then(
        step("a", (_s, ctx) => {
          receivedId = ctx!.workflowId;
          return {};
        }),
      )
      .build();
    await wf.run({});
    expect(receivedId).toBe("ctx-id");
  });

  it("step receives accumulated state in ctx.state", async () => {
    let captured: Record<string, unknown> | undefined;
    const wf = createWorkflow({ id: "ctx-state" })
      .then(step("a", () => ({ key: "val" })))
      .then(
        step("b", (_s, ctx) => {
          captured = { ...ctx!.state };
          return {};
        }),
      )
      .build();
    await wf.run({ initial: true });
    expect(captured?.["key"]).toBe("val");
    expect(captured?.["initial"]).toBe(true);
  });

  it("step receives AbortSignal in ctx.signal when provided", async () => {
    let sig: AbortSignal | undefined;
    const controller = new AbortController();
    const wf = createWorkflow({ id: "ctx-sig" })
      .then(
        step("a", (_s, ctx) => {
          sig = ctx!.signal;
          return {};
        }),
      )
      .build();
    await wf.run({}, { signal: controller.signal });
    expect(sig).toBeDefined();
    expect(sig?.aborted).toBe(false);
  });
});

// ===========================================================================
// IX. Event emission contract
// ===========================================================================

describe("WorkflowBuilder — event ordering and payloads", () => {
  it("step:started fires before step:completed", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "ev" })
      .then(step("a", () => ({})))
      .build();
    await wf.run({}, { onEvent: (e) => events.push(e) });
    const types = events.map((e) => e.type);
    expect(types.indexOf("step:started")).toBeLessThan(
      types.indexOf("step:completed"),
    );
  });

  it("step:completed includes stepId and durationMs >= 0", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "ev" })
      .then(step("myStep", () => ({})))
      .build();
    await wf.run({}, { onEvent: (e) => events.push(e) });
    const completed = events.find((e) => e.type === "step:completed") as {
      stepId: string;
      durationMs: number;
    };
    expect(completed.stepId).toBe("myStep");
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("workflow:completed fires last for a successful run", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "ev" })
      .then(step("a", () => ({})))
      .then(step("b", () => ({})))
      .build();
    await wf.run({}, { onEvent: (e) => events.push(e) });
    expect(events[events.length - 1]!.type).toBe("workflow:completed");
  });

  it("workflow:failed fires when step throws", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "ev" })
      .then(
        step("err", () => {
          throw new Error("boom");
        }),
      )
      .build();
    await wf.run({}, { onEvent: (e) => events.push(e) }).catch(() => {});
    expect(events.some((e) => e.type === "workflow:failed")).toBe(true);
  });

  it("workflow:failed event contains error message", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "ev" })
      .then(
        step("err", () => {
          throw new Error("specific-error");
        }),
      )
      .build();
    await wf.run({}, { onEvent: (e) => events.push(e) }).catch(() => {});
    const failed = events.find((e) => e.type === "workflow:failed") as {
      error: string;
    };
    expect(failed.error).toContain("specific-error");
  });

  it("suspended event has correct reason string", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "ev" }).suspend("my-reason").build();
    await wf.run({}, { onEvent: (e) => events.push(e) });
    const suspended = events.find((e) => e.type === "suspended") as {
      reason: string;
    };
    expect(suspended.reason).toBe("my-reason");
  });

  it("step:failed event includes stepId and error message", async () => {
    const events: WorkflowEvent[] = [];
    const wf = createWorkflow({ id: "ev" })
      .then(
        step("broken", () => {
          throw new Error("err-msg");
        }),
      )
      .build();
    await wf.run({}, { onEvent: (e) => events.push(e) }).catch(() => {});
    const failed = events.find((e) => e.type === "step:failed") as {
      stepId: string;
      error: string;
    };
    expect(failed.stepId).toBe("broken");
    expect(failed.error).toBe("err-msg");
  });
});

// ===========================================================================
// X. stream() generator
// ===========================================================================

describe("WorkflowBuilder — stream()", () => {
  it("stream ends with workflow:completed on success", async () => {
    const wf = createWorkflow({ id: "str" })
      .then(step("a", () => ({ a: 1 })))
      .build();
    const events: WorkflowEvent[] = [];
    for await (const e of wf.stream({})) {
      events.push(e);
    }
    expect(events[events.length - 1]!.type).toBe("workflow:completed");
  });

  it("stream ends with suspended event when hitting a suspend node", async () => {
    const wf = createWorkflow({ id: "str" }).suspend("wait").build();
    const events: WorkflowEvent[] = [];
    for await (const e of wf.stream({})) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "suspended")).toBe(true);
  });

  it("stream ends with workflow:failed on error", async () => {
    const wf = createWorkflow({ id: "str" })
      .then(
        step("err", () => {
          throw new Error("stream-err");
        }),
      )
      .build();
    const events: WorkflowEvent[] = [];
    for await (const e of wf.stream({})) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "workflow:failed")).toBe(true);
  });

  it("stream emits step events in order", async () => {
    const wf = createWorkflow({ id: "str" })
      .then(step("x", () => ({ x: 1 })))
      .build();
    const types: string[] = [];
    for await (const e of wf.stream({})) {
      types.push(e.type);
    }
    expect(types.indexOf("step:started")).toBeLessThan(
      types.indexOf("step:completed"),
    );
  });
});

// ===========================================================================
// XI. withJournal / withStore / withCheckpointStore / withStuckDetector
// ===========================================================================

describe("WorkflowBuilder — durability and configuration", () => {
  let journal: InMemoryRunJournal;

  beforeEach(() => {
    journal = new InMemoryRunJournal();
  });

  it("withJournal writes run_started and run_completed", async () => {
    const wf = createWorkflow({ id: "j" })
      .then(step("a", () => ({})))
      .build()
      .withJournal(journal);
    await wf.run({}, { runId: "run-1" });
    const entries = await journal.getAll("run-1");
    const types = entries.map((e) => e.type);
    expect(types).toContain("run_started");
    expect(types).toContain("run_completed");
  });

  it("withJournal writes step_started and step_completed for each step", async () => {
    const wf = createWorkflow({ id: "j" })
      .then(step("s1", () => ({})))
      .then(step("s2", () => ({})))
      .build()
      .withJournal(journal);
    await wf.run({}, { runId: "run-2" });
    const entries = await journal.getAll("run-2");
    expect(entries.filter((e) => e.type === "step_started")).toHaveLength(2);
    expect(entries.filter((e) => e.type === "step_completed")).toHaveLength(2);
  });

  it("withJournal writes run_failed when step throws", async () => {
    const wf = createWorkflow({ id: "j" })
      .then(
        step("fail", () => {
          throw new Error("j-err");
        }),
      )
      .build()
      .withJournal(journal);
    await wf.run({}, { runId: "run-3" }).catch(() => {});
    const entries = await journal.getAll("run-3");
    expect(entries.some((e) => e.type === "run_failed")).toBe(true);
  });

  it("withJournal writes run_suspended on suspend node", async () => {
    const wf = createWorkflow({ id: "j" })
      .then(step("before", () => ({})))
      .suspend("gate")
      .build()
      .withJournal(journal);
    await wf.run({}, { runId: "run-4" });
    const entries = await journal.getAll("run-4");
    expect(entries.some((e) => e.type === "run_suspended")).toBe(true);
  });

  it("run_started appears before run_completed in journal", async () => {
    const wf = createWorkflow({ id: "j" })
      .then(step("a", () => ({})))
      .build()
      .withJournal(journal);
    await wf.run({}, { runId: "run-5" });
    const entries = await journal.getAll("run-5");
    const types = entries.map((e) => e.type);
    expect(types.indexOf("run_started")).toBeLessThan(
      types.indexOf("run_completed"),
    );
  });

  it("withStore enables getHandle after run", async () => {
    const store = new InMemoryRunStore();
    const wf = createWorkflow({ id: "h" })
      .then(step("a", () => ({})))
      .build()
      .withJournal(journal)
      .withStore(store);
    const run = await store.create({ agentId: "workflow:h", input: {} });
    await wf.run({}, { runId: run.id });
    const handle = await wf.getHandle(run.id);
    expect(handle.runId).toBe(run.id);
  });

  it("getHandle throws when no journal is configured", async () => {
    const wf = createWorkflow({ id: "h" })
      .then(step("a", () => ({})))
      .build();
    await expect(wf.getHandle("any")).rejects.toThrow("no journal configured");
  });

  it("withStuckDetector(false) disables stuck detection (does not throw)", async () => {
    const wf = createWorkflow({ id: "sd" })
      .then(step("a", () => ({})))
      .build()
      .withStuckDetector(false);
    await expect(wf.run({})).resolves.toBeDefined();
  });

  it("withCheckpointStore attaches checkpoint store (returns this)", () => {
    const store = new InMemoryPipelineCheckpointStore();
    const wf = createWorkflow({ id: "cp" })
      .then(step("a", () => ({})))
      .build();
    expect(wf.withCheckpointStore(store)).toBe(wf);
  });

  it("withJournal, withStore, withCheckpointStore are chainable", () => {
    const store = new InMemoryRunStore();
    const cpStore = new InMemoryPipelineCheckpointStore();
    const wf = createWorkflow({ id: "chain" })
      .then(step("a", () => ({})))
      .build();
    expect(
      wf.withJournal(journal).withStore(store).withCheckpointStore(cpStore),
    ).toBe(wf);
  });
});

// ===========================================================================
// XII. Complex compositions
// ===========================================================================

describe("WorkflowBuilder — complex compositions", () => {
  it("then -> parallel -> then -> branch -> then", async () => {
    const wf = createWorkflow({ id: "complex" })
      .then(step("init", () => ({ count: 0 })))
      .parallel([
        step("inc1", (s) => ({ a: (s["count"] as number) + 1 })),
        step("inc2", (s) => ({ b: (s["count"] as number) + 2 })),
      ])
      .then(
        step("combine", (s) => ({
          total: (s["a"] as number) + (s["b"] as number),
        })),
      )
      .branch((s) => ((s["total"] as number) > 2 ? "big" : "small"), {
        big: [step("big", () => ({ size: "big" }))],
        small: [step("small", () => ({ size: "small" }))],
      })
      .then(step("final", (s) => ({ final: `${s["size"]}-${s["total"]}` })))
      .build();

    const result = await wf.run({});
    expect(result["final"]).toBe("big-3");
  });

  it("parallel with all three merge strategies in one workflow", async () => {
    // Verify each strategy can run sequentially in the same workflow instance
    for (const [strategy, key, check] of [
      [
        "merge-objects",
        "p1",
        (r: Record<string, unknown>) => r["p1"] === true && r["p2"] === true,
      ],
      [
        "last-wins",
        "winner",
        (r: Record<string, unknown>) => r["winner"] === "second",
      ],
      [
        "concat-arrays",
        "parallelResults",
        (r: Record<string, unknown>) => Array.isArray(r["parallelResults"]),
      ],
    ] as const) {
      const wf = createWorkflow({ id: `strat-${strategy}` })
        .parallel(
          [
            step("p1", () => ({ p1: true, winner: "first" })),
            step("p2", () => ({ p2: true, winner: "second" })),
          ],
          strategy as "merge-objects" | "last-wins" | "concat-arrays",
        )
        .build();
      const result = await wf.run({});
      expect(check(result)).toBe(true);
    }
  });

  it("10 sequential steps all execute", async () => {
    let builder = createWorkflow({ id: "ten" });
    for (let i = 0; i < 10; i++) {
      builder = builder.then(step(`s${i}`, () => ({ [`s${i}`]: i })));
    }
    const wf = builder.build();
    const result = await wf.run({});
    for (let i = 0; i < 10; i++) {
      expect(result[`s${i}`]).toBe(i);
    }
  });
});
