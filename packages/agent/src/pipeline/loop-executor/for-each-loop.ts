/**
 * for_each loop executor — runs body nodes once per item of a resolved
 * array source, with bounded concurrency, ordered prefix flushing,
 * optional collect/attach/accumulator aggregation, and durable resume.
 *
 * @module pipeline/loop-executor/for-each-loop
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
import { resolveStatePath, setStatePath } from "./state-path.js";

type ForEachContract = NonNullable<LoopNode["forEach"]>;

export async function executeForEachLoop(
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
    onEvent?.(forEachAggregateEvent(loopNode.id, 0, true, contract));
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
    const existingCollect = resolveStatePath(
      context.state,
      contract.collect.into
    );
    if (Array.isArray(existingCollect.value)) {
      for (
        let i = 0;
        i < Math.min(startIndex, existingCollect.value.length);
        i++
      ) {
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
      let bodyResult: NodeResult;
      try {
        bodyResult = await nodeExecutor(bodyNode.id, bodyNode, {
          ...context,
          state: iterationState,
          previousResults: iterationPreviousResults,
        });
      } catch (error) {
        bodyResult = {
          nodeId: bodyNode.id,
          output: null,
          durationMs: Date.now() - iterStart,
          error: error instanceof Error ? error.message : String(error),
        };
      }
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
    while (
      !(contract.failFast === true && firstError !== undefined) &&
      !context.signal?.aborted
    ) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await runIteration(index);
    }
  });
  await Promise.all(workers);
  await flushQueue;
  await flushCompletedPrefix();

  const completedIterations = iterationDurations.filter(
    (duration): duration is number => duration !== undefined
  ).length;

  if (firstError !== undefined) {
    const partialCollected = collected.filter(
      (_value, index) => completed[index] === true
    );
    const partialEnrichedItems = enrichedItems.filter(
      (_value, index) => completed[index] === true
    );
    return {
      result: {
        ...firstError,
        output: forEachOutput(
          contract,
          partialCollected,
          partialEnrichedItems,
          accumulatorValues,
          firstError.output
        ),
      },
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
    if (result !== undefined)
      context.previousResults.set(result.nodeId, result);
  }
  onEvent?.(forEachAggregateEvent(loopNode.id, items.length, false, contract));

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

function forEachAggregateEvent(
  nodeId: string,
  count: number,
  empty: boolean,
  contract: ForEachContract
): PipelineRuntimeEvent {
  const aggregateKeys = forEachAggregateKeys(contract);
  return {
    type: "pipeline:for_each_aggregate",
    nodeId,
    ...(contract.collect !== undefined
      ? { aggregateKey: contract.collect.into }
      : {}),
    ...(aggregateKeys.length > 0 ? { aggregateKeys } : {}),
    source: contract.source,
    ...(contract.attachAs !== undefined ? { attachAs: contract.attachAs } : {}),
    ...(contract.accumulator !== undefined
      ? { accumulatorKey: contract.accumulator.key }
      : {}),
    count,
    order: "input",
    empty,
  };
}

function forEachAggregateKeys(contract: ForEachContract): string[] {
  const keys: string[] = [];
  if (contract.collect !== undefined) keys.push(contract.collect.into);
  if (contract.attachAs !== undefined) {
    keys.push(`${contract.source}.${contract.attachAs}`);
  }
  if (contract.accumulator !== undefined) keys.push(contract.accumulator.key);
  return keys;
}
