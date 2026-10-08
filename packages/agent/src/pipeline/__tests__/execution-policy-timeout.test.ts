/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-PA3: cumulative `timeoutMs`.
 *
 * A top-level node with `executionPolicy.timeoutMs` accumulates each
 * attempt's reported `durationMs` plus each retry backoff. When the total
 * exceeds the limit the run fails: no further attempt runs, output is
 * discarded, state is not written, and terminal catch and error edges are not
 * consulted. An unreadable duration fails closed.
 */
import { describe, expect, it } from "vitest";
import type { PipelineDefinition } from "@dzupagent/core";

import { PipelineRuntime } from "../pipeline-runtime.js";
import type { NodeExecutor, NodeResult } from "../pipeline-runtime-types.js";

function pipeline(nodeA: Record<string, unknown>): PipelineDefinition {
  return {
    id: "execution-policy-timeout",
    name: "Execution policy timeout",
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
  backoffMs?: number;
  cost?: (nodeId: string, result: NodeResult) => number | undefined;
}

async function run(nodeA: Record<string, unknown>, options: RunOptions) {
  const calls: string[] = [];
  let attemptA = 0;
  const executor: NodeExecutor = async (nodeId) => {
    calls.push(nodeId);
    if (nodeId !== "A") return { nodeId, durationMs: 1, output: { ok: nodeId } };
    const result = options.attempts[attemptA] ?? options.attempts.at(-1)!;
    attemptA += 1;
    return result;
  };
  const backoffMs = options.backoffMs ?? 1;
  const runtime = new PipelineRuntime({
    definition: pipeline(nodeA),
    nodeExecutor: executor,
    retryPolicy: { initialBackoffMs: backoffMs, maxBackoffMs: backoffMs },
    ...(options.cost === undefined
      ? {}
      : { nodeAttemptCostCents: options.cost }),
  });
  const state: Record<string, unknown> = { retained: "before" };
  const result = await runtime.execute(state);
  return { result, calls, state };
}

const ok = (durationMs: number): NodeResult => ({
  nodeId: "A",
  durationMs,
  output: { durationMs },
});
const failed = (durationMs: number): NodeResult => ({
  nodeId: "A",
  durationMs,
  output: undefined,
  error: "transient",
  errorMetadata: { code: "TRANSIENT" },
});

describe("PipelineRuntime executionPolicy.timeoutMs", () => {
  it("completes when attempts and backoff stay within the limit", async () => {
    const { result, calls } = await run(
      { executionPolicy: { timeoutMs: 10 }, retries: 1 },
      { attempts: [failed(4), ok(4)], backoffMs: 2 },
    );
    expect(result.state).toBe("completed");
    expect(calls).toEqual(["A", "A", "B"]);
  });

  it("fails the run when a successful attempt exceeds the limit", async () => {
    const { result, calls, state } = await run(
      {
        executionPolicy: { timeoutMs: 10 },
        stateWrites: {
          bindings: [
            { port: "durationMs", key: "durationMs", cardinality: "one" },
          ],
        },
      },
      { attempts: [ok(11)] },
    );
    expect(result.state).toBe("failed");
    expect(result.error).toBe(
      'PIPELINE_TIMEOUT_EXCEEDED: node "A" used 11 of 10 ms',
    );
    expect(calls).toEqual(["A"]);
    expect(state).toEqual({ retained: "before" });
    const nodeA = result.nodeResults.get("A");
    expect(nodeA?.output).toBeUndefined();
    expect(nodeA?.errorMetadata).toEqual({
      code: "PIPELINE_TIMEOUT_EXCEEDED",
      durationMs: 11,
      timeoutMs: 10,
    });
  });

  it("sums attempt durations and backoff across retries", async () => {
    const { result, calls } = await run(
      { executionPolicy: { timeoutMs: 10 }, retries: 5 },
      { attempts: [failed(4), failed(4)], backoffMs: 2 },
    );
    expect(result.state).toBe("failed");
    // 4 + 2 (backoff) + 4 = 10 is within; the next backoff makes it 12.
    expect(result.error).toBe(
      'PIPELINE_TIMEOUT_EXCEEDED: node "A" used 12 of 10 ms',
    );
    expect(calls).toEqual(["A", "A"]);
  });

  it("fails before waiting when the next backoff would exceed the limit", async () => {
    const started = Date.now();
    const { result, calls } = await run(
      { executionPolicy: { timeoutMs: 1000 }, retries: 3 },
      { attempts: [failed(5)], backoffMs: 60_000 },
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.state).toBe("failed");
    expect(result.error).toBe(
      'PIPELINE_TIMEOUT_EXCEEDED: node "A" used 60005 of 1000 ms',
    );
    expect(calls).toEqual(["A"]);
  });

  it("is checked before the budget, as in the local host oracle", async () => {
    const { result } = await run(
      { executionPolicy: { timeoutMs: 10, budgetCents: 1 } },
      { attempts: [ok(11)], cost: () => 5 },
    );
    expect(result.error).toBe(
      'PIPELINE_TIMEOUT_EXCEEDED: node "A" used 11 of 10 ms',
    );
  });

  it("does not consult terminal catch or error edges", async () => {
    const { result, calls } = await run(
      {
        executionPolicy: { timeoutMs: 1 },
        terminalCatch: {
          clauses: [
            { errorCodes: ["PIPELINE_TIMEOUT_EXCEEDED"], action: "continue" },
          ],
        },
      },
      { attempts: [failed(2)] },
    );
    expect(result.state).toBe("failed");
    expect(calls).toEqual(["A"]);
  });

  it("fails closed when an attempt's duration is not a finite non-negative number", async () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { result, calls } = await run(
        { executionPolicy: { timeoutMs: 10 }, retries: 2 },
        { attempts: [failed(bad)] },
      );
      expect(result.state).toBe("failed");
      expect(result.error).toMatch(
        /^PIPELINE_TIMEOUT_DURATION_UNKNOWN: node "A"/,
      );
      expect(calls).toEqual(["A"]);
    }
  });

  it("leaves a node without the limit unchanged", async () => {
    const { result, calls } = await run(
      { retries: 1 },
      { attempts: [failed(500), ok(500)] },
    );
    expect(result.state).toBe("completed");
    expect(calls).toEqual(["A", "A", "B"]);
  });
});
