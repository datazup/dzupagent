/**
 * Domain-specific quality evaluation scorer.
 *
 * Provides pre-built evaluation rubrics for different AI agent use cases
 * (SQL, code, analysis, ops, general). Each domain has its own weighted
 * quality criteria evaluated via deterministic checks, LLM-as-judge, or both.
 *
 * Usage:
 *   const scorer = new DomainScorer({ domain: 'sql', model: myLlm });
 *   const result = await scorer.score(evalInput);
 *
 *   // Auto-detect domain from content:
 *   const auto = DomainScorer.createAutoDetect(myLlm);
 *   const result2 = await auto.score(evalInput);
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { EvalInput, Scorer, ScorerConfig } from '../types.js';
import type {
  CriterionResult,
  DomainCriterion,
  DomainConfig,
  DomainScorerParams,
  DomainScorerResult,
  EvalDomain,
} from './domain-scorer/types.js';
import {
  buildDomainConfig,
  cloneDomainConfig,
  DOMAIN_CONFIGS,
  DOMAIN_DETECTION_PATTERNS,
} from './domain-scorer/configs.js';
import { clamp01, combinedText, parseCriterionResponse, countPatterns } from './domain-scorer/helpers.js';

/**
 * Domain-specific quality evaluation scorer.
 *
 * Evaluates LLM outputs against domain-specific quality criteria using a
 * combination of deterministic pattern checks and LLM-as-judge rubrics.
 *
 * Each supported domain (sql, code, analysis, ops, general) has pre-built
 * criteria with weights. The final score is a weighted average of all
 * criterion scores.
 */
export class DomainScorer implements Scorer<EvalInput> {
  readonly config: ScorerConfig;

  private readonly domainConfig: DomainConfig;
  private readonly model: BaseChatModel | undefined;
  private readonly passThreshold: number;
  private readonly maxRetries: number;
  private readonly autoDetect: boolean;

  constructor(params: DomainScorerParams) {
    this.model = params.model;
    this.passThreshold = params.passThreshold ?? 0.6;
    this.maxRetries = params.maxRetries ?? 2;
    this.autoDetect = params.autoDetect ?? false;

    this.domainConfig = buildDomainConfig(params);

    const domainLabel = this.autoDetect ? 'auto' : params.domain;
    this.config = {
      id: `domain-scorer-${domainLabel}`,
      name: `domain-scorer-${domainLabel}`,
      description: this.autoDetect ? 'Auto-detecting domain-specific quality scorer' : this.domainConfig.description,
      type: 'composite',
      threshold: this.passThreshold,
    };
  }

  /**
   * Score an evaluation input against the domain-specific criteria.
   */
  async score(input: EvalInput): Promise<DomainScorerResult> {
    const startTime = Date.now();

    // If auto-detect mode, resolve the domain dynamically
    const effectiveConfig = this.autoDetect
      ? DOMAIN_CONFIGS[DomainScorer.detectDomain(input)]
      : this.domainConfig;

    const effectiveDomain = effectiveConfig.domain;
    const criterionResults: CriterionResult[] = [];
    const scorerScores: Array<{ criterion: string; score: number; reasoning: string }> = [];

    for (const criterion of effectiveConfig.criteria) {
      const result = await this.scoreCriterion(criterion, input);
      criterionResults.push(result);
      scorerScores.push({
        criterion: result.criterion,
        score: result.score,
        reasoning: result.reasoning,
      });
    }

    // Weighted average
    let totalWeight = 0;
    let weightedSum = 0;
    for (let i = 0; i < effectiveConfig.criteria.length; i++) {
      const criterion = effectiveConfig.criteria[i];
      const criterionResult = criterionResults[i];
      if (criterion && criterionResult) {
        totalWeight += criterion.weight;
        weightedSum += criterionResult.score * criterion.weight;
      }
    }
    const aggregateScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    const durationMs = Date.now() - startTime;

    return {
      scorerId: this.config.id,
      scores: scorerScores,
      aggregateScore,
      passed: aggregateScore >= this.passThreshold,
      durationMs,
      domain: effectiveDomain,
      criterionResults,
    };
  }

  /**
   * Auto-detect the evaluation domain from input content.
   *
   * Examines both input and output text for domain-specific keywords.
   * Returns the first matching domain by specificity, or 'general' as fallback.
   */
  static detectDomain(input: EvalInput): EvalDomain {
    const text = combinedText(input);

    for (const { domain, patterns } of DOMAIN_DETECTION_PATTERNS) {
      const matchCount = countPatterns(text, patterns);
      // Require at least 2 pattern matches for confident detection
      if (matchCount >= 2) {
        return domain;
      }
    }

    // Single-match fallback: if any domain has at least 1 match, use it
    for (const { domain, patterns } of DOMAIN_DETECTION_PATTERNS) {
      if (countPatterns(text, patterns) >= 1) {
        return domain;
      }
    }

    return 'general';
  }

  /**
   * Create a DomainScorer that auto-detects the domain for each input.
   *
   * The domain is detected per-call based on input/output content patterns.
   */
  static createAutoDetect(model: BaseChatModel): DomainScorer {
    return new DomainScorer({ domain: 'general', model, autoDetect: true });
  }

  /**
   * Get the built-in configuration for a specific domain.
   */
  static getConfig(domain: EvalDomain): DomainConfig {
    return cloneDomainConfig(domain);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Score a single criterion using deterministic check, LLM judge, or both.
   */
  private async scoreCriterion(
    criterion: DomainCriterion,
    input: EvalInput,
  ): Promise<CriterionResult> {
    const hasDeterministic = criterion.deterministicCheck !== undefined;
    const hasModel = this.model !== undefined;

    // Deterministic only
    if (hasDeterministic && !hasModel) {
      const result = criterion.deterministicCheck!(input);
      return {
        criterion: criterion.name,
        score: result.score,
        reasoning: result.reasoning,
        method: 'deterministic',
      };
    }

    // LLM only (no deterministic check available)
    if (!hasDeterministic && hasModel) {
      const result = await this.llmJudgeCriterion(criterion, input);
      return {
        criterion: criterion.name,
        score: result.score,
        reasoning: result.reasoning,
        method: 'llm-judge',
      };
    }

    // Both available: combined scoring
    if (hasDeterministic && hasModel) {
      const deterResult = criterion.deterministicCheck!(input);
      const llmResult = await this.llmJudgeCriterion(criterion, input);

      // Weighted combination: 40% deterministic, 60% LLM when both available
      const combinedScore = clamp01(deterResult.score * 0.4 + llmResult.score * 0.6);

      return {
        criterion: criterion.name,
        score: combinedScore,
        reasoning: `Deterministic (${deterResult.score.toFixed(2)}): ${deterResult.reasoning} | LLM (${llmResult.score.toFixed(2)}): ${llmResult.reasoning}`,
        method: 'combined',
      };
    }

    // No deterministic check and no model: skip with warning
    return {
      criterion: criterion.name,
      score: 0,
      reasoning: 'No evaluation method available: no deterministic check defined and no LLM model provided',
      method: 'deterministic',
    };
  }

  /**
   * Use LLM-as-judge to evaluate a single criterion.
   */
  private async llmJudgeCriterion(
    criterion: DomainCriterion,
    input: EvalInput,
  ): Promise<{ score: number; reasoning: string }> {
    if (!this.model) {
      return { score: 0, reasoning: 'No LLM model provided for judge-based criterion' };
    }

    const systemPrompt = [
      'You are an expert evaluator. Score the following output on a specific quality criterion.',
      'Return ONLY a JSON object matching this exact schema: { "score": number (0-10), "reasoning": string }',
      '',
      `Criterion: ${criterion.name}`,
      `Description: ${criterion.description}`,
      `Rubric: ${criterion.llmRubric}`,
    ].join('\n');

    const userPrompt = [
      `Input: ${input.input}`,
      `Output: ${input.output}`,
      ...(input.reference ? [`Reference: ${input.reference}`] : []),
      '',
      'Evaluate and return JSON only.',
    ].join('\n');

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.model.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(userPrompt),
        ]);

        const content = typeof response.content === 'string'
          ? response.content
          : Array.isArray(response.content)
            ? response.content
                .filter((c): c is { type: 'text'; text: string } =>
                  typeof c === 'object' && c !== null && 'type' in c && c.type === 'text')
                .map((c) => c.text)
                .join('')
            : String(response.content);

        const parsed = parseCriterionResponse(content);
        if (parsed) {
          return {
            score: clamp01(parsed.score / 10),
            reasoning: parsed.reasoning,
          };
        }
      } catch {
        // LLM call failed; retry
      }
    }

    // All retries exhausted: return a neutral fallback
    return {
      score: 0.5,
      reasoning: `Failed to get valid LLM judge response for "${criterion.name}" after ${this.maxRetries + 1} attempt(s)`,
    };
  }
}

export type {
  EvalDomain,
  DomainCriterion,
  DomainConfig,
  CriterionResult,
  DomainScorerResult,
  DomainScorerParams,
} from './domain-scorer/types.js';
