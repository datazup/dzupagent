// Types
export type {
  EvalResult,
  EvalScorer,
  EvalCase,
  EvalSuite,
  EvalRunResult,
  // Enhanced types (ECO-111)
  EvalInput,
  ScorerConfig,
  ScorerResult,
  Scorer,
} from './types.js';

// Scorers (legacy)
export { DeterministicScorer } from './deterministic-scorer.js';
export type { DeterministicScorerConfig } from './deterministic-scorer.js';

export { LLMJudgeScorer } from './llm-judge-scorer.js';
export type { LLMJudgeConfig } from './llm-judge-scorer.js';

export { CompositeScorer } from './composite-scorer.js';
export type { CompositeScorerConfig } from './composite-scorer.js';

// Enhanced scorers (ECO-112, ECO-113)
export { createLLMJudge } from './scorers/llm-judge-enhanced.js';
export type { LLMJudgeEnhancedConfig } from './scorers/llm-judge-enhanced.js';

export {
  createJSONSchemaScorer,
  createKeywordScorer,
  createLatencyScorer,
  createCostScorer,
} from './scorers/deterministic-enhanced.js';
export type {
  JSONSchemaScorerConfig,
  KeywordScorerConfig,
  LatencyScorerConfig,
  CostScorerConfig,
} from './scorers/deterministic-enhanced.js';

export { LlmJudgeScorer } from './scorers/llm-judge-scorer.js';
export type {
  JudgeDimension,
  JudgeScore,
  JudgeAnchor,
  JudgeScorerConfig,
  JudgeScorerResult,
} from './scorers/llm-judge-scorer.js';

export { STANDARD_CRITERIA, CODE_CRITERIA, FIVE_POINT_RUBRIC, TEN_POINT_RUBRIC } from './scorers/criteria.js';
export type { JudgeCriterion } from './scorers/criteria.js';

// Runner (legacy)
export { runEvalSuite } from './eval-runner.js';

// Enhanced Runner (ECO-115)
export { EvalRunner, reportToMarkdown, reportToJSON, reportToCIAnnotations } from './runner/enhanced-runner.js';
export type {
  EvalRunnerConfig,
  EvalReportEntry,
  EvalReport,
  RegressionResult,
} from './runner/enhanced-runner.js';

// Dataset (ECO-114)
export { EvalDataset } from './dataset/eval-dataset.js';
export type { EvalEntry, DatasetMetadata } from './dataset/eval-dataset.js';

// Benchmarks (ECO-179)
export type {
  BenchmarkCategory,
  BenchmarkSuite,
  BenchmarkResult,
  BenchmarkComparison,
} from './benchmarks/benchmark-types.js';
export { runBenchmark, compareBenchmarks, createBenchmarkWithJudge } from './benchmarks/benchmark-runner.js';
export type { BenchmarkConfig } from './benchmarks/benchmark-runner.js';
export { CODE_GEN_SUITE } from './benchmarks/suites/code-gen.js';
export { QA_SUITE } from './benchmarks/suites/qa.js';
export { TOOL_USE_SUITE } from './benchmarks/suites/tool-use.js';
export { MULTI_TURN_SUITE } from './benchmarks/suites/multi-turn.js';
export { VECTOR_SEARCH_SUITE } from './benchmarks/suites/vector-search.js';

// Contracts (adapter conformance testing)
export type {
  AdapterType,
  ComplianceLevel,
  ComplianceReport,
  ContractRunConfig,
  ContractRunFilter,
  ContractSuite,
  ContractTest,
  ContractTestCategory,
  ContractTestReport,
  ContractTestResult,
} from './contracts/index.js';

export { ContractSuiteBuilder, timedTest } from './contracts/index.js';
export { runContractSuite, runContractSuites } from './contracts/index.js';
export {
  complianceBadge,
  complianceSummary,
  complianceToCIAnnotations,
  complianceToJSON,
  complianceToMarkdown,
} from './contracts/index.js';
export {
  createVectorStoreContract,
  VECTOR_STORE_CONTRACT,
  createSandboxContract,
  SANDBOX_CONTRACT,
  createLLMProviderContract,
  LLM_PROVIDER_CONTRACT,
  createEmbeddingProviderContract,
  EMBEDDING_PROVIDER_CONTRACT,
} from './contracts/index.js';
