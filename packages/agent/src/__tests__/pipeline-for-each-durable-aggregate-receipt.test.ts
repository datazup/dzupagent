import { describe, expect, it, vi } from "vitest";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { executeLoop } from "../pipeline/loop-executor.js";
import type {
  LoopBudgetStrictHost,
  NodeExecutor,
  NodeResult,
} from "../index.js";
import type { LoopResumeOptions } from "../pipeline/loop-executor.js";

const ITEMS = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

function singleBodyConcurrentPipeline(): PipelineDefinition {
  return {
    id: "durable-single-body-aggregate",
    name: "DurableSingleBodyAggregate",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "loop-items",
    checkpointStrategy: "after_each_node",
    nodes: [
      {
        id: "loop-items",
        type: "loop",
        bodyNodeIds: ["effect"],
        maxIterations: 1000,
        continuePredicateName: "forEach__item__predicate",
        forEach: {
          source: "$.items",
          as: "item",
          order: "input",
          concurrency: 3,
          failFast: false,
          collect: {
            from: "$.itemOutput",
            into: "$.orderedOutputs",
            order: "input",
          },
          empty: { body: "skip", aggregate: "empty-array" },
        },
      },
      { id: "effect", type: "agent", agentId: "effect", timeoutMs: 5000 },
    ],
    edges: [],
  };
}

interface DurableBudgetLedger {
  reservations: Map<
    string,
    { state: "reserved" | "settled" | "released"; itemIndex: number; cost: number }
  >;
  charges: Map<number, number>;
  calls: string[];
}

function strictHost(ledger: DurableBudgetLedger): LoopBudgetStrictHost {
  return {
    mode: "strict",
    itemBudgetCents: 25,
    reserve: (input) => {
      const reservationId = input.reservationId as string;
      const itemIndex = input.itemIndex as number;
      ledger.calls.push(`reserve:${itemIndex}`);
      const prior = ledger.reservations.get(reservationId);
      if (prior?.state === "reserved" || prior?.state === "settled") {
        return { status: "reserved", reservedCostCents: 10 };
      }
      ledger.reservations.set(reservationId, {
        state: "reserved",
        itemIndex,
        cost: 0,
      });
      return { status: "reserved", reservedCostCents: 10 };
    },
    settle: (input) => {
      const reservationId = input.reservationId as string;
      const itemIndex = input.itemIndex as number;
      ledger.calls.push(`settle:${itemIndex}`);
      const row = ledger.reservations.get(reservationId);
      if (row?.state !== "settled") {
        ledger.charges.set(itemIndex, (ledger.charges.get(itemIndex) ?? 0) + 1);
      }
      ledger.reservations.set(reservationId, {
        state: "settled",
        itemIndex,
        cost: input.actualCostCents,
      });
    },
    release: (input) => {
      const reservationId = input.reservationId as string;
      const itemIndex = input.itemIndex as number;
      ledger.calls.push(`release:${itemIndex}`);
      ledger.reservations.set(reservationId, {
        state: "released",
        itemIndex,
        cost: 0,
      });
    },
    reconcile: (input) => {
      const row = ledger.reservations.get(input.reservationId);
      ledger.calls.push(`reconcile:${input.itemIndex ?? -1}`);
      if (row === undefined) return { status: "absent" as const };
      if (row.state === "released") return { status: "released" as const };
      if (row.state === "reserved") {
        return { status: "reserved" as const, reservedCostCents: 10 };
      }
      return {
        status: "settled" as const,
        cost: { status: "known" as const, costCents: row.cost },
      };
    },
    measureItemCost: () => ({ status: "known", costCents: 7 }),
  };
}

describe("definition-bound durable for_each aggregate receipt", () => {
  it("restarts at concurrency > 1 with zero settled-item redispatch, duplicate effect, or charge", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const ledger: DurableBudgetLedger = {
      reservations: new Map(),
      charges: new Map(),
      calls: [],
    };
    const effects = new Map<string, number>();
    let laterCompletions = 0;
    let releaseFirstFailure = (): void => {};
    const laterItemsCompleted = new Promise<void>((resolve) => {
      releaseFirstFailure = resolve;
    });

    const firstExecutor: NodeExecutor = async (
      nodeId: string,
      _node: PipelineNode,
      context
    ) => {
      const item = context.state["item"] as { id: string };
      effects.set(item.id, (effects.get(item.id) ?? 0) + 1);
      if (item.id === "a") {
        await laterItemsCompleted;
        return { nodeId, output: null, durationMs: 1, error: "restart seam" };
      }
      context.state["itemOutput"] = `${item.id}:done`;
      laterCompletions++;
      if (laterCompletions === 3) releaseFirstFailure();
      return { nodeId, output: `${item.id}:done`, durationMs: 1 };
    };

    const first = new PipelineRuntime({
      definition: singleBodyConcurrentPipeline(),
      nodeExecutor: firstExecutor,
      checkpointStore: store,
      loopIterationBudgetReservation: strictHost(ledger),
    });
    const failed = await first.execute({ items: ITEMS });
    expect(failed.state).toBe("failed");

    const checkpoint = await store.load(failed.runId);
    expect(checkpoint?.sourceBinding?.definitionDigest).toMatch(
      /^sha256:[a-f0-9]{64}$/
    );
    expect(
      checkpoint?.loopState?.["loop-items"]?.itemFrames?.["3"]
    ).toMatchObject({
      itemIndex: 3,
      nextBodyNodeIndex: 1,
      outcome: "completed",
      economics: { settledCostCents: 7 },
      bodyResults: {
        "loop-items": {
          output: {
            schema: "dzupagent/for-each-aggregate-receipt/v1",
            loopNodeId: "loop-items",
            itemIndex: 3,
            collectedValue: { status: "known", value: "d:done" },
          },
        },
      },
    });

    const restartCallsAt = ledger.calls.length;
    const restartExecutor: NodeExecutor = async (nodeId, _node, context) => {
      const item = context.state["item"] as { id: string };
      effects.set(item.id, (effects.get(item.id) ?? 0) + 1);
      context.state["itemOutput"] = `${item.id}:done`;
      return { nodeId, output: `${item.id}:done`, durationMs: 1 };
    };
    const restarted = new PipelineRuntime({
      definition: singleBodyConcurrentPipeline(),
      nodeExecutor: restartExecutor,
      checkpointStore: store,
      loopIterationBudgetReservation: strictHost(ledger),
    });
    const completed = await restarted.resume(checkpoint!);

    expect(completed.state).toBe("completed");
    expect(completed.nodeResults.get("loop-items")?.output).toMatchObject({
      loopOutput: ["a:done", "b:done", "c:done", "d:done"],
    });
    expect(effects).toEqual(
      new Map([
        ["a", 2],
        ["b", 1],
        ["c", 1],
        ["d", 1],
      ])
    );
    for (const index of [0, 1, 2, 3]) {
      expect(ledger.charges.get(index)).toBe(1);
    }
    expect(ledger.calls.slice(restartCallsAt)).toEqual([
      "reserve:0",
      "settle:0",
    ]);
  });

  interface MutableReceiptFrame {
    itemIndex: number;
    nextBodyNodeIndex: number;
    outcome: "completed";
    bodyResults: Record<string, NodeResult>;
  }

  function completedReceiptFrame(): MutableReceiptFrame {
    return {
      itemIndex: 0,
      nextBodyNodeIndex: 1,
      outcome: "completed",
      bodyResults: {
        effect: { nodeId: "effect", output: "a:done", durationMs: 1 },
        "loop-items": {
          nodeId: "loop-items",
          durationMs: 0,
          output: {
            schema: "dzupagent/for-each-aggregate-receipt/v1",
            loopNodeId: "loop-items",
            itemIndex: 0,
            itemValue: { status: "known", value: { id: "a" } },
            collectedValue: { status: "known", value: "a:done" },
            finalBodyResult: {
              nodeId: "effect",
              output: { status: "known", value: "a:done" },
            },
          },
        },
      },
    };
  }

  it.each([
    [
      "unknown collectedValue status",
      (frame: MutableReceiptFrame) => {
        const receipt = frame.bodyResults["loop-items"]?.output as {
          collectedValue: unknown;
        };
        receipt.collectedValue = { status: "unknown" };
      },
    ],
    [
      "malformed finalBodyResult shape",
      (frame: MutableReceiptFrame) => {
        const receipt = frame.bodyResults["loop-items"]?.output as {
          finalBodyResult: unknown;
        };
        receipt.finalBodyResult = { nodeId: "effect", output: null };
      },
    ],
    [
      "unknown finalBodyResult output status",
      (frame: MutableReceiptFrame) => {
        const receipt = frame.bodyResults["loop-items"]?.output as {
          finalBodyResult: unknown;
        };
        receipt.finalBodyResult = {
          nodeId: "effect",
          output: { status: "unknown" },
        };
      },
    ],
    [
      "invalid body cursor",
      (frame: MutableReceiptFrame) => {
        frame.nextBodyNodeIndex = 2;
      },
    ],
  ])("fails closed on a completed item with %s", async (_case, corrupt) => {
    const frame = completedReceiptFrame();
    corrupt(frame);
    const executor = vi.fn<NodeExecutor>(async (nodeId) => ({
      nodeId,
      output: "duplicate",
      durationMs: 1,
    }));
    const resume: LoopResumeOptions = {
      startIteration: 0,
      itemFrames: { "0": frame },
      itemOutcomes: {
        "0": { itemIndex: 0, outcome: "completed" },
      },
    };

    const { result } = await executeLoop(
      singleBodyConcurrentPipeline().nodes[0] as Extract<
        PipelineNode,
        { type: "loop" }
      >,
      [singleBodyConcurrentPipeline().nodes[1] as PipelineNode],
      executor,
      { state: { items: [{ id: "a" }] }, previousResults: new Map() },
      {},
      undefined,
      resume
    );

    expect(result.error).toMatch(/receipt is missing or corrupt|redispatch is blocked/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("rejects a loop-id body collision before the synthetic receipt slot can be used", async () => {
    const loop = singleBodyConcurrentPipeline().nodes[0] as Extract<
      PipelineNode,
      { type: "loop" }
    >;
    const executor = vi.fn<NodeExecutor>();
    const { result } = await executeLoop(
      { ...loop, bodyNodeIds: [loop.id] },
      [{ id: loop.id, type: "agent", agentId: "effect", timeoutMs: 5000 }],
      executor,
      { state: { items: [{ id: "a" }] }, previousResults: new Map() },
      {}
    );

    expect(result.error).toContain("cannot contain the loop itself");
    expect(executor).not.toHaveBeenCalled();
  });
});
