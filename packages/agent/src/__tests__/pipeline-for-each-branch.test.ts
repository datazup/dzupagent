import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PipelineCheckpoint, PipelineCheckpointCommitReceipt } from "@dzupagent/core/pipeline";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { validatePipeline } from "../pipeline/pipeline-validator.js";
import { branchDefinition } from "./fixtures/for-each-branch-crash-worker.js";
import type { LoopBudgetStrictHost } from "../pipeline/loop-executor/budget-types.js";
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

async function releasedBranchAttempt(kind: "failed" | "cancelled") {
  const controller = new AbortController();
  class CancelStore extends InMemoryPipelineCheckpointStore {
    override async saveIfVersion(cp: PipelineCheckpoint, expected: number): Promise<PipelineCheckpointCommitReceipt> {
      const receipt = await super.saveIfVersion(cp, expected);
      if (kind === "cancelled" && cp.loopState?.items?.itemFrames?.["0"]?.graph?.frame.nextNodeId === "yes") controller.abort();
      return receipt;
    }
  }
  const store = new CancelStore(), calls: string[] = [], keys: string[] = [];
  const rows = new Map<string, "reserved" | "released" | "settled">();
  const reservations: Array<{ id: string; attempt: number }> = [];
  const settlements: string[] = [];
  const host: LoopBudgetStrictHost = {
    mode: "strict", itemBudgetCents: 10,
    reserve: (input) => {
      reservations.push({ id: input.reservationId!, attempt: input.attempt ?? 0 });
      rows.set(input.reservationId!, "reserved");
      return { status: "reserved", reservedCostCents: 10 };
    },
    release: (input) => { rows.set(input.reservationId!, "released"); },
    settle: (input) => { rows.set(input.reservationId!, "settled"); settlements.push(input.reservationId!); },
    measureItemCost: () => ({ status: "known", costCents: 3 }),
    reconcile: (input) => rows.get(input.reservationId) === "reserved"
      ? { status: "reserved", reservedCostCents: 10 } : { status: "released" },
  };
  const plain = executor(calls, keys);
  const first = await new PipelineRuntime({
    definition: branchDefinition(), predicates, checkpointStore: store,
    signal: controller.signal, loopIterationBudgetReservation: host,
    nodeExecutor: (id, node, ctx) => id === "yes"
      ? Promise.resolve({ nodeId: id, output: null, durationMs: 1, error: "temporary leaf failure" })
      : plain(id, node, ctx),
  }).execute({ items: [0] });
  const cp = (await checkpoints(store, first.runId)).at(-1)!;
  expect(cp.loopState?.items?.itemOutcomes?.["0"]?.outcome).toBe(kind);
  expect(cp.loopState?.items?.itemFrames?.["0"]?.graph?.frame.nextNodeId).toBe("yes");
  expect([...rows.values()]).toEqual(["released"]);
  return { cp, host, rows, reservations, settlements, plain, calls, keys };
}

describe("one normal for_each branch through public runtime", () => {
  it.each(["failed", "cancelled"] as const)("retries a proven released %s attempt without replaying selected progress", async (kind) => {
    const run = await releasedBranchAttempt(kind);
    run.calls.length = 0;
    class RetryStore extends InMemoryPipelineCheckpointStore {
      saved: PipelineCheckpoint[] = [];
      override async save(cp: PipelineCheckpoint): Promise<void> {
        this.saved.push(structuredClone(cp));
        await super.save(cp);
      }
    }
    const store = new RetryStore(), changedPredicate = vi.fn(() => false);
    await store.save(run.cp);
    const resumed = await new PipelineRuntime({ definition: branchDefinition(), predicates: { choose: changedPredicate },
      checkpointStore: store, nodeExecutor: run.plain, loopIterationBudgetReservation: run.host }).resume(run.cp);
    expect(resumed.state, resumed.error).toBe("completed");
    expect(run.calls).toEqual(["yes:0", "after:0", "done:outer"]);
    expect(changedPredicate).not.toHaveBeenCalled();
    expect(run.reservations.map(({ attempt }) => attempt)).toEqual([0, 1]);
    expect(new Set(run.reservations.map(({ id }) => id)).size).toBe(2);
    expect(run.settlements).toEqual([run.reservations[1]!.id]);
    expect([...run.rows.values()]).toEqual(["released", "settled"]);
    const transition = store.saved.find((cp) =>
      cp.loopState?.items?.itemFrames?.["0"]?.attempt === 1 &&
      cp.loopState.items.itemFrames["0"].graph?.frame.nextNodeId === "yes");
    expect(transition).toBeDefined();
    expect(transition?.loopState?.items?.itemOutcomes?.["0"]).toBeUndefined();
    // A crash immediately after the new reservation checkpoint continues that
    // same attempt and original branch, with no third reservation.
    run.rows.set(run.reservations[1]!.id, "reserved");
    run.calls.length = 0;
    const retry = await new PipelineRuntime({ definition: branchDefinition(), predicates: { choose: changedPredicate },
      checkpointStore: new InMemoryPipelineCheckpointStore(), nodeExecutor: run.plain, loopIterationBudgetReservation: run.host }).resume(transition!);
    expect(retry.state, retry.error).toBe("completed");
    expect(run.reservations).toHaveLength(2);
    expect(run.calls).toEqual(["yes:0", "after:0", "done:outer"]);
  });
  it.each(["acknowledgement-lost", "over-ceiling"] as const)("retains coherent retry economics after %s reserve denial", async (failure) => {
    const run = await releasedBranchAttempt("failed");
    const reserve = run.host.reserve;
    run.host.reserve = async (input) => {
      const result = await reserve(input);
      if (failure === "acknowledgement-lost") throw new Error("reserve acknowledgement lost");
      return result.status === "reserved" ? { ...result, reservedCostCents: 20 } : result;
    };
    const store = new InMemoryPipelineCheckpointStore();
    await store.save(run.cp);
    const failed = await new PipelineRuntime({ definition: branchDefinition(), predicates,
      checkpointStore: store, nodeExecutor: run.plain, loopIterationBudgetReservation: run.host }).resume(run.cp);
    expect(failed.state).toBe("failed");
    const denied = (await store.load(failed.runId))!;
    const frame = denied.loopState!.items!.itemFrames!["0"]!;
    const outcome = denied.loopState!.items!.itemOutcomes!["0"]!;
    expect(outcome.outcome).toBe("denied");
    expect(frame.attempt).toBe(1);
    expect(frame.economics).toEqual(outcome.economics);
    expect([...run.rows.values()]).toEqual(["released", "released"]);
    run.host.reserve = reserve;
    run.calls.length = 0;
    const resumed = await new PipelineRuntime({ definition: branchDefinition(), predicates: { choose: () => false },
      checkpointStore: store, nodeExecutor: run.plain, loopIterationBudgetReservation: run.host }).resume(denied);
    if (failure === "over-ceiling") {
      // Preserve the existing fail-closed ceiling validation even after release.
      expect(resumed.state).toBe("failed");
      expect(resumed.error).toMatch(/invalid reserved cost/);
      expect(run.calls).toEqual([]);
      expect(run.reservations).toHaveLength(2);
      return;
    }
    expect(resumed.state, resumed.error).toBe("completed");
    expect(run.reservations.map(({ attempt }) => attempt)).toEqual([0, 1, 2]);
    expect(run.calls).toEqual(["yes:0", "after:0", "done:outer"]);
    expect([...run.rows.values()]).toEqual(["released", "released", "settled"]);
  });
  it.each(["unknown", "conflict", "settled", "absent"] as const)("blocks released-attempt retry when current authority is %s", async (status) => {
    const run = await releasedBranchAttempt("failed");
    run.calls.length = 0;
    const reconcile: LoopBudgetStrictHost["reconcile"] = () => status === "settled"
      ? { status, cost: { status: "known", costCents: 3 } }
      : status === "conflict" ? { status, heldBy: "another-writer" } : { status };
    const result = await new PipelineRuntime({ definition: branchDefinition(), predicates,
      checkpointStore: new InMemoryPipelineCheckpointStore(), nodeExecutor: run.plain,
      loopIterationBudgetReservation: { ...run.host, reconcile } }).resume(run.cp);
    expect(result.state).toBe("failed");
    expect(run.calls).toEqual([]);
    expect(run.reservations).toHaveLength(1);
    expect(run.settlements).toEqual([]);
  });
  it("fences retry effects when the new attempt checkpoint loses CAS", async () => {
    const run = await releasedBranchAttempt("failed");
    run.calls.length = 0;
    class RetryConflictStore extends InMemoryPipelineCheckpointStore {
      refused = false;
      override async saveIfVersion(cp: PipelineCheckpoint, expected: number): Promise<PipelineCheckpointCommitReceipt> {
        if (cp.loopState?.items?.itemFrames?.["0"]?.attempt === 1) {
          this.refused = true;
          return { committed: false, observedVersion: 999 };
        }
        return super.saveIfVersion(cp, expected);
      }
    }
    const store = new RetryConflictStore();
    await store.save(run.cp);
    const result = await new PipelineRuntime({ definition: branchDefinition(), predicates,
      checkpointStore: store, nodeExecutor: run.plain, loopIterationBudgetReservation: run.host }).resume(run.cp);
    expect(store.refused).toBe(true);
    expect(result.state).toBe("failed");
    expect(run.calls).toEqual([]);
    expect(run.settlements).toEqual([]);
    expect([...run.rows.values()]).toEqual(["released", "reserved"]);
  });

  it.each(["cas", "throw"])("fences concurrent siblings and drains them after a %s checkpoint failure", async (failure) => {
    let park = (): void => {}, release = (): void => {}, lose = (): void => {};
    const parked = new Promise<void>((resolve) => { park = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const lost = new Promise<void>((resolve) => { lose = resolve; });
    class ConflictStore extends InMemoryPipelineCheckpointStore {
      refused = false;
      writesAfterRefusal = 0;
      override async saveIfVersion(cp: PipelineCheckpoint, expectedVersion: number): Promise<PipelineCheckpointCommitReceipt> {
        if (this.refused) this.writesAfterRefusal++;
        if (!this.refused && cp.loopState?.items?.itemFrames?.["0"]?.graph?.frame.nextNodeId === "yes") {
          this.refused = true; lose();
          if (failure === "throw") throw new Error("storage failure");
          return { committed: false, observedVersion: 999 };
        }
        return super.saveIfVersion(cp, expectedVersion);
      }
    }
    const store = new ConflictStore(), calls: string[] = [], reservations: number[] = [];
    const settle = vi.fn(), releaseHold = vi.fn(), measure = vi.fn(() => ({ status: "known" as const, costCents: 1 }));
    const plain = executor(calls, []);
    const pending = new PipelineRuntime({
      definition: branchDefinition(2), predicates, checkpointStore: store,
      nodeExecutor: async (id, node, ctx) => {
        if (id === "before" && ctx.state.item === 1) { park(); await released; }
        if (id === "before" && ctx.state.item === 0) await parked;
        return plain(id, node, ctx);
      },
      loopIterationBudgetReservation: {
        mode: "strict", itemBudgetCents: 10,
        reserve: (input) => { reservations.push(input.itemIndex!); return { status: "reserved", reservedCostCents: 10 }; },
        settle, release: releaseHold, measureItemCost: measure, reconcile: () => ({ status: "unknown" }),
      },
    }).execute({ items: [0, 1, 2] });
    await lost;
    release();
    const result = await pending;
    expect(result).toMatchObject({ state: "failed", error: expect.stringMatching(/conflict|storage failure/i) });
    expect(calls.sort()).toEqual(["before:0", "before:1", "choose:0"]);
    expect(store.writesAfterRefusal).toBe(0);
    expect(reservations).toEqual([0, 1]);
    expect(settle).not.toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
  });
  it.each(["selection", "leaf", "parent"])("stops dispatch after a lost %s checkpoint commit", async (cut) => {
    class ConflictStore extends InMemoryPipelineCheckpointStore {
      refused = false;
      writesAfterRefusal = 0;
      override async saveIfVersion(cp: PipelineCheckpoint, expectedVersion: number): Promise<PipelineCheckpointCommitReceipt> {
        if (this.refused) this.writesAfterRefusal++;
        const graph = cp.loopState?.items?.itemFrames?.["0"]?.graph?.frame;
        const selected = cut === "selection" && graph?.nextNodeId === "yes";
        const leaf = cut === "leaf" && graph?.nextNodeId === "after";
        const parent = cut === "parent" && cp.completedNodeIds.includes("items");
        if (!this.refused && (selected || leaf || parent)) {
          this.refused = true;
          return { committed: false, observedVersion: 999 };
        }
        return super.saveIfVersion(cp, expectedVersion);
      }
    }
    const store = new ConflictStore(), calls: string[] = [];
    const result = await new PipelineRuntime({
      definition: branchDefinition(), predicates,
      nodeExecutor: executor(calls, []), checkpointStore: store,
    }).execute({ items: [0] });
    expect(store.refused).toBe(true);
    expect(result).toMatchObject({ state: "failed", error: expect.stringMatching(/commit|conflict/i) });
    expect(calls).not.toContain("done:outer");
    if (cut === "selection") expect(calls).not.toContain("yes:0");
    if (cut !== "parent") expect(calls).not.toContain("after:0");
    expect(store.writesAfterRefusal).toBe(0);
  });
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
  it("restores mutated object state and attachAs from a completed graph body", async () => {
    const definition = branchDefinition();
    const loop = definition.nodes[0]!;
    if (loop.type !== "loop" || !loop.forEach) throw new Error("fixture must have for_each");
    loop.forEach = { ...loop.forEach, attachAs: "processed" };
    const nodeExecutor: NodeExecutor = async (id, _node, ctx) => {
      if (id === "done") return { nodeId: id, output: { answers: ctx.state.answers, items: ctx.state.items }, durationMs: 1 };
      const item = ctx.state.item as { id: number; changed?: boolean };
      if (id === "yes") item.changed = true;
      return { nodeId: id, output: { ...item }, durationMs: 1 };
    };
    const store = new InMemoryPipelineCheckpointStore();
    const config = { definition, nodeExecutor, predicates: { choose: () => true } };
    const first = await new PipelineRuntime({ ...config, checkpointStore: store }).execute({ items: [{ id: 1 }] });
    expect(first.state, first.error).toBe("completed");
    const expected = {
      answers: [{ id: 1, changed: true }],
      items: [{ id: 1, processed: { id: 1, changed: true } }],
    };
    expect(first.nodeResults.get("done")?.output).toEqual(expected);
    const boundaries = (await checkpoints(store, first.runId)).filter((saved) =>
      saved.loopState?.items?.itemFrames?.["0"]?.graph || (saved.loopState?.items?.iteration ?? 0) > 0);
    expect(boundaries.length).toBeGreaterThan(5);
    for (const cp of boundaries) {
      const resumed = await new PipelineRuntime({ ...config, checkpointStore: new InMemoryPipelineCheckpointStore() }).resume(cp);
      expect(resumed.state, `${cp.version}: ${resumed.error}`).toBe("completed");
      expect(resumed.nodeResults.get("items")?.output).toMatchObject({ loopOutput: expected.answers });
      expect(resumed.nodeResults.get("done")?.output).toEqual(expected);
    }
  });
  it("halts an in-flight selected graph when a sibling reservation is denied", async () => {
    let start = (): void => {}, deny = (): void => {};
    const started = new Promise<void>((resolve) => { start = resolve; });
    const denied = new Promise<void>((resolve) => { deny = resolve; });
    const calls: string[] = [], released: number[] = [], settled: number[] = [];
    const plain = executor(calls, []);
    const result = await new PipelineRuntime({
      definition: branchDefinition(2), predicates, checkpointStore: new InMemoryPipelineCheckpointStore(),
      nodeExecutor: async (id, node, ctx) => {
        if (id === "before") { start(); await denied; }
        return plain(id, node, ctx);
      },
      loopIterationBudgetReservation: {
        mode: "strict", itemBudgetCents: 10,
        reserve: async (input) => {
          if (input.itemIndex === 1) { await started; deny(); return { status: "unknown" }; }
          return { status: "reserved", reservedCostCents: 10 };
        },
        settle: (input) => { settled.push(input.itemIndex!); },
        release: (input) => { released.push(input.itemIndex!); },
        reconcile: () => ({ status: "unknown" }),
        measureItemCost: () => ({ status: "known", costCents: 1 }),
      },
    }).execute({ items: [0, 1] });
    expect(result.state).toBe("failed");
    expect(calls).toEqual(["before:0"]);
    expect(settled).toEqual([]);
    expect(released).toEqual([0]);
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
    const rows = Object.values(ledger.rows) as Array<{ state: string; cost: number }>;
    expect(rows.filter((row) => row.state === "settled").map((row) => row.cost)).toEqual([3, 3]);
    expect(rows.filter((row) => row.state === "reserved")).toEqual([]);
  });

});
