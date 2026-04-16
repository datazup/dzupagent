// Re-export from flat structure (legacy)
export { DeterministicScorer } from '../deterministic-scorer.js'
export type { DeterministicScorerConfig } from '../deterministic-scorer.js'
export { LLMJudgeScorer } from '../llm-judge-scorer.js'
export type { LLMJudgeConfig } from '../llm-judge-scorer.js'
export { CompositeScorer } from '../composite-scorer.js'
export type { CompositeScorerConfig } from '../composite-scorer.js'

// Enhanced scorers (ECO-111, ECO-112, ECO-113)
export { createLLMJudge } from './llm-judge-enhanced.js'
export type { LLMJudgeEnhancedConfig } from './llm-judge-enhanced.js'

export {
  createJSONSchemaScorer,
  createKeywordScorer,
  createLatencyScorer,
  createCostScorer,
} from './deterministic-enhanced.js'
export type {
  JSONSchemaScorerConfig,
  KeywordScorerConfig,
  LatencyScorerConfig,
  CostScorerConfig,
} from './deterministic-enhanced.js'

// 5-dimension LLM Judge with Zod validation
export { LlmJudgeScorer, judgeResponseSchema } from './llm-judge-scorer.js'
export type {
  JudgeDimension,
  JudgeScore,
  JudgeAnchor,
  JudgeScorerConfig,
  JudgeScorerResult,
  JudgeResponse,
  JudgeTokenUsage,
} from './llm-judge-scorer.js'

// Criteria and rubrics
export { STANDARD_CRITERIA, CODE_CRITERIA, FIVE_POINT_RUBRIC, TEN_POINT_RUBRIC } from './criteria.js'
export type { JudgeCriterion } from './criteria.js'

// Scorer Registry
export { ScorerRegistry, defaultScorerRegistry } from './scorer-registry.js'
export type { ScorerFactory, ScorerFactoryDeps } from './scorer-registry.js'

// Evidence Quality Scorer
export { EvidenceQualityScorer, computeEvidenceQuality } from './evidence-quality-scorer.js'
export type {
  EvidenceQualityInput,
  EvidenceQualityResult,
  EvidenceSource,
  ClaimSourceMapping,
  SourceReliability,
} from './evidence-quality-scorer.js'
