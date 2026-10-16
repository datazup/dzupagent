/**
 * The dependency bag the per-stage executors receive from `PipelineExecutor`.
 *
 * Kept in its own type-only module so `stage-dispatch.ts` can re-export the
 * loop stage (`stage-dispatch-loop.ts`) without an import cycle.
 *
 * @module pipeline/executor-internals/stage-context
 */

import type { PipelineNode, LoopNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from "../pipeline-runtime-types.js";
import type { handleFork as handleForkNode } from "./fork-branch-executor.js";
import type {
  LoopBodyGraphScheduleInput,
  LoopBodyGraphScheduleResult,
} from "../loop-executor/types.js";
import type { BudgetTrackerState } from "./iteration-budget-tracker.js";
import type { RecursiveForkRuntimeDeps } from "./recursive-fork-runtime.js";
import type { RunFrame } from "./run-frame.js";

/** Dependency bag exposing the executor's helpers to the stage functions. */
export interface StageContext {
  config: PipelineRuntimeConfig;
  nodeMap: Map<string, PipelineNode>;
  /** Persist a checkpoint per the configured strategy. */
  saveCheckpoint: (frame: RunFrame) => Promise<void>;
  /** Persist an outer control boundary regardless of the periodic strategy. */
  saveControlCheckpoint: (
    frame: RunFrame,
    suspendedAtNodeId?: string,
  ) => Promise<void>;
  /** First next-node id for `nodeId`, evaluated against current state. */
  next: (
    nodeId: string,
    runState: Record<string, unknown>,
  ) => string | undefined;
  /** Record the stable idempotency key for a completed node. */
  recordIdempotencyKey: (
    keys: Record<string, string>,
    runId: string,
    node: PipelineNode,
  ) => void;
  /** Resolve the error-edge target for a node given an error, if any. */
  errorEdgeFor: (nodeId: string, error: unknown) => string | undefined;
  /** Build the dependency bag for fork/branch fan-out. */
  forkDeps: (runId: string) => Parameters<typeof handleForkNode>[0];
  recursiveForkDeps: () => RecursiveForkRuntimeDeps;
  /** Mutable global cost accumulator shared with standard-node dispatch. */
  budgetTracker: BudgetTrackerState;
  emit: (event: PipelineRuntimeEvent) => void;
  setState: (next: PipelineState) => void;
  runResult: (
    runId: string,
    state: PipelineState,
    nodeResults: Map<string, NodeResult>,
    totalDurationMs: number,
    /** Failure reason; only meaningful when `state` is `"failed"`. */
    error?: string,
  ) => PipelineRunResult;
  /** Execute one bounded compiler-lowered loop body through the graph walker. */
  scheduleLoopBodyGraph: (
    loopNode: LoopNode,
    frame: RunFrame,
    input: LoopBodyGraphScheduleInput,
  ) => Promise<LoopBodyGraphScheduleResult>;
}
