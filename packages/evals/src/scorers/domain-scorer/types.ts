import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { EvalInput, Scorer, ScorerConfig, ScorerResult } from '../../types.js';

/** Supported evaluation domains. */
export type EvalDomain = 'sql' | 'code' | 'analysis' | 'ops' | 'general' | 'research';

/** A single quality criterion within a domain. */
export interface DomainCriterion {
  name: string;
  description: string;
  /** Weight 0-1. All weights within a domain should sum to 1. */
  weight: number;
  /** Deterministic check function (if possible). */
  deterministicCheck?: (input: EvalInput) => { score: number; reasoning: string };
  /** LLM rubric (used when no deterministic check, or as supplement). */
  llmRubric: string;
}

/** Domain configuration with all its criteria. */
export interface DomainConfig {
  domain: EvalDomain;
  name: string;
  description: string;
  criteria: DomainCriterion[];
}

/** Per-criterion evaluation result. */
export interface CriterionResult {
  criterion: string;
  score: number;
  reasoning: string;
  method: 'deterministic' | 'llm-judge' | 'combined';
}

/** Result of a domain-specific evaluation. */
export interface DomainScorerResult extends ScorerResult {
  domain: EvalDomain;
  criterionResults: CriterionResult[];
}

/** Constructor parameters for DomainScorer. */
export interface DomainScorerParams {
  domain: EvalDomain;
  /** LLM for judge-based criteria. Required if the domain has LLM-only rubrics. */
  model?: BaseChatModel;
  /** Override the built-in domain config. */
  customConfig?: Partial<DomainConfig>;
  /** Override specific criterion weights. */
  weightOverrides?: Partial<Record<string, number>>;
  /** Pass threshold (default: 0.6). */
  passThreshold?: number;
  /** Max LLM retries on parse failure (default: 2). */
  maxRetries?: number;
  /**
   * When true, domain is auto-detected per input.
   * @internal Used by `DomainScorer.createAutoDetect()`.
   */
  autoDetect?: boolean;
}

export type { EvalInput, Scorer, ScorerConfig };
