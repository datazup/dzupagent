/**
 * Type definitions, configuration, default strategies, and intent
 * classification for the adaptive retriever.
 *
 * Extracted from `adaptive-retriever.ts` to keep the main file focused
 * on coordinating retrieval rather than holding type/config plumbing.
 */

import type { VectorSearchResult } from './vector-search.js';
import type { FTSSearchResult } from './fts-search.js';
import type { GraphSearchResult } from './graph-search.js';
import type { FusedResult } from './rrf-fusion.js';

// ─── Event Emitter Interface ─────────────────────────────────────────────────

/**
 * Minimal event emitter interface accepted by AdaptiveRetriever.
 *
 * Structurally compatible with DzupEventBus from `@dzupagent/core`,
 * but defined locally so `@dzupagent/memory` has no dependency on core.
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
  causal?: number | undefined;
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
  } | undefined;
  fts?: {
    search(
      records: Array<{ key: string; value: Record<string, unknown> }>,
      query: string,
      limit: number,
    ): FTSSearchResult[];
  } | undefined;
  graph?: {
    search(
      records: Array<{ key: string; value: Record<string, unknown> }>,
      query: string,
      limit: number,
    ): GraphSearchResult[];
  } | undefined;
}

export interface AdaptiveRetrieverConfig {
  providers: RetrievalProviders;
  /** Override default strategies */
  strategies?: RetrievalStrategy[] | undefined;
  /** Default retrieval limit (default: 10) */
  defaultLimit?: number | undefined;
  /** Namespace for vector search */
  namespace?: string[] | undefined;
  /** RRF constant k (default: 60) */
  k?: number | undefined;
  /** Optional event bus for retrieval failure observability */
  eventBus?: RetrievalEventEmitter | undefined;
  /** Enable dynamic weight learning from search quality feedback (default: false) */
  learnFromFeedback?: boolean | undefined;
}

export interface AdaptiveSearchResult extends FusedResult {
  /** Which intent was classified */
  intent: QueryIntent;
  /** Weights used for this search */
  weights: RetrievalWeights;
  /** Warnings from retrieval sources that failed at runtime (empty if all succeeded) */
  warnings: RetrievalWarning[];
}

// ─── Internal Types ──────────────────────────────────────────────────────────

/** Source name for the three built-in retrieval providers */
export type SourceName = 'vector' | 'fts' | 'graph';

/** Internal scored item shape produced by retrieval providers */
export interface ScoredItem {
  key: string;
  score: number;
  value: Record<string, unknown>;
}

/** All known source names — useful for iteration and clamping */
export const SOURCE_NAMES: readonly SourceName[] = ['vector', 'fts', 'graph'] as const;

// ─── Default Strategies ──────────────────────────────────────────────────────

export const GENERAL_WEIGHTS: RetrievalWeights = { vector: 0.4, fts: 0.3, graph: 0.3 };

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
      // eslint-disable-next-line security/detect-unsafe-regex
      /\b(?:[A-Z][a-z]{1,30}){2,10}\b/,
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
