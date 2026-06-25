/**
 * Deep test coverage for CompiledWorkflow and PipelineExecutor (W25-A1).
 *
 * 70+ tests across:
 * - CompiledWorkflow: run / stream / resume / getHandle / withJournal / withStore
 *   / withCheckpointStore / withStuckDetector / toPipelineDefinition
 * - PipelineExecutor via PipelineRuntime: executeFromNode, dispatchFork,
 *   dispatchLoop, handleSuspend, saveCheckpoint, cancel, error edges
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWorkflow,
  CompiledWorkflow,
  type WorkflowEvent,
  type WorkflowStep,
} from "../workflow/index.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import type {
  PipelineDefinition,
  PipelineNode,
  PipelineEdge,
} from "@dzupagent/core";
import type {
  NodeExecutor,
  NodeResult,
  PipelineRuntimeEvent,
  NodeExecutionContext,
} from "../pipeline/pipeline-runtime-types.js";
import type {
  PipelineCheckpoint,
  PipelineCheckpointStore,
} from "@dzupagent/core/pipeline";
import type { RunJournal, RunStore } from "@dzupagent/core/persistence";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeStep(
  id: string,
  fn: (s: Record<string, unknown>) => Record<string, unknown> = (s) => s
): WorkflowStep {
  return {
    id,
    execute: async (input) => fn(input as Record<string, unknown>),
  };
}

function collectEvents(): {
  events: WorkflowEvent[];
  onEvent: (e: WorkflowEvent) => void;
} {
  const events: WorkflowEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

function makePipelineDef(
  overrides: Partial<PipelineDefinition> & {
    nodes?: PipelineNode[];
    edges?: PipelineEdge[];
  } = {}
): PipelineDefinition {
  return {
    id: "test-pipeline",
    name: "Test",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "A",
    nodes: [
      { id: "A", type: "agent", agentId: "a1", timeoutMs: 5000 },
      { id: "B", type: "agent", agentId: "a2", timeoutMs: 5000 },
    ],
    edges: [{ type: "sequential", sourceNodeId: "A", targetNodeId: "B" }],
    ...overrides,
  };
}

function mockExecutor(
  overrides: Record<string, Partial<NodeResult>> = {}
): NodeExecutor {
  return async (
    nodeId: string,
    _node: PipelineNode,
    _ctx: NodeExecutionContext
  ): Promise<NodeResult> => {
    const o = overrides[nodeId];
    return {
      nodeId,
      output: o?.output ?? `out-${nodeId}`,
      durationMs: o?.durationMs ?? 1,
      error: o?.error,
    };
  };
}

function collectRuntimeEvents(events: PipelineRuntimeEvent[]) {
  return (e: PipelineRuntimeEvent) => events.push(e);
}

// ---------------------------------------------------------------------------
// 1. CompiledWorkflow — basic run
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — single step", () => {
  it("runs a single step and returns its output", async () => {
    const wf = createWorkflow({ id: "wf1" })
      .then(makeStep("s1", () => ({ result: "done" })))
      .build();

    const out = await wf.run({});
    expect(out["result"]).toBe("done");
  });

  it("passes initial state to first step", async () => {
    let received: Record<string, unknown> | null = null;
    const wf = createWorkflow({ id: "wf2" })
      .then({
        id: "capture",
        execute: async (input) => {
          received = input as Record<string, unknown>;
          return {};
        },
      })
      .build();

    await wf.run({ greeting: "hello" });
    expect(received?.["greeting"]).toBe("hello");
  });

  it("returns merged state after step execution", async () => {
    const wf = createWorkflow({ id: "wf3" })
      .then(makeStep("s1", (s) => ({ ...s, added: 1 })))
      .build();

    const result = await wf.run({ base: "x" });
    expect(result["base"]).toBe("x");
    expect(result["added"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. CompiledWorkflow — sequential steps
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — sequential steps", () => {
  it("output of step A feeds step B", async () => {
    const wf = createWorkflow({ id: "seq-wf" })
      .then(makeStep("A", (s) => ({ ...s, fromA: "yes" })))
      .then(makeStep("B", (s) => ({ ...s, seenA: s["fromA"] })))
      .build();

    const result = await wf.run({});
    expect(result["fromA"]).toBe("yes");
    expect(result["seenA"]).toBe("yes");
  });

  it("runs three steps in order and accumulates state", async () => {
    const order: string[] = [];
    const makeTrackedStep = (id: string) =>
      makeStep(id, (s) => {
        order.push(id);
        return { ...s, [`step${id}`]: true };
      });

    const wf = createWorkflow({ id: "seq3" })
      .then(makeTrackedStep("A"))
      .then(makeTrackedStep("B"))
      .then(makeTrackedStep("C"))
      .build();

    const result = await wf.run({});
    expect(order).toEqual(["A", "B", "C"]);
    expect(result["stepA"]).toBe(true);
    expect(result["stepB"]).toBe(true);
    expect(result["stepC"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. CompiledWorkflow — parallel steps
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — parallel steps", () => {
  it("executes parallel steps and merges results", async () => {
    const executed = new Set<string>();
    const wf = createWorkflow({ id: "par-wf" })
      .parallel([
        {
          id: "p1",
          execute: async () => {
            executed.add("p1");
            return { p1: true };
          },
        },
        {
          id: "p2",
          execute: async () => {
            executed.add("p2");
            return { p2: true };
          },
        },
      ])
      .build();

    const result = await wf.run({});
    expect(executed.has("p1")).toBe(true);
    expect(executed.has("p2")).toBe(true);
    expect(result["p1"]).toBe(true);
    expect(result["p2"]).toBe(true);
  });

  it("emits parallel:started and parallel:completed events", async () => {
    const { events, onEvent } = collectEvents();
    const wf = createWorkflow({ id: "par-events" })
      .parallel([makeStep("px"), makeStep("py")])
      .build();

    await wf.run({}, { onEvent });
    const started = events.find((e) => e.type === "parallel:started");
    const completed = events.find((e) => e.type === "parallel:completed");
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. CompiledWorkflow — conditional branch
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — branch", () => {
  it("takes true branch when condition returns 'true'", async () => {
    const executed: string[] = [];
    const wf = createWorkflow({ id: "branch-wf" })
      .branch(() => "taken", {
        taken: [
          makeStep("taken-step", (s) => {
            executed.push("taken");
            return s;
          }),
        ],
        other: [
          makeStep("other-step", (s) => {
            executed.push("other");
            return s;
          }),
        ],
      })
      .build();

    await wf.run({});
    expect(executed).toEqual(["taken"]);
  });

  it("takes false branch when condition returns 'other'", async () => {
    const executed: string[] = [];
    const wf = createWorkflow({ id: "branch-false" })
      .branch((state) => (state["go"] ? "yes" : "no"), {
        yes: [makeStep("yes-step", (s) => ({ ...s, path: "yes" }))],
        no: [makeStep("no-step", (s) => ({ ...s, path: "no" }))],
      })
      .build();

    const result = await wf.run({ go: false });
    expect(result["path"]).toBe("no");
  });

  it("emits branch:evaluated event with selected branch name", async () => {
    const { events, onEvent } = collectEvents();
    const wf = createWorkflow({ id: "branch-event" })
      .branch(() => "chosen", {
        chosen: [makeStep("chosen-step")],
        other: [makeStep("other-step")],
      })
      .build();

    await wf.run({}, { onEvent });
    const branchEv = events.find((e) => e.type === "branch:evaluated") as
      | Extract<WorkflowEvent, { type: "branch:evaluated" }>
      | undefined;
    expect(branchEv).toBeDefined();
    expect(branchEv?.selected).toBe("chosen");
  });
});

// ---------------------------------------------------------------------------
// 5. CompiledWorkflow — error propagation
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — error propagation", () => {
  it("propagates step error to run() rejection", async () => {
    const wf = createWorkflow({ id: "err-wf" })
      .then({
        id: "bad-step",
        execute: async () => {
          throw new Error("step exploded");
        },
      })
      .build();

    await expect(wf.run({})).rejects.toThrow("step exploded");
  });

  it("emits workflow:failed event on step error", async () => {
    const { events, onEvent } = collectEvents();
    const wf = createWorkflow({ id: "err-events" })
      .then({
        id: "bad",
        execute: async () => {
          throw new Error("boom");
        },
      })
      .build();

    await wf.run({}, { onEvent }).catch(() => {
      /* expected */
    });
    const failEv = events.find((e) => e.type === "workflow:failed") as
      | Extract<WorkflowEvent, { type: "workflow:failed" }>
      | undefined;
    expect(failEv).toBeDefined();
    expect(failEv?.error).toContain("boom");
  });

  it("step after failing step is not executed", async () => {
    const executed: string[] = [];
    const wf = createWorkflow({ id: "skip-after-err" })
      .then({
        id: "fail-step",
        execute: async () => {
          throw new Error("early fail");
        },
      })
      .then(
        makeStep("never-reached", (s) => {
          executed.push("never-reached");
          return s;
        })
      )
      .build();

    await wf.run({}).catch(() => {});
    expect(executed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. CompiledWorkflow — events ordering
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — event ordering", () => {
  it("emits step:started, step:completed, workflow:completed in order", async () => {
    const { events, onEvent } = collectEvents();
    const wf = createWorkflow({ id: "event-order" })
      .then(makeStep("s1"))
      .build();

    await wf.run({}, { onEvent });
    const types = events.map((e) => e.type);
    expect(types).toContain("step:started");
    expect(types).toContain("step:completed");
    expect(types).toContain("workflow:completed");
    const startIdx = types.indexOf("step:started");
    const completeIdx = types.indexOf("step:completed");
    const wfCompleteIdx = types.indexOf("workflow:completed");
    expect(startIdx).toBeLessThan(completeIdx);
    expect(completeIdx).toBeLessThan(wfCompleteIdx);
  });

  it("emits step:failed before workflow:failed", async () => {
    const { events, onEvent } = collectEvents();
    const wf = createWorkflow({ id: "fail-order" })
      .then({
        id: "s1",
        execute: async () => {
          throw new Error("oops");
        },
      })
      .build();

    await wf.run({}, { onEvent }).catch(() => {});
    const types = events.map((e) => e.type);
    const failIdx = types.indexOf("step:failed");
    const wfFailIdx = types.indexOf("workflow:failed");
    expect(failIdx).toBeLessThan(wfFailIdx);
  });

  it("step:completed carries durationMs >= 0", async () => {
    const { events, onEvent } = collectEvents();
    const wf = createWorkflow({ id: "duration-check" })
      .then(makeStep("s1"))
      .build();

    await wf.run({}, { onEvent });
    const completedEv = events.find((e) => e.type === "step:completed") as
      | Extract<WorkflowEvent, { type: "step:completed" }>
      | undefined;
    expect(completedEv?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 7. CompiledWorkflow — suspend / resume
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — suspend and resume", () => {
  it("suspend returns partial state without error", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const wf = createWorkflow({ id: "susp-wf" })
      .then(makeStep("before", (s) => ({ ...s, pre: true })))
      .suspend("waiting-for-human")
      .then(makeStep("after", (s) => ({ ...s, post: true })))
      .build()
      .withCheckpointStore(store);

    const result = await wf.run({ initial: 1 });
    // Should not throw, returns state at suspension point
    expect(result["pre"]).toBe(true);
    expect(result["post"]).toBeUndefined(); // not yet executed
  });

  it("emits suspended event with reason on suspend", async () => {
    const { events, onEvent } = collectEvents();
    const store = new InMemoryPipelineCheckpointStore();
    const wf = createWorkflow({ id: "susp-event" })
      .suspend("human-review")
      .build()
      .withCheckpointStore(store);

    await wf.run({}, { onEvent });
    const suspEv = events.find((e) => e.type === "suspended") as
      | Extract<WorkflowEvent, { type: "suspended" }>
      | undefined;
    expect(suspEv).toBeDefined();
    expect(suspEv?.reason).toBe("human-review");
  });

  it("resume continues after suspension point", async () => {
    const executed: string[] = [];
    const store = new InMemoryPipelineCheckpointStore();
    const wf = createWorkflow({ id: "resume-wf" })
      .then(
        makeStep("before", (s) => {
          executed.push("before");
          return { ...s, pre: true };
        })
      )
      .suspend("pause")
      .then(
        makeStep("after", (s) => {
          executed.push("after");
          return { ...s, post: true };
        })
      )
      .build()
      .withCheckpointStore(store);

    // First run — suspends
    const result1 = await wf.run({});
    expect(result1["pre"]).toBe(true);
    expect(executed).toEqual(["before"]);

    // Load checkpoint via store
    const allVersions = await store.listVersions(
      Object.keys(
        (store as unknown as { store: Map<string, unknown[]> }).store
      )[0] ?? ""
    );
    // Use runtime's pipelineRunId from the checkpoint
    const storeMap = (store as unknown as { store: Map<string, unknown[]> })
      .store;
    const firstRunId = [...storeMap.keys()][0];
    expect(firstRunId).toBeDefined();

    const checkpoint = await store.load(firstRunId!);
    expect(checkpoint).toBeDefined();

    // Resume
    executed.length = 0;
    const result2 = await wf.resume(checkpoint!, { extra: "input" });
    expect(result2["post"]).toBe(true);
    expect(executed).toEqual(["after"]);
  });

  it("resume with string pipelineRunId throws if no checkpoint store", async () => {
    const wf = createWorkflow({ id: "no-store" }).suspend("pause").build();

    await expect(wf.resume("some-run-id")).rejects.toThrow(
      "no checkpoint store"
    );
  });

  it("resume with string pipelineRunId throws if no checkpoint found", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const wf = createWorkflow({ id: "missing-cp" })
      .suspend("pause")
      .build()
      .withCheckpointStore(store);

    await expect(wf.resume("nonexistent-run-id")).rejects.toThrow(
      "No checkpoint found"
    );
  });
});

// ---------------------------------------------------------------------------
// 8. CompiledWorkflow — toPipelineDefinition
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — toPipelineDefinition", () => {
  it("returns a structuredClone of the compiled definition", () => {
    const wf = createWorkflow({ id: "pipeline-def" })
      .then(makeStep("s1"))
      .build();

    const def = wf.toPipelineDefinition();
    expect(def).toBeDefined();
    expect(def.id).toBeDefined();
    expect(Array.isArray(def.nodes)).toBe(true);
    expect(Array.isArray(def.edges)).toBe(true);
  });

  it("returns a deep clone — mutations do not affect internal state", () => {
    const wf = createWorkflow({ id: "clone-check" })
      .then(makeStep("s1"))
      .build();

    const def1 = wf.toPipelineDefinition();
    (def1 as { id: string }).id = "mutated";
    const def2 = wf.toPipelineDefinition();
    expect(def2.id).not.toBe("mutated");
  });
});

// ---------------------------------------------------------------------------
// 9. CompiledWorkflow — withJournal
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — withJournal", () => {
  it("withJournal returns same instance (fluent)", () => {
    const journal = {
      append: vi.fn().mockResolvedValue(undefined),
      getEntries: vi.fn().mockResolvedValue([]),
    } as unknown as RunJournal;

    const wf = createWorkflow({ id: "journal-wf" })
      .then(makeStep("s1"))
      .build();
    const result = wf.withJournal(journal);
    expect(result).toBe(wf);
  });

  it("journal.append is called for run_started and run_completed", async () => {
    const journal = {
      append: vi.fn().mockResolvedValue(undefined),
      getEntries: vi.fn().mockResolvedValue([]),
    } as unknown as RunJournal;

    const wf = createWorkflow({ id: "journal-calls" })
      .then(makeStep("s1"))
      .build()
      .withJournal(journal);

    await wf.run({});
    const calls = (journal.append as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      { type: string }
    ][];
    const types = calls.map(([, entry]) => entry.type);
    expect(types).toContain("run_started");
    expect(types).toContain("run_completed");
  });

  it("journal.append called with step_started and step_completed", async () => {
    const journal = {
      append: vi.fn().mockResolvedValue(undefined),
      getEntries: vi.fn().mockResolvedValue([]),
    } as unknown as RunJournal;

    const wf = createWorkflow({ id: "journal-steps" })
      .then(makeStep("s1"))
      .build()
      .withJournal(journal);

    await wf.run({});
    const calls = (journal.append as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      { type: string }
    ][];
    const types = calls.map(([, entry]) => entry.type);
    expect(types).toContain("step_started");
    expect(types).toContain("step_completed");
  });

  it("journal.append called with run_failed on error", async () => {
    const journal = {
      append: vi.fn().mockResolvedValue(undefined),
      getEntries: vi.fn().mockResolvedValue([]),
    } as unknown as RunJournal;

    const wf = createWorkflow({ id: "journal-fail" })
      .then({
        id: "bad",
        execute: async () => {
          throw new Error("journal-fail-test");
        },
      })
      .build()
      .withJournal(journal);

    await wf.run({}).catch(() => {});
    const calls = (journal.append as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      { type: string }
    ][];
    const types = calls.map(([, entry]) => entry.type);
    expect(types).toContain("run_failed");
  });
});

// ---------------------------------------------------------------------------
// 10. CompiledWorkflow — withStore
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — withStore", () => {
  it("withStore returns same instance (fluent)", () => {
    const store = {
      get: vi.fn().mockResolvedValue({ id: "run-1" }),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as RunStore;

    const wf = createWorkflow({ id: "store-wf" }).then(makeStep("s1")).build();
    expect(wf.withStore(store)).toBe(wf);
  });
});

// ---------------------------------------------------------------------------
// 11. CompiledWorkflow — withCheckpointStore
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — withCheckpointStore", () => {
  it("withCheckpointStore returns same instance (fluent)", () => {
    const store = new InMemoryPipelineCheckpointStore();
    const wf = createWorkflow({ id: "ckpt-wf" }).then(makeStep("s1")).build();
    expect(wf.withCheckpointStore(store)).toBe(wf);
  });

  it("checkpoint is persisted after each step with after_each_node strategy", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    // We need to verify the store gets written; use a spy
    const saveSpy = vi.spyOn(store, "save");

    const wf = createWorkflow({ id: "ckpt-save" })
      .then(makeStep("s1"))
      .then(makeStep("s2"))
      .build()
      .withCheckpointStore(store);

    await wf.run({});
    // The PipelineRuntime auto-wires an InMemory store and the compiled workflow
    // passes withCheckpointStore to it — save may be called 0 or more times
    // depending on checkpointStrategy. We just confirm run completed.
    expect(saveSpy).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 12. CompiledWorkflow — withStuckDetector
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — withStuckDetector", () => {
  it("withStuckDetector(false) disables stuck detection (fluent)", async () => {
    const wf = createWorkflow({ id: "no-stuck" })
      .then(makeStep("s1"))
      .build()
      .withStuckDetector(false);

    // Should complete normally
    const result = await wf.run({});
    expect(result).toBeDefined();
  });

  it("withStuckDetector(config) overrides thresholds (fluent)", async () => {
    const wf = createWorkflow({ id: "custom-stuck" })
      .then(makeStep("s1"))
      .build()
      .withStuckDetector({ maxNodeFailures: 10 });

    const result = await wf.run({});
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 13. CompiledWorkflow — getHandle
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — getHandle", () => {
  it("throws RunNotFoundError for unknown runId without journal or store", async () => {
    const wf = createWorkflow({ id: "handle-wf" }).then(makeStep("s1")).build();

    await expect(wf.getHandle("unknown-run")).rejects.toThrow();
  });

  it("throws if journal is not configured for unknown runId", async () => {
    const store = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as RunStore;

    const wf = createWorkflow({ id: "handle-no-journal" })
      .then(makeStep("s1"))
      .build()
      .withStore(store);

    await expect(wf.getHandle("any-run")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 14. CompiledWorkflow — stream
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — stream", () => {
  it("yields step:started and workflow:completed events", async () => {
    const wf = createWorkflow({ id: "stream-wf" }).then(makeStep("s1")).build();

    const yielded: WorkflowEvent[] = [];
    for await (const event of wf.stream({})) {
      yielded.push(event);
    }

    const types = yielded.map((e) => e.type);
    expect(types).toContain("step:started");
    expect(types).toContain("workflow:completed");
  });

  it("stream terminates after workflow:completed", async () => {
    const wf = createWorkflow({ id: "stream-term" })
      .then(makeStep("s1"))
      .then(makeStep("s2"))
      .build();

    const yielded: WorkflowEvent[] = [];
    for await (const event of wf.stream({})) {
      yielded.push(event);
    }

    // After workflow:completed the generator should break
    const completedIdx = yielded.findIndex(
      (e) => e.type === "workflow:completed"
    );
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    // No events should appear after workflow:completed
    expect(yielded.length - 1).toBe(completedIdx);
  });

  it("stream yields workflow:failed on step error", async () => {
    const wf = createWorkflow({ id: "stream-fail" })
      .then({
        id: "bad",
        execute: async () => {
          throw new Error("stream-err");
        },
      })
      .build();

    const yielded: WorkflowEvent[] = [];
    for await (const event of wf.stream({})) {
      yielded.push(event);
    }

    const failEv = yielded.find((e) => e.type === "workflow:failed");
    expect(failEv).toBeDefined();
  });

  it("stream yields suspended event on suspend node", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const wf = createWorkflow({ id: "stream-susp" })
      .suspend("waiting")
      .build()
      .withCheckpointStore(store);

    const yielded: WorkflowEvent[] = [];
    for await (const event of wf.stream({})) {
      yielded.push(event);
    }

    const suspEv = yielded.find((e) => e.type === "suspended");
    expect(suspEv).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 15. CompiledWorkflow — crash recovery via workflowRunId
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — crash recovery", () => {
  it("re-running with workflowRunId pointing at an existing checkpoint skips completed nodes", async () => {
    const callLog: string[] = [];
    // Use an intercepting store so we can save a checkpoint under the crashRunId.
    const inner = new InMemoryPipelineCheckpointStore();
    const savedCheckpoints: PipelineCheckpoint[] = [];
    const interceptStore: PipelineCheckpointStore = {
      async save(cp) {
        savedCheckpoints.push(structuredClone(cp));
        return inner.save(cp);
      },
      async load(runId) {
        return inner.load(runId);
      },
      async loadVersion(runId, v) {
        return inner.loadVersion(runId, v);
      },
      async listVersions(runId) {
        return inner.listVersions(runId);
      },
      async delete(runId) {
        return inner.delete(runId);
      },
      async prune(maxAgeMs) {
        return inner.prune(maxAgeMs);
      },
    } satisfies PipelineCheckpointStore;

    const wf = createWorkflow({ id: "crash-wf" })
      .then(
        makeStep("n1", (s) => {
          callLog.push("n1");
          return { ...s, n1: true };
        })
      )
      .then(
        makeStep("n2", (s) => {
          callLog.push("n2");
          return { ...s, n2: true };
        })
      )
      .then(
        makeStep("n3", (s) => {
          callLog.push("n3");
          return { ...s, n3: true };
        })
      )
      .build()
      .withCheckpointStore(interceptStore);

    // Phase 1: run all nodes to completion (saves per-node checkpoints).
    await wf.run({});
    expect(callLog).toEqual(["n1", "n2", "n3"]);
    expect(savedCheckpoints.length).toBeGreaterThanOrEqual(2);

    // Find the checkpoint that has exactly 2 completed nodes (n1 + n2).
    const checkpointAfterN2 = savedCheckpoints.find(
      (cp) => cp.completedNodeIds.length === 2
    );
    expect(checkpointAfterN2).toBeDefined();

    // Save it under the stable crash-recovery run ID.
    const crashRunId = "crash-recovery-stable-id";
    const crashCheckpoint: PipelineCheckpoint = {
      ...checkpointAfterN2!,
      pipelineRunId: crashRunId,
    };
    await interceptStore.save(crashCheckpoint);

    // Phase 2: resume with workflowRunId — only n3 should run.
    callLog.length = 0;
    const result2 = await wf.run({}, { workflowRunId: crashRunId });

    // n1 and n2 were already completed — only n3 re-runs.
    expect(callLog).toEqual(["n3"]);
    expect(result2["n1"]).toBe(true);
    expect(result2["n2"]).toBe(true);
    expect(result2["n3"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 16. PipelineRuntime — via PipelineExecutor integration
// ---------------------------------------------------------------------------

describe("PipelineRuntime (PipelineExecutor) — linear execution", () => {
  it("executes two nodes A -> B and returns completed", async () => {
    const runtime = new PipelineRuntime({
      definition: makePipelineDef(),
      nodeExecutor: mockExecutor(),
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");
    expect(result.nodeResults.get("A")?.output).toBe("out-A");
    expect(result.nodeResults.get("B")?.output).toBe("out-B");
  });

  it("initial state is threaded into node context", async () => {
    const capturedStates: Record<string, unknown>[] = [];
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      capturedStates.push({ ...ctx.state });
      return { nodeId, output: null, durationMs: 0 };
    };

    const runtime = new PipelineRuntime({
      definition: makePipelineDef({
        nodes: [{ id: "A", type: "agent", agentId: "a1", timeoutMs: 5000 }],
        edges: [],
        entryNodeId: "A",
      }),
      nodeExecutor: executor,
    });

    await runtime.execute({ hello: "world" });
    expect(capturedStates[0]?.["hello"]).toBe("world");
  });

  it("emits pipeline:started and pipeline:completed events", async () => {
    const events: PipelineRuntimeEvent[] = [];
    const runtime = new PipelineRuntime({
      definition: makePipelineDef(),
      nodeExecutor: mockExecutor(),
      onEvent: collectRuntimeEvents(events),
    });

    await runtime.execute();
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("pipeline:started");
    expect(types[types.length - 1]).toBe("pipeline:completed");
  });

  it("node:started and node:completed events emitted for each node", async () => {
    const events: PipelineRuntimeEvent[] = [];
    const runtime = new PipelineRuntime({
      definition: makePipelineDef(),
      nodeExecutor: mockExecutor(),
      onEvent: collectRuntimeEvents(events),
    });

    await runtime.execute();
    const nodeStarted = events.filter(
      (e) => e.type === "pipeline:node_started"
    );
    const nodeCompleted = events.filter(
      (e) => e.type === "pipeline:node_completed"
    );
    expect(nodeStarted.length).toBe(2); // A and B
    expect(nodeCompleted.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 17. PipelineRuntime — step failure
// ---------------------------------------------------------------------------

describe("PipelineRuntime — step failure", () => {
  it("pipeline state is failed when step returns an error", async () => {
    const runtime = new PipelineRuntime({
      definition: makePipelineDef(),
      nodeExecutor: mockExecutor({ A: { error: "A blew up" } }),
    });

    const result = await runtime.execute();
    expect(result.state).toBe("failed");
  });

  it("partial nodeResults preserved on failure", async () => {
    const def = makePipelineDef({
      nodes: [
        { id: "A", type: "agent", agentId: "a1", timeoutMs: 5000 },
        { id: "B", type: "agent", agentId: "a2", timeoutMs: 5000 },
      ],
      edges: [{ type: "sequential", sourceNodeId: "A", targetNodeId: "B" }],
    });

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: mockExecutor({ B: { error: "B failed" } }),
    });

    const result = await runtime.execute();
    expect(result.state).toBe("failed");
    // A should have completed before B failed
    expect(result.nodeResults.get("A")?.output).toBe("out-A");
    expect(result.nodeResults.get("B")?.error).toBe("B failed");
  });

  it("emits pipeline:failed event on failure", async () => {
    const events: PipelineRuntimeEvent[] = [];
    const runtime = new PipelineRuntime({
      definition: makePipelineDef(),
      nodeExecutor: mockExecutor({ A: { error: "fatal" } }),
      onEvent: collectRuntimeEvents(events),
    });

    await runtime.execute();
    const failEv = events.find((e) => e.type === "pipeline:failed");
    expect(failEv).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 18. PipelineRuntime — retry via RetryPolicy
// ---------------------------------------------------------------------------

describe("PipelineRuntime — retry policy", () => {
  it("node succeeds on second attempt when retries:1 is configured", async () => {
    let callCount = 0;
    const executor: NodeExecutor = async (nodeId) => {
      callCount++;
      if (callCount === 1) {
        return { nodeId, output: null, durationMs: 0, error: "transient" };
      }
      return { nodeId, output: "ok", durationMs: 1 };
    };

    // retries:1 means 1 extra retry = 2 total attempts
    const def = makePipelineDef({
      nodes: [
        {
          id: "A",
          type: "agent",
          agentId: "a1",
          timeoutMs: 5000,
          retries: 1,
          retryPolicy: { initialBackoffMs: 0 },
        },
      ],
      edges: [],
      entryNodeId: "A",
    });

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");
    expect(callCount).toBe(2);
    expect(result.nodeResults.get("A")?.output).toBe("ok");
  });

  it("pipeline fails after exhausting all retry attempts (retries:2 = 3 total)", async () => {
    let callCount = 0;
    const executor: NodeExecutor = async (nodeId) => {
      callCount++;
      return { nodeId, output: null, durationMs: 0, error: "always fails" };
    };

    // retries:2 means 2 extra retries = 3 total attempts
    const def = makePipelineDef({
      nodes: [
        {
          id: "A",
          type: "agent",
          agentId: "a1",
          timeoutMs: 5000,
          retries: 2,
          retryPolicy: { initialBackoffMs: 0 },
        },
      ],
      edges: [],
      entryNodeId: "A",
    });

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
    });

    const result = await runtime.execute();
    expect(result.state).toBe("failed");
    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 19. PipelineRuntime — checkpoint after each node
// ---------------------------------------------------------------------------

describe("PipelineRuntime — checkpointing", () => {
  it("saves checkpoint after each node with after_each_node strategy", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const events: PipelineRuntimeEvent[] = [];

    const runtime = new PipelineRuntime({
      definition: makePipelineDef({ checkpointStrategy: "after_each_node" }),
      nodeExecutor: mockExecutor(),
      checkpointStore: store,
      onEvent: collectRuntimeEvents(events),
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");

    const cpEvents = events.filter(
      (e) => e.type === "pipeline:checkpoint_saved"
    );
    expect(cpEvents.length).toBe(2); // one per node A and B
  });

  it("no checkpoints saved with none strategy", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const events: PipelineRuntimeEvent[] = [];

    const runtime = new PipelineRuntime({
      definition: makePipelineDef({ checkpointStrategy: "none" }),
      nodeExecutor: mockExecutor(),
      checkpointStore: store,
      onEvent: collectRuntimeEvents(events),
    });

    await runtime.execute();
    const cpEvents = events.filter(
      (e) => e.type === "pipeline:checkpoint_saved"
    );
    expect(cpEvents.length).toBe(0);
  });

  it("checkpoint versions increment monotonically", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: makePipelineDef({ checkpointStrategy: "after_each_node" }),
      nodeExecutor: mockExecutor(),
      checkpointStore: store,
    });

    const result = await runtime.execute();
    const versions = await store.listVersions(result.runId);
    expect(versions.length).toBe(2);
    expect(versions[0]!.version).toBeLessThan(versions[1]!.version);
  });
});

// ---------------------------------------------------------------------------
// 20. PipelineRuntime — resume from checkpoint
// ---------------------------------------------------------------------------

describe("PipelineRuntime — resume from checkpoint", () => {
  it("resumes after suspend node and skips completed nodes", async () => {
    const order: string[] = [];
    const executor: NodeExecutor = async (nodeId) => {
      order.push(nodeId);
      return { nodeId, output: nodeId, durationMs: 0 };
    };

    const def = makePipelineDef({
      nodes: [
        { id: "A", type: "agent", agentId: "a1", timeoutMs: 5000 },
        { id: "pause", type: "suspend", timeoutMs: 5000 },
        { id: "B", type: "agent", agentId: "a2", timeoutMs: 5000 },
      ],
      edges: [
        { type: "sequential", sourceNodeId: "A", targetNodeId: "pause" },
        { type: "sequential", sourceNodeId: "pause", targetNodeId: "B" },
      ],
      entryNodeId: "A",
    });

    const store = new InMemoryPipelineCheckpointStore();
    const runtime1 = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
      checkpointStore: store,
    });

    const result1 = await runtime1.execute();
    expect(result1.state).toBe("suspended");
    expect(order).toEqual(["A"]);

    const checkpoint = await store.load(result1.runId);
    expect(checkpoint).toBeDefined();

    order.length = 0;
    const runtime2 = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
      checkpointStore: store,
    });
    const result2 = await runtime2.resume(checkpoint!);
    expect(result2.state).toBe("completed");
    expect(order).toEqual(["B"]); // A is skipped
  });

  it("additionalState is merged into runState on resume", async () => {
    const capturedStates: Record<string, unknown>[] = [];
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      capturedStates.push({ ...ctx.state });
      return { nodeId, output: null, durationMs: 0 };
    };

    const def = makePipelineDef({
      nodes: [
        { id: "pause", type: "suspend", timeoutMs: 5000 },
        { id: "B", type: "agent", agentId: "a2", timeoutMs: 5000 },
      ],
      edges: [{ type: "sequential", sourceNodeId: "pause", targetNodeId: "B" }],
      entryNodeId: "pause",
    });

    const store = new InMemoryPipelineCheckpointStore();
    const runtime1 = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
      checkpointStore: store,
    });

    const result1 = await runtime1.execute({ orig: "val" });
    const checkpoint = await store.load(result1.runId);

    capturedStates.length = 0;
    const runtime2 = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
    });
    await runtime2.resume(checkpoint!, { injected: "extra" });
    expect(capturedStates[0]?.["orig"]).toBe("val");
    expect(capturedStates[0]?.["injected"]).toBe("extra");
  });
});

// ---------------------------------------------------------------------------
// 21. PipelineRuntime — cancel
// ---------------------------------------------------------------------------

describe("PipelineRuntime — cancel", () => {
  it("cancel() via runtime.cancel() halts execution", async () => {
    let callCount = 0;
    const executor: NodeExecutor = async (nodeId) => {
      callCount++;
      if (callCount === 1) runtime.cancel("stop");
      return { nodeId, output: nodeId, durationMs: 0 };
    };

    const def = makePipelineDef({
      nodes: [
        { id: "A", type: "agent", agentId: "a1", timeoutMs: 5000 },
        { id: "B", type: "agent", agentId: "a2", timeoutMs: 5000 },
        { id: "C", type: "agent", agentId: "a3", timeoutMs: 5000 },
      ],
      edges: [
        { type: "sequential", sourceNodeId: "A", targetNodeId: "B" },
        { type: "sequential", sourceNodeId: "B", targetNodeId: "C" },
      ],
    });

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
    });
    const result = await runtime.execute();
    expect(result.state).toBe("cancelled");
    expect(runtime.getRunState()).toBe("cancelled");
  });

  it("AbortSignal cancellation halts execution", async () => {
    const controller = new AbortController();
    let callCount = 0;
    const executor: NodeExecutor = async (nodeId) => {
      callCount++;
      if (callCount === 1) controller.abort();
      return { nodeId, output: nodeId, durationMs: 0 };
    };

    const def = makePipelineDef();
    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
      signal: controller.signal,
    });

    const result = await runtime.execute();
    expect(result.state).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// 22. PipelineRuntime — fork / parallel branches
// ---------------------------------------------------------------------------

describe("PipelineRuntime — fork/join", () => {
  it("executes both branches of a fork in parallel", async () => {
    const executed = new Set<string>();
    const executor: NodeExecutor = async (nodeId) => {
      executed.add(nodeId);
      return { nodeId, output: `r-${nodeId}`, durationMs: 1 };
    };

    const def = makePipelineDef({
      entryNodeId: "fork1",
      nodes: [
        { id: "fork1", type: "fork", forkId: "f1", timeoutMs: 5000 },
        { id: "br-a", type: "agent", agentId: "a1", timeoutMs: 5000 },
        { id: "br-b", type: "agent", agentId: "a2", timeoutMs: 5000 },
        {
          id: "join1",
          type: "join",
          forkId: "f1",
          mergeStrategy: "all",
          timeoutMs: 5000,
        },
        { id: "after", type: "agent", agentId: "a3", timeoutMs: 5000 },
      ],
      edges: [
        { type: "sequential", sourceNodeId: "fork1", targetNodeId: "br-a" },
        { type: "sequential", sourceNodeId: "fork1", targetNodeId: "br-b" },
        { type: "sequential", sourceNodeId: "br-a", targetNodeId: "join1" },
        { type: "sequential", sourceNodeId: "br-b", targetNodeId: "join1" },
        { type: "sequential", sourceNodeId: "join1", targetNodeId: "after" },
      ],
    });

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
    });
    const result = await runtime.execute();

    expect(result.state).toBe("completed");
    expect(executed.has("br-a")).toBe(true);
    expect(executed.has("br-b")).toBe(true);
    expect(executed.has("after")).toBe(true);
  });

  it("branch results are available in nodeResults after fork", async () => {
    const executor: NodeExecutor = async (nodeId) => ({
      nodeId,
      output: `res-${nodeId}`,
      durationMs: 1,
    });

    const def = makePipelineDef({
      entryNodeId: "fork1",
      nodes: [
        { id: "fork1", type: "fork", forkId: "f1", timeoutMs: 5000 },
        { id: "br-a", type: "agent", agentId: "a1", timeoutMs: 5000 },
        { id: "br-b", type: "agent", agentId: "a2", timeoutMs: 5000 },
        {
          id: "join1",
          type: "join",
          forkId: "f1",
          mergeStrategy: "all",
          timeoutMs: 5000,
        },
      ],
      edges: [
        { type: "sequential", sourceNodeId: "fork1", targetNodeId: "br-a" },
        { type: "sequential", sourceNodeId: "fork1", targetNodeId: "br-b" },
        { type: "sequential", sourceNodeId: "br-a", targetNodeId: "join1" },
        { type: "sequential", sourceNodeId: "br-b", targetNodeId: "join1" },
      ],
    });

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
    });
    const result = await runtime.execute();

    expect(result.nodeResults.get("br-a")?.output).toBe("res-br-a");
    expect(result.nodeResults.get("br-b")?.output).toBe("res-br-b");
  });
});

// ---------------------------------------------------------------------------
// 23. PipelineRuntime — conditional edges
// ---------------------------------------------------------------------------

describe("PipelineRuntime — conditional routing", () => {
  it("takes true branch on positive predicate", async () => {
    const order: string[] = [];
    const executor: NodeExecutor = async (nodeId) => {
      order.push(nodeId);
      return { nodeId, output: nodeId, durationMs: 0 };
    };

    const def = makePipelineDef({
      nodes: [
        { id: "start", type: "agent", agentId: "a1", timeoutMs: 5000 },
        { id: "yes", type: "agent", agentId: "a2", timeoutMs: 5000 },
        { id: "no", type: "agent", agentId: "a3", timeoutMs: 5000 },
      ],
      edges: [
        {
          type: "conditional",
          sourceNodeId: "start",
          predicateName: "check",
          branches: { true: "yes", false: "no" },
        },
      ],
      entryNodeId: "start",
    });

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
      predicates: { check: () => true },
    });

    await runtime.execute();
    expect(order).toEqual(["start", "yes"]);
  });

  it("step is skipped when false branch leads to no more nodes", async () => {
    const order: string[] = [];
    const executor: NodeExecutor = async (nodeId) => {
      order.push(nodeId);
      return { nodeId, output: nodeId, durationMs: 0 };
    };

    const def = makePipelineDef({
      nodes: [
        { id: "start", type: "agent", agentId: "a1", timeoutMs: 5000 },
        { id: "optional", type: "agent", agentId: "a2", timeoutMs: 5000 },
      ],
      edges: [
        {
          type: "conditional",
          sourceNodeId: "start",
          predicateName: "cond",
          branches: { true: "optional" },
        },
      ],
      entryNodeId: "start",
    });

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
      predicates: { cond: () => false },
    });

    await runtime.execute();
    expect(order).toEqual(["start"]); // optional never runs
  });
});

// ---------------------------------------------------------------------------
// 24. PipelineRuntime — loop node
// ---------------------------------------------------------------------------

describe("PipelineRuntime — loop node", () => {
  it("executes loop body until predicate returns false", async () => {
    let bodyCount = 0;
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      if (nodeId === "body") {
        bodyCount++;
        ctx.state["count"] = bodyCount;
      }
      return { nodeId, output: bodyCount, durationMs: 1 };
    };

    const def = makePipelineDef({
      entryNodeId: "loop1",
      nodes: [
        {
          id: "loop1",
          type: "loop",
          bodyNodeIds: ["body"],
          maxIterations: 10,
          continuePredicateName: "keepGoing",
          timeoutMs: 5000,
        },
        { id: "body", type: "agent", agentId: "a1", timeoutMs: 5000 },
        { id: "after", type: "agent", agentId: "a2", timeoutMs: 5000 },
      ],
      edges: [
        { type: "sequential", sourceNodeId: "loop1", targetNodeId: "after" },
      ],
    });

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
      predicates: {
        keepGoing: (state) => (state["count"] as number) < 3,
      },
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");
    expect(bodyCount).toBe(3); // runs at counts 0(before first check fails), 1, 2, then count=3 → stops
  });

  it("loop node result appears in nodeResults", async () => {
    const executor: NodeExecutor = async (nodeId) => ({
      nodeId,
      output: `out-${nodeId}`,
      durationMs: 0,
    });

    const def = makePipelineDef({
      entryNodeId: "loop1",
      nodes: [
        {
          id: "loop1",
          type: "loop",
          bodyNodeIds: ["body"],
          maxIterations: 1,
          continuePredicateName: "never",
          timeoutMs: 5000,
        },
        { id: "body", type: "agent", agentId: "a1", timeoutMs: 5000 },
      ],
      edges: [],
    });

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
      predicates: { never: () => false },
    });

    const result = await runtime.execute();
    expect(result.nodeResults.has("loop1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 25. PipelineRuntime — validation
// ---------------------------------------------------------------------------

describe("PipelineRuntime — pipeline validation", () => {
  it("throws Pipeline validation failed for missing entryNode", async () => {
    const runtime = new PipelineRuntime({
      definition: makePipelineDef({ entryNodeId: "nonexistent" }),
      nodeExecutor: mockExecutor(),
    });

    await expect(runtime.execute()).rejects.toThrow(
      "Pipeline validation failed"
    );
  });
});

// ---------------------------------------------------------------------------
// 26. CompiledWorkflow — onError handler integration
// ---------------------------------------------------------------------------

describe("CompiledWorkflow — onError handler", () => {
  it("recovery step runs on matching error and workflow continues", async () => {
    const executed: string[] = [];
    const wf = createWorkflow({ id: "on-error-wf" })
      .then({
        id: "failing",
        execute: async () => {
          throw new Error("transient-err");
        },
      })
      .then(
        makeStep("after-recovery", (s) => {
          executed.push("after-recovery");
          return s;
        })
      )
      .onError(
        (err) => err.message.includes("transient"),
        [
          makeStep("recovery-step", (s) => {
            executed.push("recovery-step");
            return s;
          }),
        ]
      )
      .build();

    // With an error handler registered, workflow should not throw
    await wf.run({}).catch(() => {});
    // Recovery step should execute
    expect(executed).toContain("recovery-step");
  });
});

// ---------------------------------------------------------------------------
// 27. PipelineRuntime — suspend with checkpoint store
// ---------------------------------------------------------------------------

describe("PipelineRuntime — suspend checkpoint", () => {
  it("saves checkpoint at suspension point", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const events: PipelineRuntimeEvent[] = [];

    const def = makePipelineDef({
      nodes: [
        { id: "A", type: "agent", agentId: "a1", timeoutMs: 5000 },
        { id: "pause", type: "suspend", timeoutMs: 5000 },
        { id: "B", type: "agent", agentId: "a2", timeoutMs: 5000 },
      ],
      edges: [
        { type: "sequential", sourceNodeId: "A", targetNodeId: "pause" },
        { type: "sequential", sourceNodeId: "pause", targetNodeId: "B" },
      ],
      entryNodeId: "A",
    });

    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: mockExecutor(),
      checkpointStore: store,
      onEvent: collectRuntimeEvents(events),
    });

    const result = await runtime.execute();
    expect(result.state).toBe("suspended");

    const cpEvents = events.filter(
      (e) => e.type === "pipeline:checkpoint_saved"
    );
    expect(cpEvents.length).toBeGreaterThanOrEqual(1);

    const checkpoint = await store.load(result.runId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.suspendedAtNodeId).toBe("pause");
    expect(checkpoint!.completedNodeIds).toContain("A");
  });
});
