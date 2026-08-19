/**
 * Loop node handler for the pipeline executor.
 *
 * Wraps `executeLoop` with the runtime-specific concerns: span
 * creation, body-node lookup, event emission, and metrics attachment.
 *
 * @module pipeline/pipeline-runtime/loop-node-handler
 */

import type { PipelineNode, LoopNode } from "@dzupagent/core/pipeline";
import {
  executeLoop,
  type LoopBodyGraphControlOutcome,
  type LoopBodyGraphCheckpointState,
  type LoopResumeOptions,
} from "../loop-executor.js";
import type {
  NodeResult,
  NodeExecutionContext,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
  NodeExecutor,
} from "../pipeline-runtime-types.js";
import { omitUndefined } from "../../utils/exact-optional.js";
import {
  nodeStartedEvent,
  nodeCompletedEvent,
  nodeFailedEvent,
} from "./runtime-events.js";
import { recordIterationBudget } from "./node-side-effects.js";
import {
  nodeIdempotencyContext,
  nodeIdempotencyKey,
} from "./idempotency.js";
import type { BudgetTrackerState } from "./iteration-budget-tracker.js";

export interface LoopNodeHandlerDeps {
  config: PipelineRuntimeConfig;
  nodeMap: Map<string, PipelineNode>;
  emit: (event: PipelineRuntimeEvent) => void;
  budgetTracker: BudgetTrackerState;
  /**
   * Run this loop belongs to. Required to derive item-scoped idempotency keys
   * for `for_each` body nodes (E3), which are dispatched outside the executor's
   * standard-node path and so never reach `PipelineExecutor.keyFor`.
   */
  runId: string;
}

export interface LoopNodeHandlerResult {
  result: NodeResult;
  control?: {
    outcome: LoopBodyGraphControlOutcome;
    checkpointState: LoopBodyGraphCheckpointState;
    completedIterations: number;
  };
}

export async function handleLoop(
  deps: LoopNodeHandlerDeps,
  loopNode: LoopNode,
  runState: Record<string, unknown>,
  nodeResults: Map<string, NodeResult>,
  resume?: LoopResumeOptions
): Promise<LoopNodeHandlerResult> {
  const { config, nodeMap, emit, budgetTracker, runId } = deps;

  emit(nodeStartedEvent(loopNode.id, "loop"));

  // Start OTel span for the loop node
  const loopSpan = config.tracer?.startPhaseSpan(loopNode.id, {
    attributes: {
      "forge.pipeline.node_type": "loop",
      "forge.pipeline.phase": loopNode.id,
    },
  });

  const bodyNodes: PipelineNode[] = [];
  for (const bodyId of loopNode.bodyNodeIds) {
    const bodyNode = nodeMap.get(bodyId);
    if (!bodyNode) {
      const errorResult: NodeResult = {
        nodeId: loopNode.id,
        output: null,
        durationMs: 0,
        error: `Loop body node "${bodyId}" not found`,
      };
      if (loopSpan)
        config.tracer?.endSpanWithError(loopSpan, errorResult.error);
      return { result: errorResult };
    }
    bodyNodes.push(bodyNode);
  }

  const context: NodeExecutionContext = omitUndefined({
    state: runState,
    previousResults: nodeResults,
    signal: config.signal,
  });

  const predicates = config.predicates ?? {};
  const budgetHost = config.loopIterationBudgetReservation;
  const strictBudgetHost =
    budgetHost?.mode === "strict" ? budgetHost : undefined;
  // Runtime guard for untyped JavaScript/older serialized configuration: a
  // hard ceiling without the strict discriminant must not be silently ignored.
  const untypedItemBudget = (
    budgetHost as { itemBudgetCents?: unknown } | undefined
  )?.itemBudgetCents;
  const executionResume: LoopResumeOptions = {
    ...resume,
    ...(budgetHost === undefined
      ? {}
      : {
          reserveIterationBudget: (input) => budgetHost.reserve(input),
          // Compatibility hosts keep their optional lifecycle outside a hard
          // item ceiling. A strict host supplies all four operations by type;
          // the loop also validates them at runtime before dispatch so an
          // untyped JavaScript caller cannot bypass the fail-closed contract.
          ...(budgetHost.settle === undefined
            ? {}
            : {
                settleIterationBudget: (input) => budgetHost.settle!(input),
              }),
          ...(budgetHost.release === undefined
            ? {}
            : {
                releaseIterationBudget: (input) => budgetHost.release!(input),
              }),
          ...(budgetHost.reconcile === undefined
            ? {}
            : {
                reconcileIterationBudget: (input) =>
                  budgetHost.reconcile!(input),
              }),
          // G2b: run identity for the deterministic reservation ID, so a
          // replayed reserve after a crash presents the same id.
          budgetRunId: runId,
          ...(strictBudgetHost === undefined
            ? untypedItemBudget === undefined
              ? {}
              : {
                  itemBudgetCents:
                    typeof untypedItemBudget === "number"
                      ? untypedItemBudget
                      : Number.NaN,
                }
            : {
                budgetMode: "strict" as const,
                ...(strictBudgetHost.evidenceMode === undefined
                  ? {}
                  : { budgetEvidenceMode: strictBudgetHost.evidenceMode }),
                ...(strictBudgetHost.itemBudgetCents === undefined
                  ? {}
                  : { itemBudgetCents: strictBudgetHost.itemBudgetCents }),
                measureItemCost: (input) =>
                  strictBudgetHost.measureItemCost(input),
              }),
        }),
  };

  // Sequential predicate loops dispatch body nodes outside the executor's
  // standard-node path, so account their successful paid work here. A body
  // result is charged before its body-progress checkpoint hook runs; retained
  // results skipped during resume never pass through this wrapper and are not
  // charged twice.
  //
  // The predicate below is `forEach === undefined`, so EVERY for_each loop
  // stays on the unwrapped executor. That is deliberate and still correct
  // after packet 24-F: a for_each item is charged by the per-item
  // reserve/settle/release lifecycle inside `for-each-loop.ts` (keyed by
  // `itemIndex`), NOT by this per-body-node `recordIterationBudget` wrapper.
  // Wrapping for_each here too would double-charge each item.
  const bodyExecutor: NodeExecutor =
    loopNode.forEach === undefined
      ? async (nodeId, node, bodyContext) => {
          const bodyResult = await config.nodeExecutor(
            nodeId,
            node,
            bodyContext
          );
          if (bodyResult.error !== undefined) return bodyResult;

          const budgetAbort = recordIterationBudget(
            config,
            emit,
            budgetTracker,
            nodeId,
            bodyResult,
            loopIteration(bodyContext.state)
          );
          return budgetAbort === undefined
            ? bodyResult
            : { ...bodyResult, error: budgetAbort };
        }
      : // E3: for_each body nodes never reach `PipelineExecutor.keyFor` — they
        // are dispatched straight from the loop executor. Derive the scoped
        // key here, mirroring `fork-branch-executor`, so an item's key carries
        // its item identity instead of repeating across all N items. The scope
        // arrives on the context from `for-each-loop.ts`; when it is absent the
        // key is byte-identical to the pre-E3 form.
        async (nodeId, node, bodyContext) => {
          if (bodyContext.executionScope === undefined) {
            return config.nodeExecutor(nodeId, node, bodyContext);
          }
          const idempotencyKey = nodeIdempotencyKey(runId, node.id, {
            flowDefinition: config.definition,
            ...nodeIdempotencyContext(node),
            scope: bodyContext.executionScope,
          });
          return config.nodeExecutor(nodeId, node, {
            ...bodyContext,
            idempotencyKey,
          });
        };

  const { result, metrics, control } = await executeLoop(
    loopNode,
    bodyNodes,
    bodyExecutor,
    context,
    predicates,
    config.onEvent,
    executionResume
  );

  if (result.error) {
    if (loopSpan) config.tracer?.endSpanWithError(loopSpan, result.error);
    emit(nodeFailedEvent(loopNode.id, result.error));
  } else if (control === undefined) {
    if (loopSpan) config.tracer?.endSpanOk(loopSpan);
    emit(nodeCompletedEvent(loopNode.id, result.durationMs));
  } else if (loopSpan) {
    config.tracer?.endSpanOk(loopSpan);
  }

  // Attach metrics to output
  const output = { loopOutput: result.output, metrics };

  return {
    result: { ...result, output },
    ...(control === undefined ? {} : { control }),
  };
}

function loopIteration(state: Record<string, unknown>): number {
  const binding = state["loop"];
  if (typeof binding !== "object" || binding === null) return 0;
  const iteration = (binding as Record<string, unknown>)["iteration"];
  return typeof iteration === "number" && Number.isFinite(iteration)
    ? iteration
    : 0;
}
