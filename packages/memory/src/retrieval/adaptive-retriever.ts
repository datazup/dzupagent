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
}

export interface AdaptiveSearchResult extends FusedResult {
  /** Which intent was classified */
  intent: QueryIntent;
  /** Weights used for this search */
  weights: RetrievalWeights;
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

// ─── Adaptive Retriever ──────────────────────────────────────────────────────

export class AdaptiveRetriever {
  private readonly strategies: RetrievalStrategy[];
  private readonly defaultLimit: number;
  private readonly namespace: string[];
  private readonly k: number;
  private readonly providers: RetrievalProviders;

  constructor(config: AdaptiveRetrieverConfig) {
    this.providers = config.providers;
    this.strategies = config.strategies ?? DEFAULT_STRATEGIES;
    this.defaultLimit = config.defaultLimit ?? 10;
    this.namespace = config.namespace ?? ['memories'];
    this.k = config.k ?? 60;
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
    const rawWeights = this.getWeights(intent);

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
    const settled = await Promise.allSettled(
      available.map(async (source): Promise<[SourceName, ScoredItem[]]> => {
        switch (source) {
          case 'vector': {
            const results = await this.providers.vector!.search(
              this.namespace,
              query,
              effectiveLimit,
            );
            return ['vector', results];
          }
          case 'fts': {
            const results = this.providers.fts!.search(records, query, effectiveLimit);
            return ['fts', results];
          }
          case 'graph': {
            const results = this.providers.graph!.search(records, query, effectiveLimit);
            return ['graph', results];
          }
        }
      }),
    );

    const succeededSources: SourceName[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const [source, items] = result.value;
        searchResults[source] = items;
        succeededSources.push(source);
      }
      // Rejected providers are silently skipped (non-fatal)
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
