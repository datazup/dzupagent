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

export { LlmJudgeScorer, judgeResponseSchema } from './scorers/llm-judge-scorer.js';
export type {
  JudgeDimension,
  JudgeScore,
  JudgeAnchor,
  JudgeScorerConfig,
  JudgeScorerResult,
  JudgeResponse,
  JudgeTokenUsage,
} from './scorers/llm-judge-scorer.js';

export { STANDARD_CRITERIA, CODE_CRITERIA, FIVE_POINT_RUBRIC, TEN_POINT_RUBRIC } from './scorers/criteria.js';
export type { JudgeCriterion } from './scorers/criteria.js';

export { ScorerRegistry, defaultScorerRegistry } from './scorers/scorer-registry.js';
export type { ScorerFactory, ScorerFactoryDeps } from './scorers/scorer-registry.js';

// Runner (legacy)
export { runEvalSuite } from './eval-runner.js';

// Enhanced Runner (ECO-115)
export { EvalRunner, reportToMarkdown, reportToJSON, reportToCIAnnotations } from './runner/enhanced-runner.js';
export type {
  EvalRunnerConfig,
  EvalTargetResult,
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
export {
  SELF_CORRECTION_SUITE,
  CORRECTION_SCENARIOS,
  ALL_CORRECTION_CATEGORIES,
  createSelfCorrectionSuite,
} from './benchmarks/suites/self-correction.js';
export type { CorrectionScenario, CorrectionCategory } from './benchmarks/suites/self-correction.js';

// Benchmark Trend Detection
export { BenchmarkTrendStore, InMemoryBenchmarkRunStore } from './benchmarks/benchmark-trend.js';
export type { BenchmarkRunRecord, BenchmarkRunStore, BenchmarkTrendResult } from './benchmarks/benchmark-trend.js';

// Learning Curve Benchmark
export {
  runLearningCurveBenchmark,
  generateSimulatedRun,
  createLearningCurveSuite,
  QUALITY_PATTERNS,
} from './benchmarks/suites/learning-curve.js';
export type {
  LearningCurveConfig,
  LearningCurveResult,
  LearningCurveStore,
  SimulatedRunAnalysis,
  StoreItem as LearningCurveStoreItem,
} from './benchmarks/suites/learning-curve.js';

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

// Prompt Experiment (A/B testing for system prompts)
export { PromptExperiment } from './prompt-experiment/index.js';
export type {
  PromptVariant,
  ExperimentConfig,
  VariantResult,
  VariantResultEntry,
  PairedComparison,
  ExperimentReport,
} from './prompt-experiment/index.js';

// Prompt Optimizer (LLM-driven prompt rewriting + version store)
export { PromptVersionStore, PromptOptimizer } from './prompt-optimizer/index.js';
export type {
  PromptVersion,
  PromptVersionEvalScores,
  PromptVersionStoreConfig,
  OptimizerConfig,
  OptimizationResult,
  OptimizationCandidate,
} from './prompt-optimizer/index.js';

// Domain-specific scorer (SQL, code, analysis, ops)
export { DomainScorer } from './scorers/domain-scorer.js';
export type {
  EvalDomain,
  DomainCriterion,
  DomainConfig,
  CriterionResult,
  DomainScorerResult,
  DomainScorerParams,
} from './scorers/domain-scorer.js';
