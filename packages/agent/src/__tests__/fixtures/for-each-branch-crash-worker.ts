import type { PipelineDefinition } from "@dzupagent/runtime-contracts/pipeline-artifact";

export function branchDefinition(concurrency = 1, emptyElse = false): PipelineDefinition {
  return {
    id: "item-branch", name: "ItemBranch", version: "1", schemaVersion: "1.0.0",
    entryNodeId: "items", checkpointStrategy: "after_each_node", resume: { onProcessRestart: "resume_from_checkpoint" },
    nodes: [
      { id: "items", type: "loop", maxIterations: 100, continuePredicateName: "items",
        bodyNodeIds: ["before", "choose", "yes", ...(emptyElse ? [] : ["no"]), "after"],
        bodyGraph: { entryNodeId: "before", normalExitNodeIds: ["after"], suspendedExitNodeIds: [], terminalExitNodeIds: [], errorExitNodeIds: [] },
        forEach: { source: "items", as: "item", concurrency, order: "input", empty: { body: "skip", aggregate: "empty-array" }, collect: { from: "after", into: "answers", order: "input" } } },
      { id: "before", type: "agent", agentId: "before" },
      { id: "choose", type: "gate", gateType: "quality", condition: "choose" },
      { id: "yes", type: "agent", agentId: "yes" },
      ...(emptyElse ? [] : [{ id: "no", type: "agent" as const, agentId: "no" }]),
      { id: "after", type: "agent", agentId: "after" },
      { id: "done", type: "agent", agentId: "done" },
    ],
    edges: [
      { type: "sequential", sourceNodeId: "before", targetNodeId: "choose" },
      { type: "conditional", sourceNodeId: "choose", predicateName: "choose", branches: emptyElse ? { true: "yes" } : { true: "yes", false: "no" } },
      ...(emptyElse ? [{ type: "sequential" as const, sourceNodeId: "choose", targetNodeId: "after" }] : [{ type: "sequential" as const, sourceNodeId: "no", targetNodeId: "after" }]),
      { type: "sequential", sourceNodeId: "yes", targetNodeId: "after" },
      { type: "sequential", sourceNodeId: "items", targetNodeId: "done" },
    ],
  };
}


// A finite, single-writer durable adapter for independent-process fault tests.
// It qualifies process death, not multi-writer CAS or machine power loss.
async function runCrashWorker(directory: string, cut: string): Promise<void> {
  const { readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { PipelineRuntime } = await import("../../pipeline/pipeline-runtime.js");
  const { InMemoryPipelineCheckpointStore } = await import("../../pipeline/in-memory-checkpoint-store.js");
  const checkpointPath = join(directory, "checkpoint.json");
  const ledgerPath = join(directory, "ledger.json");
  const effectPath = join(directory, "effects.jsonl");
  const die = (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL failed"); };
  const write = (file: string, value: unknown) => { writeFileSync(`${file}.next`, JSON.stringify(value)); renameSync(`${file}.next`, file); };
  type Row = { state: "reserved" | "settled" | "released"; cost: number; itemIndex: number };
  const ledger: { rows: Record<string, Row>; charges: Record<string, number> } = existsSync(ledgerPath)
    ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { rows: {}, charges: {} };
  const retained: import("@dzupagent/core/pipeline").PipelineCheckpoint | undefined = existsSync(checkpointPath)
    ? JSON.parse(readFileSync(checkpointPath, "utf8")) : undefined;
  class Store extends InMemoryPipelineCheckpointStore {
    override async save(cp: import("@dzupagent/core/pipeline").PipelineCheckpoint): Promise<void> {
      await super.save(cp); write(checkpointPath, cp);
      const item = cp.loopState?.items?.itemFrames?.["0"];
      const frame = item?.graph?.frame;
      if ((cut === "selection" && frame?.nextNodeId === "yes") ||
          (cut === "leaf" && frame?.nextNodeId === "after") ||
          (cut === "body" && frame?.completed && item?.outcome === "running") ||
          (cut === "item" && item?.outcome === "completed") ||
          (cut === "parent" && cp.completedNodeIds.includes("items"))) die();
    }
    async seed() { if (retained) await super.save(retained); }
  }
  const store = new Store(); await store.seed();
  const host: import("../../pipeline/loop-executor.js").LoopBudgetStrictHost = {
    mode: "strict", itemBudgetCents: 10,
    reserve(input) {
      ledger.rows[input.reservationId!] = { state: "reserved", cost: 0, itemIndex: input.itemIndex! };
      write(ledgerPath, ledger); return { status: "reserved", reservedCostCents: 10 };
    },
    measureItemCost(input) {
      // Charge only successful executed leaves; the unselected arm has no result.
      return { status: "known", costCents: Object.keys(input.bodyResults).filter((id) => id !== "choose").length };
    },
    settle(input) {
      const key = input.reservationId!, row = ledger.rows[key]!;
      if (row.state !== "settled") ledger.charges[String(row.itemIndex)] = (ledger.charges[String(row.itemIndex)] ?? 0) + 1;
      row.state = "settled"; row.cost = input.actualCostCents; write(ledgerPath, ledger);
      if (cut === "settlement" && input.itemIndex === 0) die();
    },
    release(input) { const row = ledger.rows[input.reservationId!]!; row.state = "released"; write(ledgerPath, ledger); },
    reconcile(input) {
      const row = ledger.rows[input.reservationId];
      if (!row) return { status: "absent" };
      if (row.state === "settled") return { status: "settled", cost: { status: "known", costCents: row.cost } };
      if (row.state === "released") return { status: "released" };
      return { status: "reserved", reservedCostCents: 10 };
    },
  };
  const runtime = new PipelineRuntime({
    definition: branchDefinition(), checkpointStore: store, loopIterationBudgetReservation: host,
    predicates: { choose: (state) => Number(state.item) % 2 === 0 },
    nodeExecutor: async (id, _node, ctx) => {
      appendFileSync(effectPath, JSON.stringify({ id, item: ctx.state.item, key: ctx.idempotencyKey }) + "\n");
      if (id === "before") ctx.state.local = `item-${ctx.state.item}`;
      return { nodeId: id, output: id === "done" ? ctx.state.answers : `${id}:${ctx.state.local}`, durationMs: 1 };
    },
  });
  const result = retained ? await runtime.resume(retained) : await runtime.execute({ items: [0, 1] });
  write(join(directory, "result.json"), { state: result.state, error: result.error, answer: result.nodeResults.get("done")?.output });
  if (result.state !== "completed") process.exitCode = 1;
}

if (process.argv[2] === "--run-branch-crash-worker") {
  await runCrashWorker(process.argv[3]!, process.argv[4]!);
}
