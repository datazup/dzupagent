/**
 * Shared types for the loop-executor family.
 *
 * @module pipeline/loop-executor/types
 */

import type { NodeResult } from "../pipeline-runtime-types.js";

/** A predicate loop's durable position after one body node completes. */
export interface LoopBodyCheckpointProgress {
  /** Number of full iterations completed before the current iteration. */
  completedIterations: number;
  /** Zero-based body-node index to dispatch next. */
  nextBodyNodeIndex: number;
  /** Results from successful body nodes in the current iteration. */
  bodyResults: Readonly<Record<string, NodeResult>>;
}

/** Iteration output/progress retained at a completed iteration boundary. */
export interface LoopIterationCheckpointProgress {
  /** Final body-node output exposed as `loop.previous` next iteration. */
  previousOutput?: unknown;
  /** Canonical digest of the configured progress node's output. */
  progressDigest?: `sha256:${string}`;
}

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
   * Body-node cursor within `startIteration`. Omitted (or 0) starts the
   * iteration at its first body node.
   */
  startBodyNodeIndex?: number;
  /**
   * Successful body results retained for nodes before
   * `startBodyNodeIndex`. The predicate-loop executor validates this cursor
   * fail-closed before restoring the results into `previousResults`.
   */
  bodyResults?: Readonly<Record<string, NodeResult>>;
  /** Previous completed iteration's final body output. */
  previousOutput?: unknown;
  /** Previous completed iteration's canonical progress digest. */
  progressDigest?: `sha256:${string}`;
  /**
   * Invoked after each successful predicate-loop body node. The runtime uses
   * this to persist a mid-iteration cursor and its retained body results.
   * For-each loops continue to checkpoint only their completed ordered prefix.
   */
  onBodyNodeComplete?: (
    progress: LoopBodyCheckpointProgress
  ) => Promise<void>;
  /**
   * Invoked after each fully-completed iteration with the running iteration
   * count. Wired by the runtime to persist a checkpoint carrying the loop
   * cursor (`loopState`) and the accumulated `context.state`, so a crash
   * mid-loop resumes from the next iteration rather than from zero.
   */
  onIterationComplete?: (
    completedIterations: number,
    progress?: LoopIterationCheckpointProgress
  ) => Promise<void>;
}
