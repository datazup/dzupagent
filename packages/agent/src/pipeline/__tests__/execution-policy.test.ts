/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-P1: `requireApproval` fails closed.
 *
 * A top-level node whose `executionPolicy.requireApproval` is `true` is never
 * executed: the run fails before the ledger lease and the node executor, and
 * retry, terminal catch and error edges are not consulted.
 */
import { describe, expect, it, vi } from "vitest";
import type { PipelineDefinition } from "@dzupagent/core";

import { PipelineRuntime } from "../pipeline-runtime.js";
import type {
  NodeExecutor,
  NodeLedgerLike,
} from "../pipeline-runtime-types.js";

const requireApproval = { executionPolicy: { requireApproval: true } };

function pipeline(nodeA: Record<string, unknown>): PipelineDefinition {
  return {
    id: "execution-policy",
    name: "Execution policy",
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

async function run(
  nodeA: Record<string, unknown>,
  nodeLedger?: NodeLedgerLike,
) {
  const calls: string[] = [];
  const executor: NodeExecutor = async (nodeId) => {
    calls.push(nodeId);
    return { nodeId, durationMs: 1, output: { ok: nodeId } };
  };
  const runtime = new PipelineRuntime({
    definition: pipeline(nodeA),
    nodeExecutor: executor,
    ...(nodeLedger === undefined ? {} : { nodeLedger }),
  });
  const result = await runtime.execute({ retained: "before" });
  return { result, calls };
}

describe("PipelineRuntime executionPolicy.requireApproval", () => {
  it("fails the run without executing the node", async () => {
    const { result, calls } = await run(requireApproval);
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/^PIPELINE_APPROVAL_REQUIRED: node "A"/);
    expect(calls).toEqual([]);
    expect(result.nodeResults.get("A")?.errorMetadata).toEqual({
      code: "PIPELINE_APPROVAL_REQUIRED",
    });
  });

  it("does not consult retry, terminal catch or error edges", async () => {
    const { result, calls } = await run({
      ...requireApproval,
      retries: 2,
      terminalCatch: {
        clauses: [
          { errorCodes: ["PIPELINE_APPROVAL_REQUIRED"], action: "continue" },
        ],
      },
    });
    expect(result.state).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("fails before the ledger lease", async () => {
    const ledger: NodeLedgerLike = {
      getByIdempotencyKey: vi.fn(async () => undefined),
      acquire: vi.fn(async () => ({ owner: "w", fenceToken: 1 }) as never),
      heartbeat: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const { result, calls } = await run(requireApproval, ledger);
    expect(result.state).toBe("failed");
    expect(calls).toEqual([]);
    expect(ledger.getByIdempotencyKey).not.toHaveBeenCalled();
    expect(ledger.acquire).not.toHaveBeenCalled();
  });

  it("leaves nodes without the policy unchanged", async () => {
    for (const nodeA of [{}, { executionPolicy: {} }]) {
      const { result, calls } = await run(nodeA);
      expect(result.state).toBe("completed");
      expect(calls).toEqual(["A", "B"]);
    }
  });
});
