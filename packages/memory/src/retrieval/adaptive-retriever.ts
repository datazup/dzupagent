/**
 * Adaptive retrieval that classifies query intent and adjusts
 * retrieval weights accordingly (inspired by MAGMA's Intent-Aware Router).
 *
 * Instead of fixed equal weights for vector/FTS/graph search,
 * the AdaptiveRetriever detects query intent via regex patterns
 * and applies intent-specific weight profiles to RRF fusion.
 *
 * This module is a thin coordinator. The implementation is split across:
 * - `adaptive-retriever-types.ts`         — types, defaults, classifyIntent
 * - `adaptive-retriever-fusion.ts`        — weighted RRF + weight redistribution
 * - `adaptive-retriever-health.ts`        — sliding-window provider health
 * - `adaptive-retriever-weight-learner.ts` — EMA-based weight learning
 * - `adaptive-retriever-search.ts`        — parallel provider execution
 */

import type {
  AdaptiveRetrieverConfig,
  AdaptiveSearchResult,
  QueryIntent,
  RetrievalEventEmitter,
  RetrievalProviders,
  RetrievalStrategy,
  RetrievalWeights,
  SourceName,
} from './adaptive-retriever-types.js';
import {
  DEFAULT_STRATEGIES,
  GENERAL_WEIGHTS,
  classifyIntent,
} from './adaptive-retriever-types.js';
import { redistributeWeights, weightedFusion } from './adaptive-retriever-fusion.js';
import {
  ProviderHealthTracker,
  type ProviderHealthMetrics,
} from './adaptive-retriever-health.js';
import {
  WeightLearner,
  type FeedbackQuality,
} from './adaptive-retriever-weight-learner.js';
import { executeProviderSearches } from './adaptive-retriever-search.js';

// Re-export public API so existing consumers of this module keep working.
export type {
  AdaptiveRetrieverConfig,
  AdaptiveSearchResult,
  QueryIntent,
  RetrievalEventEmitter,
  RetrievalProviders,
  RetrievalStrategy,
  RetrievalWarning,
  RetrievalWeights,
} from './adaptive-retriever-types.js';
export { DEFAULT_STRATEGIES, classifyIntent } from './adaptive-retriever-types.js';
export type { ProviderHealthMetrics } from './adaptive-retriever-health.js';
export type { FeedbackQuality, WeightLearnerConfig } from './adaptive-retriever-weight-learner.js';
export { WeightLearner } from './adaptive-retriever-weight-learner.js';

// ─── Adaptive Retriever ──────────────────────────────────────────────────────

export class AdaptiveRetriever {
  private readonly strategies: RetrievalStrategy[];
  private readonly defaultLimit: number;
  private readonly namespace: string[];
  private readonly k: number;
  private readonly providers: RetrievalProviders;
  private readonly eventBus?: RetrievalEventEmitter | undefined;
  private readonly healthTrackers = new Map<SourceName, ProviderHealthTracker>();
  private readonly learnFromFeedback: boolean;
  private readonly weightLearner: WeightLearner;

  constructor(config: AdaptiveRetrieverConfig) {
    this.providers = config.providers;
    this.strategies = config.strategies ?? DEFAULT_STRATEGIES;
    this.defaultLimit = config.defaultLimit ?? 10;
    this.namespace = config.namespace ?? ['memories'];
    this.k = config.k ?? 60;
    this.eventBus = config.eventBus;
    this.learnFromFeedback = config.learnFromFeedback ?? false;
    this.weightLearner = new WeightLearner();

    if (config.providers.vector) this.healthTrackers.set('vector', new ProviderHealthTracker());
    if (config.providers.fts) this.healthTrackers.set('fts', new ProviderHealthTracker());
    if (config.providers.graph) this.healthTrackers.set('graph', new ProviderHealthTracker());
  }

  /** Health metrics for all configured retrieval providers. */
  health(): ProviderHealthMetrics[] {
    return Array.from(this.healthTrackers.entries()).map(
      ([source, tracker]) => tracker.metrics(source),
    );
  }

  /** Report search quality feedback for learning. No-op when learning is disabled. */
  reportFeedback(_query: string, intent: QueryIntent, quality: FeedbackQuality): void {
    if (!this.learnFromFeedback) return;
    this.weightLearner.recordFeedback(intent, this.getWeights(intent), quality);
  }

  /** Learned weight adjustments for all intents that have received feedback. */
  getLearnedAdjustments(): Map<QueryIntent, RetrievalWeights> {
    if (!this.learnFromFeedback) return new Map();
    return this.weightLearner.getAdjustments();
  }

  /** Reset all learned weight adjustments. */
  resetLearning(): void {
    this.weightLearner.reset();
  }

  /** Classify query intent against configured strategies. */
  classifyIntent(query: string): QueryIntent {
    return classifyIntent(query, this.strategies);
  }

  /** Get retrieval weights for a given intent. */
  getWeights(intent: QueryIntent): RetrievalWeights {
    const strategy = this.strategies.find((s) => s.intent === intent);
    if (strategy) return { ...strategy.weights };
    return { ...GENERAL_WEIGHTS };
  }

  /**
   * Run adaptive search:
   * 1. Classify intent → pick base weights (with optional learned blend)
   * 2. Execute every available provider in parallel
   * 3. Apply intent-weighted RRF fusion across the surviving providers
   */
  async search(
    query: string,
    records: Array<{ key: string; value: Record<string, unknown> }>,
    limit?: number,
  ): Promise<AdaptiveSearchResult[]> {
    const effectiveLimit = limit ?? this.defaultLimit;
    const intent = this.classifyIntent(query);
    let rawWeights = this.getWeights(intent);

    if (this.learnFromFeedback) {
      rawWeights = this.weightLearner.blend(rawWeights, intent, this.weightLearner.learningRate);
    }

    const available: SourceName[] = [];
    if (this.providers.vector) available.push('vector');
    if (this.providers.fts) available.push('fts');
    if (this.providers.graph) available.push('graph');

    if (available.length === 0) return [];

    const weights = redistributeWeights(rawWeights, available);

    const { searchResults, succeededSources, warnings } = await executeProviderSearches({
      query,
      records,
      limit: effectiveLimit,
      namespace: this.namespace,
      available,
      providers: this.providers,
      healthTrackers: this.healthTrackers,
      eventBus: this.eventBus,
    });

    if (succeededSources.length === 0) return [];

    // If only one provider succeeded, skip fusion
    if (succeededSources.length === 1) {
      const source = succeededSources[0]!;
      const items = searchResults[source] ?? [];
      return items.slice(0, effectiveLimit).map((item) => ({
        key: item.key,
        score: item.score,
        value: item.value,
        sources: [source],
        intent,
        weights,
        warnings,
      }));
    }

    // Redistribute again if some providers failed at runtime
    const finalWeights =
      succeededSources.length < available.length
        ? redistributeWeights(rawWeights, succeededSources)
        : weights;

    const fused = weightedFusion(searchResults, finalWeights, {
      k: this.k,
      limit: effectiveLimit,
    });

    return fused.map((result) => ({
      ...result,
      intent,
      weights: finalWeights,
      warnings,
    }));
  }
}
