/**
 * Predicate loop executor — runs LoopNode body nodes iteratively until
 * a continue predicate returns false or maxIterations is reached. Dispatches
 * to the for_each executor when the node carries a `forEach` contract.
 *
 * @module pipeline/loop-executor/predicate-loop
 */

import type { LoopNode, PipelineNode } from "@dzupagent/core/pipeline";
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

  const startTime = Date.now();
  const iterationDurations: number[] = [];
  // Resume cursor: iterations already completed before this call (W3).
  const startIteration = Math.max(0, resume?.startIteration ?? 0);
  let iterationCount = startIteration;
  let terminationReason: LoopMetrics["terminationReason"] = "max_iterations";
  let lastBodyResult: NodeResult | undefined;

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
  if (startIteration > 0 && !continuePredicate(context.state)) {
    terminationReason = "condition_met";
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

    onEvent?.({
      type: "pipeline:loop_iteration",
      nodeId: loopNode.id,
      iteration: iterationCount,
      maxIterations: loopNode.maxIterations,
    });

    // Execute body nodes in sequence
    for (const bodyNode of bodyNodes) {
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
    }

    iterationDurations.push(Date.now() - iterStart);

    // Durable-resume checkpoint hook (W3): persist the cursor + accumulated
    // state after each completed iteration so a crash resumes from the next
    // iteration. Runs before the continue-predicate break so the final
    // iteration's progress is recorded too.
    await resume?.onIterationComplete?.(iterationCount);

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

  // If we exhausted iterations and failOnMaxIterations is set
  if (terminationReason === "max_iterations" && loopNode.failOnMaxIterations) {
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
}
