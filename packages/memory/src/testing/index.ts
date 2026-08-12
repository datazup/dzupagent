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

export type { MemoryBenchmarkProfileV1 } from './benchmark-profile-v1.js'
export { createMemoryCompactionConformanceSuite } from './compaction-conformance-v1.js'
export { createMemoryDeletionConformanceSuite } from './deletion-conformance-v1.js'
export { createMemoryLifecycleConformanceSuite } from './lifecycle-conformance-v1.js'
export { createMemoryRecordConformanceSuite } from './record-conformance-v1.js'
export { createMemoryRetrievalConformanceSuite } from './retrieval-conformance-v1.js'
export { createMemoryStoreConformanceSuite } from './store-conformance-v1.js'
export { createMemoryWorkerConformanceSuite } from './worker-conformance-v1.js'
