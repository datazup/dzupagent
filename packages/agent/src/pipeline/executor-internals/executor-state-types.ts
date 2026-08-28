/**
 * Shared durable-resume state shapes threaded through the pipeline executor
 * and its checkpoint writer. These mirror the persisted checkpoint fields and
 * were previously inlined (verbatim) across every executor method signature;
 * naming them here removes that duplication without changing any structure.
 *
 * @module pipeline/executor-internals/executor-state-types
 */

import type {
  PipelineForEachItemEconomics,
  PipelineForEachItemOutcome,
  PipelineForEachItemFrame,
  PipelineForEachItemTerminalRecord,
} from "@dzupagent/core/pipeline";

import type { LoopBodyGraphCheckpointState } from "../loop-executor/types.js";

/** One predicate-loop's iteration and optional mid-body resume cursor. */
export interface LoopCheckpointState {
  iteration: number;
  nextBodyNodeIndex?: number;
  bodyResults?: Record<string, unknown>;
  bodyGraphState?: LoopBodyGraphCheckpointState;
  /** Strict predicate-loop reservation state for the current iteration. */
  iterationOutcome?: PipelineForEachItemOutcome;
  /** Exact reservation/settlement bytes shared with the for_each contract. */
  iterationEconomics?: PipelineForEachItemEconomics;
  /**
   * Pre-G1 singular spelling, still read so checkpoints written before G1
   * resume. Never written; normalised into `itemFrames` on read.
   *
   * @deprecated Use {@link itemFrames}.
   */
  itemFrame?: PipelineForEachItemFrame;
  /**
   * Mid-item progress for every in-flight `for_each` item (G1), keyed by the
   * item's zero-based index as a decimal string. Absent when the loop sits on
   * an item boundary, which keeps iteration-only checkpoints byte-identical.
   * Mirrors `PipelineLoopCheckpointState.itemFrames` in the core contract.
   */
  itemFrames?: Record<string, PipelineForEachItemFrame>;
  /**
   * Terminal outcome per `for_each` item (24-G), keyed the same way as
   * {@link itemFrames}. Mirrors `PipelineLoopCheckpointState.itemOutcomes`.
   *
   * Unlike `itemFrames` this SURVIVES prefix retirement: a frame answers
   * "where do I resume?" and is retired once the prefix covers its item, while
   * a terminal outcome answers "what happened, and what did it cost?" — a
   * question asked mostly about items already behind the prefix.
   */
  itemOutcomes?: Record<string, PipelineForEachItemTerminalRecord>;
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
