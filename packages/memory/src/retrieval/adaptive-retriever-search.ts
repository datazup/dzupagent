/**
 * Per-provider search execution + result aggregation for the adaptive retriever.
 *
 * Encapsulates the parallel `Promise.allSettled` orchestration, health tracking,
 * event emission, and warning collection so the main retriever class stays a
 * small coordinator.
 */

import type {
  RetrievalEventEmitter,
  RetrievalProviders,
  RetrievalWarning,
  ScoredItem,
  SourceName,
} from './adaptive-retriever-types.js';
import { ProviderHealthTracker } from './adaptive-retriever-health.js';

/** Result of executing one search across all available providers */
export interface ProviderSearchOutcome {
  /** Per-source results from providers that returned successfully */
  searchResults: Partial<Record<SourceName, ScoredItem[]>>;
  /** Sources that succeeded (in `available` order, fulfilled-only) */
  succeededSources: SourceName[];
  /** Warnings collected from sources that threw at runtime */
  warnings: RetrievalWarning[];
}

interface ExecuteOptions {
  query: string;
  records: Array<{ key: string; value: Record<string, unknown> }>;
  limit: number;
  namespace: string[];
  available: SourceName[];
  providers: RetrievalProviders;
  healthTrackers: Map<SourceName, ProviderHealthTracker>;
  eventBus?: RetrievalEventEmitter | undefined;
}

/**
 * Run all available retrieval providers in parallel, capture per-provider
 * latency/success/failure, emit observability events, and return aggregated
 * scored items together with warnings.
 */
export async function executeProviderSearches(
  opts: ExecuteOptions,
): Promise<ProviderSearchOutcome> {
  const { query, records, limit, namespace, available, providers, healthTrackers, eventBus } = opts;

  const searchResults: Partial<Record<SourceName, ScoredItem[]>> = {};
  const searchStartedAt = Date.now();

  const settled = await Promise.allSettled(
    available.map(async (source): Promise<[SourceName, ScoredItem[], number]> => {
      const providerStart = Date.now();
      switch (source) {
        case 'vector': {
          const results = await providers.vector!.search(namespace, query, limit);
          return ['vector', results, Date.now() - providerStart];
        }
        case 'fts': {
          const results = providers.fts!.search(records, query, limit);
          return ['fts', results, Date.now() - providerStart];
        }
        case 'graph': {
          const results = providers.graph!.search(records, query, limit);
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
      healthTrackers.get(source)?.record(true, durationMs);
      eventBus?.emit({
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

      healthTrackers.get(failedSource)?.record(false, durationMs, errorMessage);
      warnings.push({ source: failedSource, error: errorMessage });
      eventBus?.emit({
        type: 'memory:retrieval_source_failed',
        source: failedSource,
        error: errorMessage,
        durationMs,
        query,
      });
    }
  }

  return { searchResults, succeededSources, warnings };
}
