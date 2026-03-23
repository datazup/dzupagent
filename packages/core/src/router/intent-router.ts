/**
 * Composable intent router with three-tier classification:
 * heuristic → keyword → LLM → default
 */
import type { KeywordMatcher } from './keyword-matcher.js'
import type { LLMClassifier } from './llm-classifier.js'

export interface ClassificationResult {
  intent: string
  confidence: 'heuristic' | 'keyword' | 'llm' | 'default'
}

export interface IntentRouterConfig {
  keywordMatcher: KeywordMatcher
  llmClassifier?: LLMClassifier
  /** Optional heuristic function (e.g., DB lookups) — highest priority */
  heuristic?: (text: string, context?: Record<string, unknown>) => Promise<string | null>
  defaultIntent: string
}

export class IntentRouter {
  constructor(private config: IntentRouterConfig) {}

  /**
   * Classify user input through the three-tier pipeline:
   * 1. Heuristic (fastest, domain-specific DB lookups)
   * 2. Keyword patterns (fast, no LLM)
   * 3. LLM classification (expensive, fallback)
   * 4. Default intent (final fallback)
   */
  async classify(
    text: string,
    context?: Record<string, unknown>,
  ): Promise<ClassificationResult> {
    // Tier 1: Heuristic
    if (this.config.heuristic) {
      const result = await this.config.heuristic(text, context)
      if (result) return { intent: result, confidence: 'heuristic' }
    }

    // Tier 2: Keyword
    const keywordResult = this.config.keywordMatcher.match(text)
    if (keywordResult) return { intent: keywordResult, confidence: 'keyword' }

    // Tier 3: LLM
    if (this.config.llmClassifier) {
      const llmResult = await this.config.llmClassifier.classify(text)
      if (llmResult) return { intent: llmResult, confidence: 'llm' }
    }

    // Tier 4: Default
    return { intent: this.config.defaultIntent, confidence: 'default' }
  }
}
