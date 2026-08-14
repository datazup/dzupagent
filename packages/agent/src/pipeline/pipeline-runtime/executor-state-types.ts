/**
 * Shared durable-resume state shapes threaded through the pipeline executor
 * and its checkpoint writer. These mirror the persisted checkpoint fields and
 * were previously inlined (verbatim) across every executor method signature;
 * naming them here removes that duplication without changing any structure.
 *
 * @module pipeline/pipeline-runtime/executor-state-types
 */

import type { LoopBodyGraphCheckpointState } from "../loop-executor/types.js";

/** One predicate-loop's iteration and optional mid-body resume cursor. */
export interface LoopCheckpointState {
  iteration: number;
  nextBodyNodeIndex?: number;
  bodyResults?: Record<string, unknown>;
  bodyGraphState?: LoopBodyGraphCheckpointState;
  previousOutput?: unknown;
  progressDigest?: `sha256:${string}`;
}

/** Per-loop-node cursor for durable loop resume (W3). */
export type LoopState = Record<string, LoopCheckpointState>;

/** Per-fork branch progress for durable fork/branch resume (W4). */
export type ForkState = Record<
  string,
  {
    branches: Record<
      string,
      {
        stateDelta: Record<string, unknown>;
        nodeResults: Record<string, unknown>;
      }
    >;
  }
>;
