/**
 * Adaptive retrieval that classifies query intent and adjusts
 * retrieval weights accordingly (inspired by MAGMA's Intent-Aware Router).
 *
 * Instead of fixed equal weights for vector/FTS/graph search,
 * the AdaptiveRetriever detects query intent via regex patterns
 * and applies intent-specific weight profiles to RRF fusion.
 */

import type { VectorSearchResult } from './vector-search.js';
import type { FTSSearchResult } from './fts-search.js';
import type { GraphSearchResult } from './graph-search.js';
import type { FusedResult } from './rrf-fusion.js';

// ─── Event Emitter Interface ─────────────────────────────────────────────────

/**
 * Minimal event emitter interface accepted by AdaptiveRetriever.
 *
 * Structurally compatible with DzipEventBus from `@dzipagent/core`,
 * but defined locally so `@dzipagent/memory` has no dependency on core.
 */
export interface RetrievalEventEmitter {
  emit(event:
    | {
        type: 'memory:retrieval_source_failed';
        source: string;
        error: string;
        durationMs: number;
        query: string;
      }
    | {
        type: 'memory:retrieval_source_succeeded';
        source: string;
        resultCount: number;
        durationMs: number;
      }
  ): void;
}

/** Warning collected when a retrieval source fails at runtime */
export interface RetrievalWarning {
  source: string;
  error: string;
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Query intent types that drive retrieval strategy selection */
export type QueryIntent = 'factual' | 'temporal' | 'causal' | 'procedural' | 'entity' | 'general';

/** Retrieval weight configuration per intent */
export interface RetrievalWeights {
  vector: number;
  fts: number;
  graph: number;
  /** Optional causal graph weight (default: 0, not used unless a causal provider is configured) */
  causal?: number;
}

/** Named retrieval strategy */
export interface RetrievalStrategy {
  intent: QueryIntent;
  weights: RetrievalWeights;
  /** Patterns that indicate this intent */
  patterns: RegExp[];
}

/** Providers that the adaptive retriever delegates to */
export interface RetrievalProviders {
  vector?: {
    search(namespace: string[], query: string, limit: number): Promise<VectorSearchResult[]>;
  };
  fts?: {
    search(
      records: Array<{ key: string; value: Record<string, unknown> }>,
      query: string,
      limit: number,
    ): FTSSearchResult[];
  };
  graph?: {
    search(
      records: Array<{ key: string; value: Record<string, unknown> }>,
      query: string,
      limit: number,
    ): GraphSearchResult[];
  };
}

export interface AdaptiveRetrieverConfig {
  providers: RetrievalProviders;
  /** Override default strategies */
  strategies?: RetrievalStrategy[];
  /** Default retrieval limit (default: 10) */
  defaultLimit?: number;
  /** Namespace for vector search */
  namespace?: string[];
  /** RRF constant k (default: 60) */
  k?: number;
  /** Optional event bus for retrieval failure observability */
  eventBus?: RetrievalEventEmitter;
  /** Enable dynamic weight learning from search quality feedback (default: false) */
  learnFromFeedback?: boolean;
}

export interface AdaptiveSearchResult extends FusedResult {
  /** Which intent was classified */
  intent: QueryIntent;
  /** Weights used for this search */
  weights: RetrievalWeights;
  /** Warnings from retrieval sources that failed at runtime (empty if all succeeded) */
  warnings: RetrievalWarning[];
}

// ─── Default Strategies ──────────────────────────────────────────────────────

const GENERAL_WEIGHTS: RetrievalWeights = { vector: 0.4, fts: 0.3, graph: 0.3 };

export const DEFAULT_STRATEGIES: RetrievalStrategy[] = [
  {
    intent: 'temporal',
    weights: { vector: 0.3, fts: 0.2, graph: 0.5 },
    patterns: [
      /\bwhen\b/i,
      /\b(before|after|since|until|during)\b/i,
      /\b(last|previous|recent|latest|first|earliest)\b/i,
      /\b(changed|updated|modified|created|happened)\b/i,
      /\b(history|timeline|chronolog)/i,
      /\b\d{4}[-/]\d{2}/,
    ],
  },
  {
    intent: 'causal',
    weights: { vector: 0.3, fts: 0.1, graph: 0.6 },
    patterns: [
      /\bwhy\b/i,
      /\b(cause[ds]?|because|reason|led to|result(?:ed)? in)\b/i,
      /\b(trigger|prevent|block|enable)\b/i,
      /\b(root cause|due to|consequence)\b/i,
    ],
  },
  {
    intent: 'procedural',
    weights: { vector: 0.5, fts: 0.3, graph: 0.2 },
    patterns: [
      /\bhow\s+(?:do|to|can|should)\b/i,
      /\b(steps?|process|procedure|workflow|guide)\b/i,
      /\b(implement|configure|setup|install|deploy)\b/i,
    ],
  },
  {
    intent: 'entity',
    weights: { vector: 0.2, fts: 0.2, graph: 0.6 },
    patterns: [
      /\bwhat\s+is\b/i,
      /\bwho\b/i,
      /\b(about|regarding|related to|concerning)\b/i,
      /`[^`]+`/,
      /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/,
    ],
  },
  {
    intent: 'factual',
    weights: { vector: 0.6, fts: 0.3, graph: 0.1 },
    patterns: [
      /\b(what|which|does|is there|are there)\b/i,
      /\b(support|compatible|available|possible)\b/i,
      /\b(version|type|format|standard)\b/i,
    ],
  },
];

// ─── Standalone classify function ────────────────────────────────────────────

/**
 * Classify query intent using pattern matching.
 * Returns the first matching strategy's intent, or 'general' if none match.
 */
export function classifyIntent(
  query: string,
  strategies: RetrievalStrategy[] = DEFAULT_STRATEGIES,
): QueryIntent {
  for (const strategy of strategies) {
    for (const pattern of strategy.patterns) {
      if (pattern.test(query)) {
        return strategy.intent;
      }
    }
  }
  return 'general';
}

// ─── Weighted RRF Fusion ─────────────────────────────────────────────────────

type SourceName = 'vector' | 'fts' | 'graph';

interface ScoredItem {
  key: string;
  score: number;
  value: Record<string, unknown>;
}

/**
 * Weighted RRF fusion: score(d) = SUM(weight_i * (1 / (k + rank_i(d))))
 */
function weightedFusion(
  results: Partial<Record<SourceName, ScoredItem[]>>,
  weights: RetrievalWeights,
  options: { k: number; limit: number },
): FusedResult[] {
  const { k, limit } = options;

  const fused = new Map<
    string,
    { score: number; value: Record<string, unknown>; sources: Set<SourceName> }
  >();

  const sources: [SourceName, ScoredItem[] | undefined][] = [
    ['vector', results.vector],
    ['fts', results.fts],
    ['graph', results.graph],
  ];

  for (const [sourceName, items] of sources) {
    if (!items) continue;
    const weight = weights[sourceName];
    for (let rank = 0; rank < items.length; rank++) {
      const item = items[rank];
      if (!item) continue;
      const rrfScore = weight * (1 / (k + rank));
      const existing = fused.get(item.key);
      if (existing) {
        existing.score += rrfScore;
        existing.sources.add(sourceName);
      } else {
        fused.set(item.key, {
          score: rrfScore,
          value: item.value,
          sources: new Set([sourceName]),
        });
      }
    }
  }

  return Array.from(fused.entries())
    .map(([key, data]) => ({
      key,
      score: data.score,
      value: data.value,
      sources: Array.from(data.sources),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── Provider Health Tracking ─────────────────────────────────────────────────

/** Sliding-window health metrics for a single retrieval provider */
export interface ProviderHealthMetrics {
  source: SourceName;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  successRate: number;
  lastFailure?: { error: string; timestamp: Date };
}

const DEFAULT_HEALTH_WINDOW_SIZE = 100;

class ProviderHealthTracker {
  private readonly windowSize: number;
  private readonly entries: Array<{ ok: boolean; latencyMs: number; error?: string }> = [];

  constructor(windowSize = DEFAULT_HEALTH_WINDOW_SIZE) {
    this.windowSize = windowSize;
  }

  record(ok: boolean, latencyMs: number, error?: string): void {
    this.entries.push({ ok, latencyMs, error });
    if (this.entries.length > this.windowSize) {
      this.entries.shift();
    }
  }

  metrics(source: SourceName): ProviderHealthMetrics {
    const successes = this.entries.filter(e => e.ok);
    const failures = this.entries.filter(e => !e.ok);
    const totalLatency = successes.reduce((sum, e) => sum + e.latencyMs, 0);
    const lastFail = failures.length > 0 ? failures[failures.length - 1] : undefined;

    return {
      source,
      successCount: successes.length,
      failureCount: failures.length,
      totalLatencyMs: totalLatency,
      avgLatencyMs: successes.length > 0 ? totalLatency / successes.length : 0,
      successRate: this.entries.length > 0 ? successes.length / this.entries.length : 1,
      lastFailure: lastFail ? { error: lastFail.error ?? 'unknown', timestamp: new Date() } : undefined,
    };
  }
}

// ─── Weight Learner ──────────────────────────────────────────────────────────

/** Configuration for the weight learner */
export interface WeightLearnerConfig {
  /** EMA learning rate (default: 0.05) */
  learningRate?: number;
  /** Minimum weight for any provider (default: 0.05) */
  minWeight?: number;
  /** Maximum weight for any provider (default: 0.8) */
  maxWeight?: number;
}

/** Feedback quality rating for a search result */
export type FeedbackQuality = 'good' | 'bad' | 'mixed';

/** Internal record of feedback for a given intent */
interface IntentFeedbackState {
  /** Accumulated EMA-adjusted weights */
  weights: RetrievalWeights;
  /** Number of feedback signals received */
  count: number;
}

const SOURCE_NAMES: readonly SourceName[] = ['vector', 'fts', 'graph'] as const;

/**
 * Learns retrieval weight adjustments from search quality feedback
 * using exponential moving average (EMA).
 *
 * When 'good' feedback is received, the current weights are reinforced.
 * When 'bad' feedback is received, weights shift toward alternatives.
 * When 'mixed' feedback is received, a smaller adjustment is made.
 *
 * All weights are clamped to [minWeight, maxWeight] and renormalized to sum to ~1.0.
 */
export class WeightLearner {
  readonly learningRate: number;
  private readonly minWeight: number;
  private readonly maxWeight: number;
  private readonly state = new Map<QueryIntent, IntentFeedbackState>();

  constructor(config: WeightLearnerConfig = {}) {
    this.learningRate = config.learningRate ?? 0.05;
    this.minWeight = config.minWeight ?? 0.05;
    this.maxWeight = config.maxWeight ?? 0.8;
  }

  /**
   * Record feedback for a search. Adjusts the learned weights for the given intent.
   *
   * @param intent  The classified query intent
   * @param currentWeights  The weights that were used for this search
   * @param quality  Quality rating of the results
   */
  recordFeedback(
    intent: QueryIntent,
    currentWeights: RetrievalWeights,
    quality: FeedbackQuality,
  ): void {
    const existing = this.state.get(intent);
    const targetWeights = this.computeTarget(currentWeights, quality);

    if (!existing) {
      // First feedback — initialize directly from the target
      this.state.set(intent, {
        weights: this.clampAndNormalize(targetWeights),
        count: 1,
      });
      return;
    }

    // EMA update: learned = (1 - alpha) * learned + alpha * target
    const alpha = this.learningRate;
    const updated: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };
    for (const s of SOURCE_NAMES) {
      updated[s] = (1 - alpha) * existing.weights[s] + alpha * targetWeights[s];
    }

    existing.weights = this.clampAndNormalize(updated);
    existing.count += 1;
  }

  /**
   * Get the current learned weight adjustments for all intents that have received feedback.
   */
  getAdjustments(): Map<QueryIntent, RetrievalWeights> {
    const result = new Map<QueryIntent, RetrievalWeights>();
    for (const [intent, feedbackState] of this.state) {
      result.set(intent, { ...feedbackState.weights });
    }
    return result;
  }

  /**
   * Get learned weights for a specific intent, or undefined if no feedback has been recorded.
   */
  getIntentAdjustment(intent: QueryIntent): RetrievalWeights | undefined {
    const feedbackState = this.state.get(intent);
    if (!feedbackState) return undefined;
    return { ...feedbackState.weights };
  }

  /** Clear all learned adjustments */
  reset(): void {
    this.state.clear();
  }

  /**
   * Blend raw (default) weights with learned weights.
   * Returns: (1 - blendRate) * rawWeights + blendRate * learnedWeights
   */
  blend(rawWeights: RetrievalWeights, intent: QueryIntent, blendRate: number): RetrievalWeights {
    const learned = this.getIntentAdjustment(intent);
    if (!learned) return { ...rawWeights };

    const blended: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };
    for (const s of SOURCE_NAMES) {
      blended[s] = (1 - blendRate) * rawWeights[s] + blendRate * learned[s];
    }
    return this.clampAndNormalize(blended);
  }

  /**
   * Compute a target weight vector based on feedback quality.
   *
   * - 'good': reinforce current weights (push them further in their direction)
   * - 'bad': shift toward equal distribution (dampen dominant weights)
   * - 'mixed': small shift toward equal distribution
   */
  private computeTarget(currentWeights: RetrievalWeights, quality: FeedbackQuality): RetrievalWeights {
    const equal = 1 / SOURCE_NAMES.length;
    const target: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };

    switch (quality) {
      case 'good': {
        // Reinforce: amplify deviation from equal
        for (const s of SOURCE_NAMES) {
          const deviation = currentWeights[s] - equal;
          target[s] = currentWeights[s] + deviation * 0.2;
        }
        break;
      }
      case 'bad': {
        // Dampen: shift toward equal weights (away from current)
        for (const s of SOURCE_NAMES) {
          target[s] = currentWeights[s] * 0.6 + equal * 0.4;
        }
        break;
      }
      case 'mixed': {
        // Small shift toward equal
        for (const s of SOURCE_NAMES) {
          target[s] = currentWeights[s] * 0.85 + equal * 0.15;
        }
        break;
      }
    }

    return target;
  }

  /**
   * Clamp each weight to [minWeight, maxWeight] and renormalize so they sum to ~1.0.
   */
  private clampAndNormalize(weights: RetrievalWeights): RetrievalWeights {
    const clamped: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };

    for (const s of SOURCE_NAMES) {
      clamped[s] = Math.max(this.minWeight, Math.min(this.maxWeight, weights[s]));
    }

    const sum = SOURCE_NAMES.reduce((acc, s) => acc + clamped[s], 0);
    if (sum > 0) {
      for (const s of SOURCE_NAMES) {
        clamped[s] = clamped[s] / sum;
      }
    }

    // Re-clamp after normalization (edge case: normalization could push beyond bounds)
    for (const s of SOURCE_NAMES) {
      clamped[s] = Math.max(this.minWeight, Math.min(this.maxWeight, clamped[s]));
    }

    // Final normalization pass
    const finalSum = SOURCE_NAMES.reduce((acc, s) => acc + clamped[s], 0);
    if (finalSum > 0 && Math.abs(finalSum - 1.0) > 1e-10) {
      for (const s of SOURCE_NAMES) {
        clamped[s] = clamped[s] / finalSum;
      }
    }

    return clamped;
  }
}

// ─── Adaptive Retriever ──────────────────────────────────────────────────────

export class AdaptiveRetriever {
  private readonly strategies: RetrievalStrategy[];
  private readonly defaultLimit: number;
  private readonly namespace: string[];
  private readonly k: number;
  private readonly providers: RetrievalProviders;
  private readonly eventBus?: RetrievalEventEmitter;
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

    // Initialize health trackers for configured providers
    if (config.providers.vector) this.healthTrackers.set('vector', new ProviderHealthTracker());
    if (config.providers.fts) this.healthTrackers.set('fts', new ProviderHealthTracker());
    if (config.providers.graph) this.healthTrackers.set('graph', new ProviderHealthTracker());
  }

  /**
   * Get health metrics for all configured retrieval providers.
   * Returns a snapshot of the sliding-window success/failure/latency stats.
   */
  health(): ProviderHealthMetrics[] {
    return Array.from(this.healthTrackers.entries()).map(
      ([source, tracker]) => tracker.metrics(source),
    );
  }

  /**
   * Report search quality feedback for learning.
   * Only has effect when `learnFromFeedback` is enabled in config.
   *
   * @param query  The original search query (used for intent classification)
   * @param intent  The classified intent for this query
   * @param quality  Quality rating: 'good' reinforces weights, 'bad' dampens them, 'mixed' makes small adjustments
   */
  reportFeedback(_query: string, intent: QueryIntent, quality: FeedbackQuality): void {
    if (!this.learnFromFeedback) return;
    const currentWeights = this.getWeights(intent);
    this.weightLearner.recordFeedback(intent, currentWeights, quality);
  }

  /**
   * Get the current learned weight adjustments for all intents that have received feedback.
   * Returns an empty map when learning is disabled or no feedback has been recorded.
   */
  getLearnedAdjustments(): Map<QueryIntent, RetrievalWeights> {
    if (!this.learnFromFeedback) return new Map();
    return this.weightLearner.getAdjustments();
  }

  /**
   * Reset all learned weight adjustments, returning to default intent-based weights.
   */
  resetLearning(): void {
    this.weightLearner.reset();
  }

  /**
   * Classify query intent using pattern matching.
   * Returns the first matching strategy, or 'general' if none match.
   */
  classifyIntent(query: string): QueryIntent {
    return classifyIntent(query, this.strategies);
  }

  /**
   * Get retrieval weights for a given intent.
   */
  getWeights(intent: QueryIntent): RetrievalWeights {
    const strategy = this.strategies.find((s) => s.intent === intent);
    if (strategy) return { ...strategy.weights };
    return { ...GENERAL_WEIGHTS };
  }

  /**
   * Run adaptive search:
   * 1. Classify intent
   * 2. Run enabled retrieval strategies in parallel
   * 3. Apply intent-weighted RRF fusion
   * 4. Return results with intent metadata
   */
  async search(
    query: string,
    records: Array<{ key: string; value: Record<string, unknown> }>,
    limit?: number,
  ): Promise<AdaptiveSearchResult[]> {
    const effectiveLimit = limit ?? this.defaultLimit;
    const intent = this.classifyIntent(query);
    let rawWeights = this.getWeights(intent);

    // Apply learned weight adjustments if learning is enabled
    if (this.learnFromFeedback) {
      rawWeights = this.weightLearner.blend(rawWeights, intent, this.weightLearner.learningRate);
    }

    // Determine which providers are available
    const available: SourceName[] = [];
    if (this.providers.vector) available.push('vector');
    if (this.providers.fts) available.push('fts');
    if (this.providers.graph) available.push('graph');

    if (available.length === 0) {
      return [];
    }

    // Redistribute weights from missing providers proportionally
    const weights = this.redistributeWeights(rawWeights, available);

    // Run searches in parallel, catching individual failures
    const searchResults: Partial<Record<SourceName, ScoredItem[]>> = {};
    const searchStartedAt = Date.now();
    const settled = await Promise.allSettled(
      available.map(async (source): Promise<[SourceName, ScoredItem[], number]> => {
        const providerStart = Date.now();
        switch (source) {
          case 'vector': {
            const results = await this.providers.vector!.search(
              this.namespace,
              query,
              effectiveLimit,
            );
            return ['vector', results, Date.now() - providerStart];
          }
          case 'fts': {
            const results = this.providers.fts!.search(records, query, effectiveLimit);
            return ['fts', results, Date.now() - providerStart];
          }
          case 'graph': {
            const results = this.providers.graph!.search(records, query, effectiveLimit);
            return ['graph', results, Date.now() - providerStart];
          }
        }
      }),
    );

    const succeededSources: SourceName[] = [];
    const warnings: RetrievalWarning[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]!;
      if (result.status === 'fulfilled') {
        const [source, items, durationMs] = result.value;
        searchResults[source] = items;
        succeededSources.push(source);
        this.healthTrackers.get(source)?.record(true, durationMs);
        this.eventBus?.emit({
          type: 'memory:retrieval_source_succeeded',
          source,
          resultCount: items.length,
          durationMs,
        });
      } else {
        const failedSource = available[i]!;
        const errorMessage =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        const durationMs = Date.now() - searchStartedAt;

        this.healthTrackers.get(failedSource)?.record(false, durationMs, errorMessage);
        warnings.push({ source: failedSource, error: errorMessage });
        this.eventBus?.emit({
          type: 'memory:retrieval_source_failed',
          source: failedSource,
          error: errorMessage,
          durationMs,
          query,
        });
      }
    }

    if (succeededSources.length === 0) {
      return [];
    }

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

    // Redistribute weights again if some providers failed at runtime
    const finalWeights =
      succeededSources.length < available.length
        ? this.redistributeWeights(rawWeights, succeededSources)
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

  /**
   * Redistribute weights from missing sources proportionally to available ones.
   */
  private redistributeWeights(
    original: RetrievalWeights,
    available: SourceName[],
  ): RetrievalWeights {
    const allSources: SourceName[] = ['vector', 'fts', 'graph'];

    // If all sources available, return original
    if (available.length === allSources.length) {
      return { ...original };
    }

    const availableTotal = available.reduce((sum, s) => sum + original[s], 0);

    // Avoid division by zero: if all available weights are 0, distribute equally
    if (availableTotal === 0) {
      const equal = 1 / available.length;
      const result: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };
      for (const s of available) {
        result[s] = equal;
      }
      return result;
    }

    // Scale available weights so they sum to 1
    const scale = 1 / availableTotal;
    const result: RetrievalWeights = { vector: 0, fts: 0, graph: 0 };
    for (const s of available) {
      result[s] = original[s] * scale;
    }
    return result;
  }
}
