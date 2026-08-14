/**
 * Predicate loop executor — runs LoopNode body nodes iteratively until
 * a continue predicate returns false or maxIterations is reached. Dispatches
 * to the for_each executor when the node carries a `forEach` contract.
 *
 * @module pipeline/loop-executor/predicate-loop
 */

import type { LoopNode, PipelineNode } from "@dzupagent/core/pipeline";
import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import type {
  NodeExecutor,
  NodeExecutionContext,
  NodeResult,
  PipelineRuntimeEvent,
  LoopMetrics,
} from "../pipeline-runtime-types.js";
import type { LoopResumeOptions } from "./types.js";
import { executeForEachLoop } from "./for-each-loop.js";

/**
 * Execute a loop node: runs body nodes in sequence per iteration,
 * evaluating the continue predicate after each iteration.
 */
export async function executeLoop(
  loopNode: LoopNode,
  bodyNodes: PipelineNode[],
  nodeExecutor: NodeExecutor,
  context: NodeExecutionContext,
  predicates: Record<string, (state: Record<string, unknown>) => boolean>,
  onEvent?: (event: PipelineRuntimeEvent) => void,
  resume?: LoopResumeOptions
): Promise<{ result: NodeResult; metrics: LoopMetrics }> {
  if (loopNode.forEach !== undefined) {
    return executeForEachLoop(
      loopNode,
      bodyNodes,
      nodeExecutor,
      context,
      onEvent,
      resume
    );
  }

  const outerLoopBinding = captureLoopBinding(context.state);
  try {
  const startTime = Date.now();
  const iterationDurations: number[] = [];
  // Resume cursor: iterations already completed before this call (W3).
  const startIteration = Math.max(0, resume?.startIteration ?? 0);
  const startBodyNodeIndex = resume?.startBodyNodeIndex ?? 0;
  const retainedBodyResults = validateBodyResumeCursor(
    loopNode,
    bodyNodes,
    startBodyNodeIndex,
    resume?.bodyResults
  );
  let iterationCount = startIteration;
  let terminationReason: LoopMetrics["terminationReason"] = "max_iterations";
  let lastBodyResult = retainedBodyResults.at(-1);
  let previousOutput = resume?.previousOutput;
  let previousProgressDigest = resume?.progressDigest;

  const progressKey = loopNode.typedWhile?.progressKey;
  if (
    progressKey !== undefined &&
    !bodyNodes.some((bodyNode) => bodyNode.id === progressKey)
  ) {
    throw new Error(
      `Loop node "${loopNode.id}": progressKey "${progressKey}" is not a body node`
    );
  }

  for (const result of retainedBodyResults) {
    context.previousResults.set(result.nodeId, result);
  }

  const continuePredicate = predicates[loopNode.continuePredicateName];
  if (!continuePredicate) {
    throw new Error(
      `Loop node "${loopNode.id}": predicate "${loopNode.continuePredicateName}" not found in predicates`
    );
  }

  // For a resumed loop, decide up front whether any further iteration should
  // run. If the cursor already reached maxIterations, or the continue predicate
  // is already satisfied against the resumed state, skip straight to terminal
  // handling without re-running the body.
  if (startIteration > 0 && startBodyNodeIndex === 0) {
    context.state["loop"] = {
      index: startIteration - 1,
      iteration: startIteration,
      isFirst: startIteration === 1,
      ...(previousOutput !== undefined ? { previous: previousOutput } : {}),
    };
    if (!continuePredicate(context.state)) {
      terminationReason = "condition_met";
    }
  }
  const alreadyTerminated =
    startIteration >= loopNode.maxIterations ||
    terminationReason === "condition_met";

  for (
    let i = startIteration;
    !alreadyTerminated && i < loopNode.maxIterations;
    i++
  ) {
    // Check cancellation
    if (context.signal?.aborted) {
      terminationReason = "cancelled";
      break;
    }

    const iterStart = Date.now();
    iterationCount++;
    context.state["loop"] = {
      index: i,
      iteration: i + 1,
      isFirst: i === 0,
      ...(previousOutput !== undefined ? { previous: previousOutput } : {}),
    };

    onEvent?.({
      type: "pipeline:loop_iteration",
      nodeId: loopNode.id,
      iteration: iterationCount,
      maxIterations: loopNode.maxIterations,
    });

    const bodyStartIndex = i === startIteration ? startBodyNodeIndex : 0;
    const iterationBodyResults = new Map<string, NodeResult>();
    if (i === startIteration) {
      for (const result of retainedBodyResults) {
        iterationBodyResults.set(result.nodeId, result);
      }
    }

    // Execute body nodes in sequence, resuming after the last body node whose
    // successful result was durably retained for this iteration.
    for (
      let bodyIndex = bodyStartIndex;
      bodyIndex < bodyNodes.length;
      bodyIndex++
    ) {
      const bodyNode = bodyNodes[bodyIndex]!;
      if (context.signal?.aborted) {
        terminationReason = "cancelled";
        break;
      }

      const bodyResult = await nodeExecutor(bodyNode.id, bodyNode, context);
      context.previousResults.set(bodyNode.id, bodyResult);
      lastBodyResult = bodyResult;

      if (bodyResult.error) {
        // Body node failed — propagate as loop failure
        const totalDuration = Date.now() - startTime;
        iterationDurations.push(Date.now() - iterStart);
        return {
          result: {
            nodeId: loopNode.id,
            output: bodyResult.output,
            durationMs: totalDuration,
            error: `Loop body node "${bodyNode.id}" failed: ${bodyResult.error}`,
          },
          metrics: {
            iterationCount,
            iterationDurations,
            converged: false,
            terminationReason: "condition_met",
          },
        };
      }

      iterationBodyResults.set(bodyNode.id, bodyResult);
      const onBodyNodeComplete = resume?.onBodyNodeComplete;
      if (onBodyNodeComplete !== undefined) {
        await withoutLoopBinding(
          context.state,
          outerLoopBinding,
          async () =>
            onBodyNodeComplete({
              completedIterations: i,
              nextBodyNodeIndex: bodyIndex + 1,
              bodyResults: Object.fromEntries(iterationBodyResults),
            })
        );
      }
    }

    iterationDurations.push(Date.now() - iterStart);

    // An interrupted body is not a completed iteration. Leave the most recent
    // body-node cursor intact so a later resume continues at the next node.
    if (terminationReason === "cancelled") {
      break;
    }

    const completedOutput = lastBodyResult?.output;
    const progressDigest =
      progressKey !== undefined
        ? digestProgressOutput(loopNode, progressKey, iterationBodyResults)
        : undefined;
    if (
      progressDigest !== undefined &&
      previousProgressDigest === progressDigest
    ) {
      return {
        result: {
          nodeId: loopNode.id,
          output: completedOutput ?? null,
          durationMs: Date.now() - startTime,
          error: `Loop "${loopNode.id}" made no progress: body node "${progressKey}" produced the same canonical output in consecutive iterations`,
        },
        metrics: {
          iterationCount,
          iterationDurations,
          converged: false,
          terminationReason: "condition_met",
        },
      };
    }

    // Durable-resume checkpoint hook (W3): persist the cursor + accumulated
    // state after each completed iteration so a crash resumes from the next
    // iteration. Runs before the continue-predicate break so the final
    // iteration's progress is recorded too.
    const onIterationComplete = resume?.onIterationComplete;
    if (onIterationComplete !== undefined) {
      await withoutLoopBinding(
        context.state,
        outerLoopBinding,
        async () =>
          onIterationComplete(iterationCount, {
            ...(completedOutput !== undefined
              ? { previousOutput: completedOutput }
              : {}),
            ...(progressDigest !== undefined ? { progressDigest } : {}),
          })
      );
    }
    previousOutput = completedOutput;
    previousProgressDigest = progressDigest;

    if (context.signal?.aborted) {
      terminationReason = "cancelled";
      break;
    }

    // Evaluate continue predicate
    const shouldContinue = continuePredicate(context.state);
    if (!shouldContinue) {
      terminationReason = "condition_met";
      break;
    }
  }

  // typedWhile is the semantic authority for typed-condition loops. Keep the
  // legacy boolean honored only for loop artifacts that carry no typedWhile
  // contract, so the two representations cannot disagree at runtime.
  const failOnExhaustion =
    loopNode.typedWhile !== undefined
      ? loopNode.typedWhile.onExhausted === "fail"
      : loopNode.failOnMaxIterations === true;
  if (terminationReason === "max_iterations" && failOnExhaustion) {
    const totalDuration = Date.now() - startTime;
    return {
      result: {
        nodeId: loopNode.id,
        output: lastBodyResult?.output ?? null,
        durationMs: totalDuration,
        error: `Loop "${loopNode.id}" reached maxIterations (${loopNode.maxIterations})`,
      },
      metrics: {
        iterationCount,
        iterationDurations,
        converged: false,
        terminationReason: "max_iterations",
      },
    };
  }

  const totalDuration = Date.now() - startTime;
  return {
    result: {
      nodeId: loopNode.id,
      output: lastBodyResult?.output ?? null,
      durationMs: totalDuration,
    },
    metrics: {
      iterationCount,
      iterationDurations,
      converged: terminationReason === "condition_met",
      terminationReason,
    },
  };
  } finally {
    restoreLoopBinding(context.state, outerLoopBinding);
  }
}

interface LoopBindingSnapshot {
  hadBinding: boolean;
  value: unknown;
}

function captureLoopBinding(
  state: Record<string, unknown>
): LoopBindingSnapshot {
  return {
    hadBinding: Object.prototype.hasOwnProperty.call(state, "loop"),
    value: state["loop"],
  };
}

function restoreLoopBinding(
  state: Record<string, unknown>,
  snapshot: LoopBindingSnapshot
): void {
  if (snapshot.hadBinding) state["loop"] = snapshot.value;
  else delete state["loop"];
}

async function withoutLoopBinding<T>(
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

function digestProgressOutput(
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

function validateBodyResumeCursor(
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
