import { describe, expect, it, vi } from "vitest";
import type { PipelineCheckpoint } from "@dzupagent/core/pipeline";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { validatePipeline } from "../pipeline/pipeline-validator.js";
import { branchDefinition } from "./fixtures/for-each-branch-crash-worker.js";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

const predicates = { choose: (state: Record<string, unknown>) => Number(state.item) % 2 === 0 };
function executor(calls: string[], keys: string[]): NodeExecutor {
  return async (id, _node, ctx) => {
    calls.push(`${id}:${ctx.state.item ?? "outer"}`);
    if (id === "before") ctx.state.local = `item-${ctx.state.item}`;
    if (ctx.idempotencyKey) keys.push(ctx.idempotencyKey);
    return { nodeId: id, output: id === "done" ? ctx.state.answers : `${id}:${ctx.state.local}`, durationMs: 1 };
  };
}
async function checkpoints(store: InMemoryPipelineCheckpointStore, runId: string) {
  const values: PipelineCheckpoint[] = [];
  for (let version = 1; ; version++) {
    const value = await store.loadVersion(runId, version);
    if (!value) return values;
    values.push(value);
  }
}

describe("one normal for_each branch through public runtime", () => {
  it.each([1, 3])("selects one arm and preserves item state and ordering at concurrency %s", async (concurrency) => {
    const calls: string[] = [], keys: string[] = [];
    const store = new InMemoryPipelineCheckpointStore();
    const definition = branchDefinition(concurrency);
    expect(validatePipeline(definition).errors).toEqual([]);
    const result = await new PipelineRuntime({ definition, nodeExecutor: executor(calls, keys), predicates, checkpointStore: store }).execute({ items: [0, 1, 2] });
    expect(result.state).toBe("completed");
    expect(calls.filter((call) => /^(yes|no):/.test(call)).sort()).toEqual(["no:1", "yes:0", "yes:2"]);
    expect(result.nodeResults.get("done")?.output).toEqual(["after:item-0", "after:item-1", "after:item-2"]);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("allows absent else and an empty source", async () => {
    for (const items of [[1], []]) {
      const calls: string[] = [];
      const result = await new PipelineRuntime({ definition: branchDefinition(2, true), nodeExecutor: executor(calls, []), predicates, checkpointStore: new InMemoryPipelineCheckpointStore() }).execute({ items });
      expect(result.state).toBe("completed");
      expect(calls.some((value) => value.startsWith("yes:"))).toBe(false);
      expect(result.nodeResults.get("done")?.output).toEqual(items.map((item) => `after:item-${item}`));
    }
  });
  it("resumes selected branch and completed body from real serialized checkpoints without repeating work", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const definition = branchDefinition();
    const first = await new PipelineRuntime({ definition, nodeExecutor: executor([], []), predicates, checkpointStore: store }).execute({ items: [0] });
    const saved = await checkpoints(store, first.runId);
    const boundaries = saved.filter((cp) => cp.loopState?.items?.itemFrames?.["0"]?.graph !== undefined);
    expect(boundaries.length).toBeGreaterThanOrEqual(5);
    for (const cp of boundaries) {
      const frame = cp.loopState!.items!.itemFrames!["0"]!.graph!.frame;
      const calls: string[] = [];
      const fresh = new InMemoryPipelineCheckpointStore();
      await fresh.save(JSON.parse(JSON.stringify(cp)) as PipelineCheckpoint);
      const changedPredicate = vi.fn(() => false);
      const resumed = await new PipelineRuntime({ definition, nodeExecutor: executor(calls, []), predicates: { choose: changedPredicate }, checkpointStore: fresh }).resume(cp);
      expect(resumed.state).toBe("completed");
      for (const id of frame.completedNodeIds) expect(calls).not.toContain(`${id}:0`);
      if (frame.completedNodeIds.includes("choose")) {
        expect(changedPredicate).not.toHaveBeenCalled();
        expect(calls).not.toContain("no:0");
      }
    }
  });
  it("preflights corrupt later-item graphs before any sibling dispatch", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const definition = branchDefinition(2);
    const first = await new PipelineRuntime({ definition, nodeExecutor: executor([], []), predicates, checkpointStore: store }).execute({ items: [0, 1] });
    const cp = (await checkpoints(store, first.runId)).find((saved) => saved.loopState?.items?.itemFrames?.["1"]?.graph)!;
    expect(cp).toBeDefined();
    const corrupted = structuredClone(cp);
    corrupted.loopState!.items!.itemFrames!["1"]!.graph!.itemValueDigest = `sha256:${"0".repeat(64)}`;
    const calls: string[] = [];
    const runtime = new PipelineRuntime({ definition, nodeExecutor: executor(calls, []), predicates, checkpointStore: new InMemoryPipelineCheckpointStore() });
    await expect(runtime.resume(corrupted)).rejects.toThrow(/item identity/);
    expect(calls).toEqual([]);
  });
  it("denies malformed graph routing and excluded controls", () => {
    for (const kind of ["loop", "fork", "suspend", "join"] as const) {
      const definition = structuredClone(branchDefinition());
      Object.assign(definition.nodes.find((node) => node.id === "yes")!, { type: kind });
      expect(validatePipeline(definition).errors.some((error) => error.code.startsWith("FOR_EACH_"))).toBe(true);
    }
    const definition = structuredClone(branchDefinition());
    definition.edges.push({ type: "sequential", sourceNodeId: "after", targetNodeId: "before" });
    expect(validatePipeline(definition).errors.some((error) => error.code === "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED")).toBe(true);
  });
});
