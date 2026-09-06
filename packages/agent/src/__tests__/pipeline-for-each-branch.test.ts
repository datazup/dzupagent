import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
      expect(resumed.state, `${cp.version}: ${resumed.error}`).toBe("completed");
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
    expect(await runtime.resume(corrupted)).toMatchObject({ state: "failed", error: expect.stringMatching(/item identity/) });
    expect(calls).toEqual([]);
  });
  it("denies malformed graph routing and excluded controls", () => {
    for (const kind of ["loop", "fork", "suspend", "join"] as const) {
      const definition = structuredClone(branchDefinition());
      Object.assign(definition.nodes.find((node) => node.id === "yes")!, { type: kind, ...(kind === "loop" ? { bodyNodeIds: [] } : {}) });
      expect(validatePipeline(definition).errors.some((error) => error.code.startsWith("FOR_EACH_"))).toBe(true);
    }
    const definition = structuredClone(branchDefinition());
    definition.edges.push({ type: "sequential", sourceNodeId: "after", targetNodeId: "before" });
    expect(validatePipeline(definition).errors.some((error) => error.code === "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED")).toBe(true);
  });
  it("rejects V1 evidence-required graph budgets before reservation or dispatch", async () => {
    const reserve = vi.fn(() => ({ status: "reserved" as const, reservedCostCents: 10 }));
    const calls: string[] = [];
    const result = await new PipelineRuntime({
      definition: branchDefinition(), nodeExecutor: executor(calls, []), predicates,
      checkpointStore: new InMemoryPipelineCheckpointStore(),
      loopIterationBudgetReservation: { mode: "strict", evidenceMode: "required", itemBudgetCents: 10, reserve,
        settle: () => {}, release: () => {}, reconcile: () => ({ status: "unknown" }),
        measureItemCost: () => ({ status: "known", costCents: 1 }),
      },
    }).execute({ items: [0] });
    expect(result).toMatchObject({ state: "failed", error: expect.stringMatching(/V2 selected\/skipped-leaf/) });
    expect(reserve).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  });
  it("holds the concurrency ceiling and merges reverse completion in input order", async () => {
    const release: Array<() => void> = [];
    let ready = (): void => {};
    const allStarted = new Promise<void>((resolve) => { ready = resolve; });
    let finishedSecond = (): void => {};
    const secondFinished = new Promise<void>((resolve) => { finishedSecond = resolve; });
    let running = 0, maximum = 0;
    const calls: string[] = [];
    const plain = executor(calls, []);
    const runtime = new PipelineRuntime({ definition: branchDefinition(2), predicates,
      checkpointStore: new InMemoryPipelineCheckpointStore(),
      nodeExecutor: async (id, node, ctx) => {
        if (id === "before") {
          running++; maximum = Math.max(maximum, running);
          await new Promise<void>((resolve) => {
            release[Number(ctx.state.item)] = resolve;
            if (release.filter(Boolean).length === 2) ready();
          });
        }
        if (id === "after") { running--; if (ctx.state.item === 1) finishedSecond(); }
        return plain(id, node, ctx);
      },
    });
    const pending = runtime.execute({ items: [0, 1] });
    await allStarted;
    release[1]!();
    // Wait for the second item's durable completion before releasing the first.
    await secondFinished;
    release[0]!();
    const result = await pending;
    expect(result.state, result.error).toBe("completed");
    expect(maximum).toBe(2);
    expect(result.nodeResults.get("done")?.output).toEqual(["after:item-0", "after:item-1"]);
  });
  it.each(["selection", "leaf", "body", "settlement", "item", "parent"])("survives independent-process SIGKILL after %s", (cut) => {
    const directory = mkdtempSync(join(tmpdir(), "for-each-branch-"));
    const worker = fileURLToPath(new URL("./fixtures/for-each-branch-crash-worker.ts", import.meta.url));
    const tsconfig = join(directory, "runtime-tsconfig.json");
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { paths: {
      "@dzupagent/core/pipeline": [fileURLToPath(new URL("../../../core/src/pipeline.ts", import.meta.url))],
    } } }));
    const args = ["--import", "tsx", worker, "--run-branch-crash-worker", directory];
    const options = { cwd: fileURLToPath(new URL("../../../../", import.meta.url)), encoding: "utf8" as const, timeout: 15000,
      env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig } };
    const killed = spawnSync(process.execPath, [...args, cut], options);
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    const resumed = spawnSync(process.execPath, [...args, "none"], options);
    expect(resumed.status, resumed.stderr).toBe(0);
    const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
    expect(result).toMatchObject({ state: "completed", answer: ["after:item-0", "after:item-1"] });
    const effects = readFileSync(join(directory, "effects.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { id: string; item?: number });
    const identities = effects.map(({ id, item }) => `${id}:${item ?? "outer"}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(identities).not.toContain("no:0"); expect(identities).not.toContain("yes:1");
    const ledger = JSON.parse(readFileSync(join(directory, "ledger.json"), "utf8"));
    expect(ledger.charges).toEqual({ "0": 1, "1": 1 });
    expect(Object.values(ledger.rows).filter((row: unknown) => (row as { state: string }).state === "settled")).toHaveLength(2);
  });

});
