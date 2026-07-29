/**
 * `@dzupagent/memory/testing` — stateful test infrastructure for the memory layer.
 *
 * Exposed on a subpath rather than the root barrel because
 * {@link ./report-truthfulness.js} imports `vitest`, which must never be
 * reachable from a production import of `@dzupagent/memory`.
 *
 * ```ts
 * import { createMemoryHarness } from '@dzupagent/memory/testing'
 * ```
 */

export { createMemoryHarness } from "./memory-harness.js";
export type { MemoryHarness, MemoryHarnessOptions } from "./memory-harness.js";

export {
  censusOf,
  expectPrunedCountIsTruthful,
  expectCompactedCountIsTruthful,
  expectRepeatedPassesDoNotGrow,
  expectNoDuplicateAfterRewrite,
  expectScopeIsPopulated,
} from "./report-truthfulness.js";
export type { StoreCensus, TruthfulnessTarget } from "./report-truthfulness.js";
