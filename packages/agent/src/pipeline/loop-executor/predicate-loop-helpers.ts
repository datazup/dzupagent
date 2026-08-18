import type { LoopNode, PipelineNode } from "@dzupagent/core/pipeline";
import { canonicalInputDigest } from "@dzupagent/runtime-contracts";

import type { NodeResult, LoopMetrics } from "../pipeline-runtime-types.js";
import { LoopIterationCancelledError, LoopIterationTimeoutError } from "./iteration-deadline.js";
import type { LoopExecutionResult } from "./types.js";

export function completePredicateLoop(input: {
  readonly loopNode: LoopNode;
  readonly lastBodyResult: NodeResult | undefined;
  readonly loopStartedAt: number;
  readonly iterationCount: number;
  readonly iterationDurations: number[];
  readonly terminationReason: LoopMetrics["terminationReason"];
}): LoopExecutionResult {
  const failOnExhaustion = input.loopNode.typedWhile !== undefined
    ? input.loopNode.typedWhile.onExhausted === "fail"
    : input.loopNode.failOnMaxIterations === true;
  if (input.terminationReason === "max_iterations" && failOnExhaustion) {
    return {
      result: {
        nodeId: input.loopNode.id,
        output: input.lastBodyResult?.output ?? null,
        durationMs: Date.now() - input.loopStartedAt,
        error: `Loop "${input.loopNode.id}" reached maxIterations (${input.loopNode.maxIterations})`,
      },
      metrics: {
        iterationCount: input.iterationCount,
        iterationDurations: input.iterationDurations,
        converged: false,
        terminationReason: "max_iterations",
      },
    };
  }
  return {
    result: {
      nodeId: input.loopNode.id,
      output: input.lastBodyResult?.output ?? null,
      durationMs: Date.now() - input.loopStartedAt,
    },
    metrics: {
      iterationCount: input.iterationCount,
      iterationDurations: input.iterationDurations,
      converged: input.terminationReason === "condition_met",
      terminationReason: input.terminationReason,
    },
  };
}

export function loopBodyFailure(
  loopNode: LoopNode,
  bodyResult: NodeResult | undefined,
  error: string,
  startTime: number,
  iterationCount: number,
  iterationDurations: number[]
): { result: NodeResult; metrics: LoopMetrics } {
  return {
    result: {
      nodeId: loopNode.id,
      output: bodyResult?.output ?? null,
      durationMs: Date.now() - startTime,
      error: `Loop body${bodyResult === undefined ? "" : ` node "${bodyResult.nodeId}"`} failed: ${error}`,
    },
    metrics: {
      iterationCount,
      iterationDurations,
      converged: false,
      terminationReason: error.includes("iteration budget exceeded")
        ? "budget_exceeded"
        : "condition_met",
    },
  };
}

export function isLoopIterationCancelled(
  error: unknown
): error is LoopIterationCancelledError {
  return (
    error instanceof LoopIterationCancelledError ||
    (error instanceof Error &&
      (error.name === "LoopIterationCancelledError" ||
        error.message === "Loop iteration cancelled"))
  );
}

export function isLoopIterationTimeout(error: unknown): error is LoopIterationTimeoutError {
  return (
    error instanceof LoopIterationTimeoutError ||
    (error instanceof Error && error.name === "LoopIterationTimeoutError")
  );
}

export interface LoopBindingSnapshot {
  hadBinding: boolean;
  value: unknown;
}

export function captureLoopBinding(
  state: Record<string, unknown>
): LoopBindingSnapshot {
  return {
    hadBinding: Object.prototype.hasOwnProperty.call(state, "loop"),
    value: state["loop"],
  };
}

export function restoreLoopBinding(
  state: Record<string, unknown>,
  snapshot: LoopBindingSnapshot
): void {
  if (snapshot.hadBinding) state["loop"] = snapshot.value;
  else delete state["loop"];
}

export async function withoutLoopBinding<T>(
  state: Record<string, unknown>,
  outer: LoopBindingSnapshot,
  callback: () => Promise<T>
): Promise<T> {
  const active = captureLoopBinding(state);
  restoreLoopBinding(state, outer);
  try {
    return await callback();
  } finally {
    restoreLoopBinding(state, active);
  }
}

export function digestProgressOutput(
  loopNode: LoopNode,
  progressKey: string,
  bodyResults: ReadonlyMap<string, NodeResult>
): `sha256:${string}` {
  const progressResult = bodyResults.get(progressKey);
  if (progressResult === undefined) {
    throw new Error(
      `Loop node "${loopNode.id}": progress result "${progressKey}" is unavailable at the iteration boundary`
    );
  }
  try {
    return `sha256:${canonicalInputDigest(progressResult.output)}`;
  } catch (error) {
    throw new Error(
      `Loop node "${loopNode.id}": progress result "${progressKey}" is not canonically serializable`,
      { cause: error }
    );
  }
}

export function validateBodyResumeCursor(
  loopNode: LoopNode,
  bodyNodes: PipelineNode[],
  startBodyNodeIndex: number,
  bodyResults: Readonly<Record<string, NodeResult>> | undefined
): NodeResult[] {
  if (
    !Number.isInteger(startBodyNodeIndex) ||
    startBodyNodeIndex < 0 ||
    startBodyNodeIndex > bodyNodes.length
  ) {
    throw new Error(
      `Loop node "${loopNode.id}": invalid next body-node index ${startBodyNodeIndex}`
    );
  }

  const retained = bodyResults ?? {};
  const expectedIds = new Set(
    bodyNodes.slice(0, startBodyNodeIndex).map((node) => node.id)
  );
  for (const retainedId of Object.keys(retained)) {
    if (!expectedIds.has(retainedId)) {
      throw new Error(
        `Loop node "${loopNode.id}": retained result "${retainedId}" does not precede the body cursor`
      );
    }
  }

  const ordered: NodeResult[] = [];
  for (let index = 0; index < startBodyNodeIndex; index++) {
    const expectedNode = bodyNodes[index]!;
    const result = retained[expectedNode.id];
    if (
      result === undefined ||
      result.nodeId !== expectedNode.id ||
      typeof result.durationMs !== "number"
    ) {
      throw new Error(
        `Loop node "${loopNode.id}": missing or invalid retained result for body node "${expectedNode.id}"`
      );
    }
    ordered.push(result);
  }
  return ordered;
}
