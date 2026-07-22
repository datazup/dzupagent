/**
 * Composable intent router with three-tier classification:
 * heuristic → keyword → LLM → default
 */
import type { KeywordMatcher } from "./keyword-matcher.js";
import type { LLMClassifier } from "./llm-classifier.js";
import { ForgeError } from "../errors/forge-error.js";
import { defaultLogger } from "../utils/logger.js";

export interface ClassificationResult {
  intent: string;
  confidence: "heuristic" | "keyword" | "llm" | "default";
  /**
   * True when the LLM tier could not run because the provider transport failed
   * (outage/timeout), as opposed to a genuine no-match. The result still falls
   * through to `defaultIntent` so existing callers are unaffected, but callers
   * that care can distinguish a provider incident (retryable) from a real
   * default classification. (ERR-M-04)
   */
  transportFailed?: boolean;
}

export interface IntentRouterConfig {
  keywordMatcher: KeywordMatcher;
  llmClassifier?: LLMClassifier;
  /** Optional heuristic function (e.g., DB lookups) — highest priority */
  heuristic?: (
    text: string,
    context?: Record<string, unknown>,
  ) => Promise<string | null>;
  defaultIntent: string;
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
      const result = await this.config.heuristic(text, context);
      if (result) return { intent: result, confidence: "heuristic" };
    }

    // Tier 2: Keyword
    const keywordResult = this.config.keywordMatcher.match(text);
    if (keywordResult) return { intent: keywordResult, confidence: "keyword" };

    // Tier 3: LLM
    if (this.config.llmClassifier) {
      try {
        const llmResult = await this.config.llmClassifier.classify(text);
        if (llmResult) return { intent: llmResult, confidence: "llm" };
      } catch (err) {
        // ERR-M-04: a PROVIDER_UNAVAILABLE transport failure is NOT a no-match.
        // Preserve the existing fall-through to defaultIntent (callers that do
        // not care are unaffected) but mark the result so a provider incident
        // is distinguishable from a genuine default classification.
        const recoverable = err instanceof ForgeError && err.recoverable;
        defaultLogger.warn(
          "[core] intent router LLM tier failed — falling back to default",
          {
            operation: "router.classify",
            code: err instanceof ForgeError ? err.code : undefined,
            recoverable,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return {
          intent: this.config.defaultIntent,
          confidence: "default",
          transportFailed: true,
        };
      }
    }

    // Tier 4: Default
    return { intent: this.config.defaultIntent, confidence: "default" };
  }
}
