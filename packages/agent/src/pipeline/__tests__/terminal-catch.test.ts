/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-C1: exact-code terminal catch.
 *
 * When a top-level node's final result fails with an `errorMetadata.code`
 * listed in its `terminalCatch`, the clause decides the outcome: `continue`
 * follows the normal edges, `complete` ends the run as completed, and `fail`
 * fails the run with the clause's stable code. Unlisted or missing codes keep
 * today's behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineDefinition } from "@dzupagent/core";

import { PipelineRuntime } from "../pipeline-runtime.js";
import type { NodeExecutor, NodeResult } from "../pipeline-runtime-types.js";

const terminalCatch = {
  clauses: [
    { errorCodes: ["NOT_FOUND"], action: "continue" },
    { errorCodes: ["ALREADY_DONE"], action: "complete" },
    { errorCodes: ["BAD_INPUT"], action: "fail", failureCode: "DRAFT_REJECTED" },
  ],
};

function pipeline(nodeA: Record<string, unknown>): PipelineDefinition {
  return {
    id: "terminal-catch",
    name: "Terminal catch",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "A",
    nodes: [
      { id: "A", type: "agent", agentId: "a1", terminalCatch, ...nodeA },
      { id: "B", type: "agent", agentId: "b1" },
    ],
    edges: [{ type: "sequential", sourceNodeId: "A", targetNodeId: "B" }],
  } as PipelineDefinition;
}

type Scripted = Omit<NodeResult, "nodeId" | "durationMs">;

function failure(code: string | undefined, message = "primitive failed"): Scripted {
  return {
    output: undefined,
    error: message,
    ...(code === undefined ? {} : { errorMetadata: { code } }),
  };
}

async function run(aResults: Scripted[], nodeA: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let aCalls = 0;
  const executor: NodeExecutor = async (nodeId) => {
    calls.push(nodeId);
    if (nodeId === "A") {
      const next = aResults[Math.min(aCalls, aResults.length - 1)]!;
      aCalls += 1;
      return { nodeId, durationMs: 1, ...next };
    }
    return { nodeId, durationMs: 1, output: { ok: nodeId } };
  };
  const state: Record<string, unknown> = { retained: "before" };
  const runtime = new PipelineRuntime({
    definition: pipeline(nodeA),
    nodeExecutor: executor,
  });
  const pending = runtime.execute(state);
  await vi.runAllTimersAsync();
  return { result: await pending, calls };
}

describe("PipelineRuntime terminalCatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("continue: follows the normal edge and keeps the failed result", async () => {
    const { result, calls } = await run([failure("NOT_FOUND")]);
    expect(result.state).toBe("completed");
    expect(calls).toEqual(["A", "B"]);
    expect(result.nodeResults.get("A")?.error).toBe("primitive failed");
    expect(result.nodeResults.get("B")?.output).toEqual({ ok: "B" });
  });

  it("complete: ends the run as completed without running the successor", async () => {
    const { result, calls } = await run([failure("ALREADY_DONE")]);
    expect(result.state).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(calls).toEqual(["A"]);
  });

  it("fail: fails the run with the clause failure code verbatim", async () => {
    const { result, calls } = await run([failure("BAD_INPUT")]);
    expect(result.state).toBe("failed");
    expect(result.error).toBe("DRAFT_REJECTED");
    expect(calls).toEqual(["A"]);
  });

  it("an unlisted code keeps today's failure", async () => {
    const { result, calls } = await run([failure("OTHER")]);
    expect(result.state).toBe("failed");
    expect(result.error).toBe("primitive failed");
    expect(calls).toEqual(["A"]);
  });

  it("a code that appears only in the message is not caught", async () => {
    const { result, calls } = await run([failure(undefined, "NOT_FOUND")]);
    expect(result.state).toBe("failed");
    expect(calls).toEqual(["A"]);
  });

  it("is consulted only after retries are exhausted", async () => {
    const { result, calls } = await run(
      [failure("NOT_FOUND"), failure("NOT_FOUND")],
      { retries: 1, retryPolicy: { initialBackoffMs: 1 } },
    );
    expect(result.state).toBe("completed");
    expect(calls).toEqual(["A", "A", "B"]);
  });

  it("does nothing when the node succeeds", async () => {
    const { result, calls } = await run([{ output: { ok: "A" } }]);
    expect(result.state).toBe("completed");
    expect(calls).toEqual(["A", "B"]);
  });
});
