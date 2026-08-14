/** F-R4 — typed loop exhaustion is governed by typedWhile.onExhausted. */
import type { LoopNode, PipelineNode } from "@dzupagent/core/pipeline";
import { describe, expect, it } from "vitest";

import { executeLoop } from "../pipeline/loop-executor.js";
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
});
