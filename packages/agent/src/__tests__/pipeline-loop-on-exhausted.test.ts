/** F-R4 — typed loop exhaustion is governed by typedWhile.onExhausted. */
import type { LoopNode, PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { describe, expect, it } from "vitest";

import { executeLoop } from "../pipeline/loop-executor.js";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import type {
  NodeExecutionContext,
  NodeExecutor,
} from "../pipeline/pipeline-runtime-types.js";

const bodyNodes: PipelineNode[] = [
  { id: "body", type: "agent", agentId: "agent", timeoutMs: 1000 },
];

const executor: NodeExecutor = async (nodeId) => ({
  nodeId,
  output: "ok",
  durationMs: 0,
});

function loop(onExhausted: "fail" | "continue", legacyFlag: boolean): LoopNode {
  return {
    id: "loop",
    type: "loop",
    bodyNodeIds: ["body"],
    maxIterations: 1,
    continuePredicateName: "always",
    failOnMaxIterations: legacyFlag,
    typedWhile: {
      conditionSchema: "dzupagent.flowTypedCondition/v1",
      condition: { op: "literal", value: true },
      onExhausted,
    },
  };
}

function context(): NodeExecutionContext {
  return { state: {}, previousResults: new Map() };
}

describe("F-R4 — typed loop onExhausted runtime branch", () => {
  it("continues after exhaustion even when the legacy boolean says fail", async () => {
    const { result, metrics } = await executeLoop(
      loop("continue", true),
      bodyNodes,
      executor,
      context(),
      { always: () => true }
    );

    expect(result.error).toBeUndefined();
    expect(metrics.terminationReason).toBe("max_iterations");
  });

  it("fails after exhaustion even when the legacy boolean says continue", async () => {
    const { result, metrics } = await executeLoop(
      loop("fail", false),
      bodyNodes,
      executor,
      context(),
      { always: () => true }
    );

    expect(result.error).toContain("maxIterations");
    expect(metrics.terminationReason).toBe("max_iterations");
  });

  it("keeps failOnMaxIterations authoritative for legacy loops", async () => {
    const legacy = loop("continue", true);
    delete legacy.typedWhile;
    const { result } = await executeLoop(
      legacy,
      bodyNodes,
      executor,
      context(),
      { always: () => true }
    );

    expect(result.error).toContain("maxIterations");
  });

  it("plumbs a host-authoritative iteration reservation before body dispatch", async () => {
    const bodyRuns: string[] = [];
    const reservations: unknown[] = [];
    const settlements: unknown[] = [];
    const budgetedLoop = loop("continue", false);
    budgetedLoop.typedWhile = {
      ...budgetedLoop.typedWhile!,
      iterationBudgetCents: 10,
    };
    const runtime = new PipelineRuntime({
      definition: {
        id: "loop-budget-admission",
        name: "LoopBudgetAdmission",
        version: "1.0.0",
        schemaVersion: "1.0.0",
        entryNodeId: "loop",
        nodes: [budgetedLoop, ...bodyNodes],
        edges: [],
      },
      predicates: { always: () => true },
      loopIterationBudgetReservation: {
        mode: "strict",
        reserve: (input) => {
          reservations.push(input);
          return { status: "reserved", reservedCostCents: 8 };
        },
        settle: (input) => {
          settlements.push(input);
        },
        release: () => undefined,
        reconcile: () => ({ status: "unknown" }),
        measureItemCost: () => ({ status: "known", costCents: 3 }),
      },
      nodeExecutor: async (nodeId) => {
        bodyRuns.push(nodeId);
        return { nodeId, output: "ok", durationMs: 1 };
      },
    });

    const result = await runtime.execute();

    expect(result.state).toBe("completed");
    expect(bodyRuns).toEqual(["body"]);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      loopNodeId: "loop",
      iteration: 1,
      budgetCents: 10,
      bodyNodeIds: ["body"],
      reservationId: expect.stringContaining(
        ":iteration:loop:1"
      ),
    });
    expect(settlements).toEqual([
      expect.objectContaining({
        loopNodeId: "loop",
        iteration: 1,
        reservedCostCents: 8,
        actualCostCents: 3,
      }),
    ]);
  });
});
