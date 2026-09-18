/**
 * DSL-V2-HOST-BRIDGE-20260918: a finite, single-writer durable adapter for
 * independent-process fault tests of the V2 item host. It qualifies process
 * death only — not multi-writer CAS or machine power loss.
 *
 * The checkpoint file is the graph/custody store; the ledger file carries
 * the host's rows and its retained receipts (the durable result carrier).
 * Both are written whole-file-then-rename, so a SIGKILL leaves the previous
 * complete version, never a torn one.
 */
import type { PipelineCheckpoint } from "@dzupagent/core/pipeline";

async function runCrashWorker(directory: string, cut: string): Promise<void> {
  const { readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { PipelineRuntime } = await import("../../pipeline/pipeline-runtime.js");
  const { InMemoryPipelineCheckpointStore } = await import("../../pipeline/in-memory-checkpoint-store.js");
  const { createV2Host, emptyLedger, outputFor, predicates, v2BranchDefinition, LEAF_NODE_IDS } = await import("./for-each-v2-host-bridge-fixture.js");
  const checkpointPath = join(directory, "checkpoint.json");
  const ledgerPath = join(directory, "ledger.json");
  const effectPath = join(directory, "effects.jsonl");
  const die = (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL failed"); };
  const write = (file: string, value: unknown) => { writeFileSync(`${file}.next`, JSON.stringify(value)); renameSync(`${file}.next`, file); };
  const ledger = existsSync(ledgerPath) ? { ...emptyLedger(), ...JSON.parse(readFileSync(ledgerPath, "utf8")) } : emptyLedger();
  delete ledger.executing;
  const persist = () => { const { executing: _executing, ...durable } = ledger; write(ledgerPath, durable); };
  const retained: PipelineCheckpoint | undefined = existsSync(checkpointPath)
    ? JSON.parse(readFileSync(checkpointPath, "utf8")) : undefined;
  class Store extends InMemoryPipelineCheckpointStore {
    override async save(cp: PipelineCheckpoint): Promise<void> {
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
  const { host } = createV2Host({ ledger });
  // Every host mutation is persisted before it is acknowledged, so the ledger
  // on disk never claims less than the host has done.
  const durableHost = {
    ...host,
    reserve: (input: Parameters<typeof host.reserve>[0]) => { const answer = host.reserve(input); persist(); return answer; },
    dispatchLeaf: async (input: Parameters<typeof host.dispatchLeaf>[0]) => {
      const answer = await host.dispatchLeaf({ ...input, execute: async () => { const result = await input.execute(); return result; } });
      persist();
      return answer;
    },
    settle: (input: Parameters<typeof host.settle>[0]) => { host.settle(input); persist(); if (cut === "settlement" && input.itemIndex === 0) die(); },
    release: (input: Parameters<typeof host.release>[0]) => { host.release(input); persist(); },
  };
  const runtime = new PipelineRuntime({
    definition: v2BranchDefinition(), checkpointStore: store, loopIterationBudgetReservation: durableHost, predicates,
    nodeExecutor: async (id, _node, ctx) => {
      if (LEAF_NODE_IDS.has(id) && ledger.executing === undefined) throw new Error(`leaf ${id} ran outside a host dispatch`);
      appendFileSync(effectPath, JSON.stringify({ id, item: ctx.state.item, key: ctx.idempotencyKey }) + "\n");
      return { nodeId: id, output: outputFor(id, ctx), durationMs: 1 };
    },
  });
  const result = retained ? await runtime.resume(retained) : await runtime.execute({ items: [0, 1] });
  persist();
  write(join(directory, "result.json"), { state: result.state, error: result.error, answer: result.nodeResults.get("done")?.output });
  if (result.state !== "completed") process.exitCode = 1;
}

if (process.argv[2] === "--run-v2-crash-worker") {
  await runCrashWorker(process.argv[3]!, process.argv[4]!);
}
