/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-PA2: cumulative `budgetCents`.
 *
 * A top-level node with `executionPolicy.budgetCents` is charged the
 * host-reported cost of every attempt. When the running total exceeds the
 * budget the run fails: no further attempt runs, output is discarded, state
 * is not written, and terminal catch and error edges are not consulted. A
 * budget whose cost cannot be read fails closed.
 */
import { describe, expect, it, vi } from "vitest";
import type { PipelineDefinition } from "@dzupagent/core";

import { PipelineRuntime } from "../pipeline-runtime.js";
import type {
  NodeExecutor,
  NodeLedgerLike,
  NodeResult,
} from "../pipeline-runtime-types.js";

function pipeline(nodeA: Record<string, unknown>): PipelineDefinition {
  return {
    id: "execution-policy-budget",
    name: "Execution policy budget",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "A",
    nodes: [
      { id: "A", type: "agent", agentId: "a1", ...nodeA },
      { id: "B", type: "agent", agentId: "b1" },
      { id: "H", type: "agent", agentId: "h1" },
    ],
    edges: [
      { type: "sequential", sourceNodeId: "A", targetNodeId: "B" },
      { type: "error", sourceNodeId: "A", targetNodeId: "H" },
    ],
  } as PipelineDefinition;
}

interface RunOptions {
  /** Results for node A, one per attempt. */
  attempts: NodeResult[];
  cost?: (nodeId: string, result: NodeResult) => number | undefined;
  nodeLedger?: NodeLedgerLike;
}

async function run(nodeA: Record<string, unknown>, options: RunOptions) {
  const calls: string[] = [];
  const costed: string[] = [];
  let attemptA = 0;
  const executor: NodeExecutor = async (nodeId) => {
    calls.push(nodeId);
    if (nodeId !== "A") return { nodeId, durationMs: 1, output: { ok: nodeId } };
    const result = options.attempts[attemptA] ?? options.attempts.at(-1)!;
    attemptA += 1;
    return result;
  };
  const cost = options.cost;
  const runtime = new PipelineRuntime({
    definition: pipeline(nodeA),
    nodeExecutor: executor,
    retryPolicy: { initialBackoffMs: 1, maxBackoffMs: 1 },
    ...(cost === undefined
      ? {}
      : {
          nodeAttemptCostCents: (nodeId: string, result: NodeResult) => {
            costed.push(nodeId);
            return cost(nodeId, result);
          },
        }),
    ...(options.nodeLedger === undefined
      ? {}
      : { nodeLedger: options.nodeLedger }),
  });
  const state: Record<string, unknown> = { retained: "before" };
  const result = await runtime.execute(state);
  return { result, calls, costed, state };
}

const ok = (cents: number): NodeResult => ({
  nodeId: "A",
  durationMs: 1,
  output: { cents },
});
const failed = (cents: number): NodeResult => ({
  nodeId: "A",
  durationMs: 1,
  output: undefined,
  error: "transient",
  errorMetadata: { code: "TRANSIENT", cents },
});
const centsOf = (_nodeId: string, result: NodeResult): number => {
  const fromOutput = (result.output as { cents?: number } | undefined)?.cents;
  return fromOutput ?? (result.errorMetadata?.["cents"] as number);
};

describe("PipelineRuntime executionPolicy.budgetCents", () => {
  it("completes when the total cost stays within the budget", async () => {
    const { result, calls } = await run(
      { executionPolicy: { budgetCents: 10 } },
      { attempts: [ok(10)], cost: centsOf },
    );
    expect(result.state).toBe("completed");
    expect(calls).toEqual(["A", "B"]);
  });

  it("fails the run when a successful attempt exceeds the budget", async () => {
    const { result, calls, state } = await run(
      {
        executionPolicy: { budgetCents: 10 },
        stateWrites: {
          bindings: [{ port: "cents", key: "cents", cardinality: "one" }],
        },
      },
      { attempts: [ok(11)], cost: centsOf },
    );
    expect(result.state).toBe("failed");
    expect(result.error).toBe(
      'PIPELINE_BUDGET_EXCEEDED: node "A" spent 11 of 10 cents',
    );
    expect(calls).toEqual(["A"]);
    expect(state).toEqual({ retained: "before" });
    const nodeA = result.nodeResults.get("A");
    expect(nodeA?.output).toBeUndefined();
    expect(nodeA?.errorMetadata).toEqual({
      code: "PIPELINE_BUDGET_EXCEEDED",
      costCents: 11,
      budgetCents: 10,
    });
  });

  it("charges every attempt and stops retrying once the total exceeds the budget", async () => {
    const { result, calls } = await run(
      { executionPolicy: { budgetCents: 10 }, retries: 5 },
      { attempts: [failed(4), failed(4), failed(4)], cost: centsOf },
    );
    expect(result.state).toBe("failed");
    expect(result.error).toBe(
      'PIPELINE_BUDGET_EXCEEDED: node "A" spent 12 of 10 cents',
    );
    expect(calls).toEqual(["A", "A", "A"]);
  });

  it("does not consult terminal catch or error edges", async () => {
    const { result, calls } = await run(
      {
        executionPolicy: { budgetCents: 1 },
        terminalCatch: {
          clauses: [
            { errorCodes: ["PIPELINE_BUDGET_EXCEEDED"], action: "continue" },
          ],
        },
      },
      { attempts: [failed(2)], cost: centsOf },
    );
    expect(result.state).toBe("failed");
    expect(calls).toEqual(["A"]);
  });

  it("fails closed before execution and the ledger lease without a cost source", async () => {
    const ledger: NodeLedgerLike = {
      getByIdempotencyKey: vi.fn(async () => undefined),
      acquire: vi.fn(async () => ({ owner: "w", fenceToken: 1 }) as never),
      heartbeat: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const { result, calls } = await run(
      { executionPolicy: { budgetCents: 10 } },
      { attempts: [ok(1)], nodeLedger: ledger },
    );
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/^PIPELINE_BUDGET_COST_UNKNOWN: node "A"/);
    expect(calls).toEqual([]);
    expect(ledger.acquire).not.toHaveBeenCalled();
  });

  it("fails closed when an attempt's cost is not a finite non-negative number", async () => {
    for (const bad of [undefined, -1, Number.NaN]) {
      const { result, calls } = await run(
        { executionPolicy: { budgetCents: 10 }, retries: 2 },
        { attempts: [failed(1)], cost: () => bad },
      );
      expect(result.state).toBe("failed");
      expect(result.error).toMatch(/^PIPELINE_BUDGET_COST_UNKNOWN: node "A"/);
      expect(calls).toEqual(["A"]);
    }
  });

  it("never reads the cost of a node without a budget", async () => {
    const { result, calls, costed } = await run(
      { retries: 1 },
      { attempts: [failed(50), ok(50)], cost: centsOf },
    );
    expect(result.state).toBe("completed");
    expect(calls).toEqual(["A", "A", "B"]);
    expect(costed).toEqual([]);
  });
});
