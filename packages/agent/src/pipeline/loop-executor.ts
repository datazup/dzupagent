/**
 * Loop executor — runs LoopNode body nodes iteratively until
 * a continue predicate returns false or maxIterations is reached.
 *
 * @module pipeline/loop-executor
 */

import type { LoopNode, PipelineNode } from "@dzupagent/core/pipeline";
import type {
  NodeExecutor,
  NodeExecutionContext,
  NodeResult,
  PipelineRuntimeEvent,
  LoopMetrics,
} from "./pipeline-runtime-types.js";

// ---------------------------------------------------------------------------
// Loop executor
// ---------------------------------------------------------------------------

/**
 * Optional durable-resume hooks for {@link executeLoop} (W3).
 */
export interface LoopResumeOptions {
  /**
   * Iteration index to resume from (number of already-completed iterations).
   * Defaults to 0. Completed iterations are skipped; the loop body is not
   * re-run for them. The continue predicate is still evaluated against the
   * resumed `context.state`.
   */
  startIteration?: number;
  /**
   * Invoked after each fully-completed iteration with the running iteration
   * count. Wired by the runtime to persist a checkpoint carrying the loop
   * cursor (`loopState`) and the accumulated `context.state`, so a crash
   * mid-loop resumes from the next iteration rather than from zero.
   */
  onIterationComplete?: (completedIterations: number) => Promise<void>;
}

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

type ForEachContract = NonNullable<LoopNode["forEach"]>;

interface ResolvedStateValue {
  found: boolean;
  value: unknown;
}

async function executeForEachLoop(
  loopNode: LoopNode,
  bodyNodes: PipelineNode[],
  nodeExecutor: NodeExecutor,
  context: NodeExecutionContext,
  onEvent?: (event: PipelineRuntimeEvent) => void,
  resume?: LoopResumeOptions
): Promise<{ result: NodeResult; metrics: LoopMetrics }> {
  const startTime = Date.now();
  const contract = loopNode.forEach as ForEachContract;
  const resolvedItems = resolveStatePath(context.state, contract.source);
  if (!Array.isArray(resolvedItems.value)) {
    const totalDuration = Date.now() - startTime;
    return {
      result: {
        nodeId: loopNode.id,
        output: null,
        durationMs: totalDuration,
        error: `Loop "${loopNode.id}" for_each source "${contract.source}" did not resolve to an array`,
      },
      metrics: {
        iterationCount: 0,
        iterationDurations: [],
        converged: false,
        terminationReason: "condition_met",
      },
    };
  }

  const items = resolvedItems.value;
  if (items.length === 0) {
    if (contract.collect !== undefined) {
      setStatePath(context.state, contract.collect.into, []);
    }
    if (contract.accumulator !== undefined) {
      setStatePath(
        context.state,
        contract.accumulator.key,
        initialAccumulatorValue(context.state, contract.accumulator)
      );
    }
    onEvent?.(forEachAggregateEvent(loopNode.id, 0, true, contract.collect?.into));
    const totalDuration = Date.now() - startTime;
    return {
      result: {
        nodeId: loopNode.id,
        output: forEachOutput(contract, [], [], [], null),
        durationMs: totalDuration,
      },
      metrics: {
        iterationCount: 0,
        iterationDurations: [],
        converged: true,
        terminationReason: "condition_met",
      },
    };
  }

  const concurrency = Math.max(
    1,
    Math.min(Math.floor(contract.concurrency), items.length)
  );
  const startIndex = Math.min(
    Math.max(0, resume?.startIteration ?? 0),
    items.length
  );
  const iterationDurations = new Array<number>(items.length);
  for (let i = 0; i < startIndex; i++) {
    iterationDurations[i] = 0;
  }
  const collected = new Array<unknown>(items.length);
  if (contract.collect !== undefined) {
    const existingCollect = resolveStatePath(context.state, contract.collect.into);
    if (Array.isArray(existingCollect.value)) {
      for (let i = 0; i < Math.min(startIndex, existingCollect.value.length); i++) {
        collected[i] = existingCollect.value[i];
      }
    }
  }
  const enrichedItems = [...items];
  let accumulatorValues =
    contract.accumulator !== undefined
      ? initialAccumulatorValue(context.state, contract.accumulator)
      : [];
  if (contract.accumulator !== undefined) {
    setStatePath(context.state, contract.accumulator.key, accumulatorValues);
  }
  const results = new Array<NodeResult | undefined>(items.length);
  const completed = new Array<boolean>(items.length).fill(false);
  const attachedValues = new Array<unknown>(items.length);
  const accumulatorItems = new Array<unknown>(items.length);
  let nextIndex = startIndex;
  let flushedPrefix = startIndex;
  let firstError: NodeResult | undefined;
  let flushQueue = Promise.resolve();

  const runIteration = async (index: number): Promise<void> => {
    const iteration = index + 1;
    const iterStart = Date.now();
    onEvent?.({
      type: "pipeline:loop_iteration",
      nodeId: loopNode.id,
      iteration,
      maxIterations: items.length,
    });

    const iterationState = {
      ...context.state,
      [contract.as]: items[index],
    };
    const iterationPreviousResults = new Map(context.previousResults);
    let lastBodyResult: NodeResult | undefined;
    let completedBody = true;

    for (const bodyNode of bodyNodes) {
      if (context.signal?.aborted) {
        completedBody = false;
        break;
      }
      const bodyResult = await nodeExecutor(bodyNode.id, bodyNode, {
        ...context,
        state: iterationState,
        previousResults: iterationPreviousResults,
      });
      iterationPreviousResults.set(bodyNode.id, bodyResult);
      lastBodyResult = bodyResult;

      if (bodyResult.error) {
        firstError ??= {
          nodeId: loopNode.id,
          output: bodyResult.output,
          durationMs: Date.now() - startTime,
          error: `Loop body node "${bodyNode.id}" failed: ${bodyResult.error}`,
        };
        completedBody = false;
        break;
      }
    }

    if (!completedBody) {
      iterationDurations[index] = Date.now() - iterStart;
      return;
    }

    results[index] = lastBodyResult;
    if (contract.collect !== undefined) {
      collected[index] = collectIterationValue(
        iterationState,
        iterationPreviousResults,
        contract.collect.from
      );
    }
    attachedValues[index] = iterationState[contract.as];
    accumulatorItems[index] = iterationState[contract.as];
    iterationDurations[index] = Date.now() - iterStart;
    completed[index] = true;
    flushQueue = flushQueue.then(flushCompletedPrefix);
    await flushQueue;
  };

  const flushCompletedPrefix = async (): Promise<void> => {
    let advanced = false;
    while (completed[flushedPrefix]) {
      if (contract.attachAs !== undefined) {
        enrichedItems[flushedPrefix] = attachIterationValue(
          enrichedItems[flushedPrefix],
          contract.attachAs,
          attachedValues[flushedPrefix]
        );
      }
      if (contract.accumulator !== undefined) {
        accumulatorValues = appendAccumulatorValue(
          accumulatorValues,
          accumulatorItems[flushedPrefix],
          contract.accumulator.window
        );
      }
      flushedPrefix++;
      advanced = true;
    }

    if (!advanced) return;

    if (contract.collect !== undefined) {
      setStatePath(
        context.state,
        contract.collect.into,
        collected.slice(0, flushedPrefix)
      );
    }
    if (contract.attachAs !== undefined) {
      setStatePath(context.state, contract.source, enrichedItems);
    }
    if (contract.accumulator !== undefined) {
      setStatePath(context.state, contract.accumulator.key, accumulatorValues);
    }
    await resume?.onIterationComplete?.(flushedPrefix);
  };

  const workers = Array.from({ length: concurrency }, async () => {
    while (firstError === undefined && !context.signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await runIteration(index);
    }
  });
  await Promise.all(workers);
  await flushQueue;

  const completedIterations = iterationDurations.filter(
    (duration): duration is number => duration !== undefined
  ).length;

  if (firstError !== undefined) {
    return {
      result: firstError,
      metrics: {
        iterationCount: completedIterations,
        iterationDurations: iterationDurations.filter(
          (duration): duration is number => duration !== undefined
        ),
        converged: false,
        terminationReason: "condition_met",
      },
    };
  }

  if (context.signal?.aborted) {
    return {
      result: {
        nodeId: loopNode.id,
        output: forEachOutput(
          contract,
          collected.slice(0, completedIterations),
          enrichedItems,
          accumulatorValues,
          null
        ),
        durationMs: Date.now() - startTime,
      },
      metrics: {
        iterationCount: completedIterations,
        iterationDurations: iterationDurations.filter(
          (duration): duration is number => duration !== undefined
        ),
        converged: false,
        terminationReason: "cancelled",
      },
    };
  }

  if (contract.collect !== undefined) {
    setStatePath(context.state, contract.collect.into, collected);
  }
  if (contract.attachAs !== undefined) {
    setStatePath(context.state, contract.source, enrichedItems);
  }
  if (contract.accumulator !== undefined) {
    setStatePath(context.state, contract.accumulator.key, accumulatorValues);
  }
  for (const result of results) {
    if (result !== undefined) context.previousResults.set(result.nodeId, result);
  }
  onEvent?.(
    forEachAggregateEvent(
      loopNode.id,
      items.length,
      false,
      contract.collect?.into
    )
  );

  const totalDuration = Date.now() - startTime;
  return {
    result: {
      nodeId: loopNode.id,
      output: forEachOutput(
        contract,
        collected,
        enrichedItems,
        accumulatorValues,
        results[results.length - 1]?.output ?? null
      ),
      durationMs: totalDuration,
    },
    metrics: {
      iterationCount: items.length,
      iterationDurations,
      converged: true,
      terminationReason: "condition_met",
    },
  };
}

function collectIterationValue(
  state: Record<string, unknown>,
  previousResults: Map<string, NodeResult>,
  from: string
): unknown {
  const resolved = resolveStatePath(state, from);
  if (resolved.found) return resolved.value;
  return previousResults.get(from)?.output;
}

function forEachOutput(
  contract: ForEachContract,
  collected: unknown[],
  enrichedItems: unknown[],
  accumulatorValues: unknown[],
  fallback: unknown
): unknown {
  if (contract.collect !== undefined) return collected;
  if (contract.attachAs !== undefined) return enrichedItems;
  if (contract.accumulator !== undefined) return accumulatorValues;
  return fallback;
}

function initialAccumulatorValue(
  state: Record<string, unknown>,
  accumulator: NonNullable<ForEachContract["accumulator"]>
): unknown[] {
  const existing = resolveStatePath(state, accumulator.key);
  if (Array.isArray(existing.value)) return [...existing.value];
  if (Array.isArray(accumulator.initialValue)) {
    return [...accumulator.initialValue];
  }
  if (accumulator.initialValue === undefined) return [];
  return [accumulator.initialValue];
}

function appendAccumulatorValue(
  values: unknown[],
  value: unknown,
  window?: number
): unknown[] {
  const next = [...values, value];
  return window === undefined ? next : next.slice(-window);
}

function attachIterationValue(
  item: unknown,
  attachAs: string,
  value: unknown
): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return item;
  }
  return { ...(item as Record<string, unknown>), [attachAs]: value };
}

function resolveStatePath(
  state: Record<string, unknown>,
  source: string
): ResolvedStateValue {
  const path = source.startsWith("$.")
    ? source.slice(2)
    : source.startsWith("$")
      ? source.slice(1)
      : source;
  if (path.length === 0) {
    return { found: true, value: state };
  }

  let cursor: unknown = state;
  for (const segment of path.split(".").filter(Boolean)) {
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      !Object.prototype.hasOwnProperty.call(cursor, segment)
    ) {
      return { found: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { found: true, value: cursor };
}

function setStatePath(
  state: Record<string, unknown>,
  source: string,
  value: unknown
): void {
  const path = source.startsWith("$.")
    ? source.slice(2)
    : source.startsWith("$")
      ? source.slice(1)
      : source;
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return;

  let cursor: Record<string, unknown> = state;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      const replacement: Record<string, unknown> = {};
      cursor[segment] = replacement;
      cursor = replacement;
      continue;
    }
    cursor = next as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]!] = value;
}

function forEachAggregateEvent(
  nodeId: string,
  count: number,
  empty: boolean,
  aggregateKey?: string
): PipelineRuntimeEvent {
  return aggregateKey === undefined
    ? {
        type: "pipeline:for_each_aggregate",
        nodeId,
        count,
        order: "input",
        empty,
      }
    : {
        type: "pipeline:for_each_aggregate",
        nodeId,
        aggregateKey,
        count,
        order: "input",
        empty,
      };
}

// ---------------------------------------------------------------------------
// Built-in predicate helpers
// ---------------------------------------------------------------------------

/**
 * Creates a predicate that returns true when the given state field is truthy.
 */
export function stateFieldTruthy(
  field: string
): (state: Record<string, unknown>) => boolean {
  return (state) => Boolean(state[field]);
}

/**
 * Creates a predicate that returns true when the given numeric state field
 * is below the threshold (i.e., quality not yet reached — keep looping).
 */
export function qualityBelow(
  field: string,
  threshold: number
): (state: Record<string, unknown>) => boolean {
  return (state) => {
    const value = state[field];
    if (typeof value !== "number") return true;
    return value < threshold;
  };
}

/**
 * Creates a predicate that returns true when the given state field
 * is an array with at least one element (errors still present — keep looping).
 */
export function hasErrors(
  field: string
): (state: Record<string, unknown>) => boolean {
  return (state) => {
    const value = state[field];
    if (!Array.isArray(value)) return false;
    return value.length > 0;
  };
}
