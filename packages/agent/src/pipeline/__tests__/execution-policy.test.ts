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

/**
 * DZUPAGENT-AGENT-H-65: loop, for-each and fork body executors call the node
 * executor directly, so a body-node `executionPolicy` would be ignored (fail
 * open). The definition is refused before any node executes instead.
 */
describe("PipelineRuntime executionPolicy on body nodes", () => {
  function forEachPipeline(bodyExtra: Record<string, unknown>): PipelineDefinition {
    return {
      id: "execution-policy-for-each",
      name: "Execution policy for-each",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      entryNodeId: "loop-items",
      nodes: [
        {
          id: "loop-items",
          type: "loop",
          bodyNodeIds: ["step-a"],
          maxIterations: 10,
          continuePredicateName: "forEach__item__predicate",
          forEach: {
            source: "$.items",
            as: "item",
            order: "input",
            concurrency: 1,
            empty: { body: "skip", aggregate: "empty-array" },
          },
        },
        { id: "step-a", type: "agent", agentId: "a", ...bodyExtra },
      ],
      edges: [],
    } as PipelineDefinition;
  }

  function forkPipeline(branchExtra: Record<string, unknown>): PipelineDefinition {
    return {
      id: "execution-policy-fork",
      name: "Execution policy fork",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      entryNodeId: "F",
      nodes: [
        { id: "F", type: "fork", forkId: "fk1" },
        { id: "a1", type: "agent", agentId: "a", ...branchExtra },
        { id: "b1", type: "agent", agentId: "b" },
        { id: "J", type: "join", forkId: "fk1" },
        { id: "done", type: "agent", agentId: "d", ...requireApproval },
      ],
      edges: [
        { type: "sequential", sourceNodeId: "F", targetNodeId: "a1" },
        { type: "sequential", sourceNodeId: "F", targetNodeId: "b1" },
        { type: "sequential", sourceNodeId: "a1", targetNodeId: "J" },
        { type: "sequential", sourceNodeId: "b1", targetNodeId: "J" },
        { type: "sequential", sourceNodeId: "J", targetNodeId: "done" },
      ],
    } as PipelineDefinition;
  }

  async function execute(definition: PipelineDefinition, state: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const executor: NodeExecutor = async (nodeId) => {
      calls.push(nodeId);
      return { nodeId, durationMs: 1, output: { ok: nodeId } };
    };
    const runtime = new PipelineRuntime({ definition, nodeExecutor: executor });
    const outcome = runtime.execute(state);
    return { outcome, calls };
  }

  it("refuses requireApproval on a for-each body node before any node executes", async () => {
    const { outcome, calls } = await execute(forEachPipeline(requireApproval), {
      items: [{ id: "x" }],
    });
    await expect(outcome).rejects.toThrow(
      /EXECUTION_POLICY_ON_BODY_NODE|executionPolicy \(requireApproval\) but runs as a body node of for-each node "loop-items"/,
    );
    expect(calls).toEqual([]);
  });

  it("refuses budgetCents and timeoutMs policies on a for-each body node", async () => {
    for (const policy of [{ budgetCents: 5 }, { timeoutMs: 100 }]) {
      const { outcome, calls } = await execute(
        forEachPipeline({ executionPolicy: policy }),
        { items: [{ id: "x" }] },
      );
      await expect(outcome).rejects.toThrow(/runs as a body node of for-each node "loop-items"/);
      expect(calls).toEqual([]);
    }
  });

  it("refuses requireApproval on a fork branch node before any node executes", async () => {
    const { outcome, calls } = await execute(forkPipeline(requireApproval));
    await expect(outcome).rejects.toThrow(
      /Node "a1" declares executionPolicy \(requireApproval\) but runs as a body node of fork node "F"/,
    );
    expect(calls).toEqual([]);
  });

  it("still admits a policy on a top-level node after the join", async () => {
    const { outcome, calls } = await execute(forkPipeline({}));
    const result = await outcome;
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/^PIPELINE_APPROVAL_REQUIRED: node "done"/);
    expect([...calls].sort()).toEqual(["a1", "b1"]);
  });
});
