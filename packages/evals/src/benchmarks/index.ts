// Benchmark types
export type {
  BenchmarkCategory,
  BenchmarkSuite,
  BenchmarkResult,
  BenchmarkComparison,
} from './benchmark-types.js';

// Benchmark runner
export { runBenchmark, compareBenchmarks } from './benchmark-runner.js';

// Benchmark suites
export { CODE_GEN_SUITE } from './suites/code-gen.js';
export { QA_SUITE } from './suites/qa.js';
export { TOOL_USE_SUITE } from './suites/tool-use.js';
export { MULTI_TURN_SUITE } from './suites/multi-turn.js';
export { VECTOR_SEARCH_SUITE } from './suites/vector-search.js';
export {
  SELF_CORRECTION_SUITE,
  CORRECTION_SCENARIOS,
  ALL_CORRECTION_CATEGORIES,
  createSelfCorrectionSuite,
} from './suites/self-correction.js';
export type { CorrectionScenario, CorrectionCategory } from './suites/self-correction.js';

// Benchmark trend detection
export { BenchmarkTrendStore, InMemoryBenchmarkRunStore } from './benchmark-trend.js';
export type { BenchmarkRunRecord, BenchmarkRunStore, BenchmarkTrendResult } from './benchmark-trend.js';

// Learning curve benchmark
export {
  runLearningCurveBenchmark,
  generateSimulatedRun,
  createLearningCurveSuite,
  QUALITY_PATTERNS,
} from './suites/learning-curve.js';
export type {
  LearningCurveConfig,
  LearningCurveResult,
  LearningCurveStore,
  SimulatedRunAnalysis,
  StoreItem,
} from './suites/learning-curve.js';
