/**
 * Loop executor — barrel re-exporting the decomposed loop-executor family.
 *
 * The implementation lives in `./loop-executor/`:
 *   - `predicate-loop.ts` — {@link executeLoop} (predicate-based iteration +
 *     dispatch to the for_each executor)
 *   - `for-each-loop.ts` — bounded-concurrency for_each execution
 *   - `state-path.ts` — JSON-path state read/write helpers
 *   - `predicates.ts` — built-in continue-predicate factories
 *   - `types.ts` — {@link LoopResumeOptions}
 *
 * This module preserves the exact public surface it had before the
 * ARCH-M-06 decomposition (no signature or behavior changes).
 *
 * @module pipeline/loop-executor
 */

export type { LoopResumeOptions } from "./loop-executor/types.js";
export { executeLoop } from "./loop-executor/predicate-loop.js";
export {
  stateFieldTruthy,
  qualityBelow,
  hasErrors,
} from "./loop-executor/predicates.js";
