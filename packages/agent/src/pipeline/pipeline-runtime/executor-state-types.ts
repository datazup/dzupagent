/**
 * Shared durable-resume state shapes threaded through the pipeline executor
 * and its checkpoint writer. These mirror the persisted checkpoint fields and
 * were previously inlined (verbatim) across every executor method signature;
 * naming them here removes that duplication without changing any structure.
 *
 * @module pipeline/pipeline-runtime/executor-state-types
 */

/** Per-loop-node iteration cursor for durable loop resume (W3). */
export type LoopState = Record<string, { iteration: number }>;

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
