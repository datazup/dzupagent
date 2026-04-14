import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const vectorMetricMap = {
  // --- Vector Store ---
  'vector:search_completed': [
    {
      metricName: 'forge_vector_searches_total',
      type: 'counter',
      description: 'Total vector search operations',
      labelKeys: ['provider', 'collection'],
      extract: (e) => {
        const ev = asEvent<'vector:search_completed'>(e)
        return { value: 1, labels: { provider: ev.provider, collection: ev.collection } }
      },
    },
    {
      metricName: 'forge_vector_search_duration_seconds',
      type: 'histogram',
      description: 'Vector search duration in seconds',
      labelKeys: ['provider', 'collection'],
      extract: (e) => {
        const ev = asEvent<'vector:search_completed'>(e)
        return { value: ev.latencyMs / 1000, labels: { provider: ev.provider, collection: ev.collection } }
      },
    },
    {
      metricName: 'forge_vector_search_result_count',
      type: 'histogram',
      description: 'Number of results returned per vector search',
      labelKeys: ['provider', 'collection'],
      extract: (e) => {
        const ev = asEvent<'vector:search_completed'>(e)
        return { value: ev.resultCount, labels: { provider: ev.provider, collection: ev.collection } }
      },
    },
  ],

  'vector:upsert_completed': [
    {
      metricName: 'forge_vector_upserts_total',
      type: 'counter',
      description: 'Total vector upsert operations',
      labelKeys: ['provider', 'collection'],
      extract: (e) => {
        const ev = asEvent<'vector:upsert_completed'>(e)
        return { value: ev.count, labels: { provider: ev.provider, collection: ev.collection } }
      },
    },
    {
      metricName: 'forge_vector_upsert_duration_seconds',
      type: 'histogram',
      description: 'Vector upsert duration in seconds',
      labelKeys: ['provider', 'collection'],
      extract: (e) => {
        const ev = asEvent<'vector:upsert_completed'>(e)
        return { value: ev.latencyMs / 1000, labels: { provider: ev.provider, collection: ev.collection } }
      },
    },
  ],

  'vector:embedding_completed': [
    {
      metricName: 'forge_vector_embeddings_total',
      type: 'counter',
      description: 'Total embedding generation operations',
      labelKeys: ['provider'],
      extract: (e) => {
        const ev = asEvent<'vector:embedding_completed'>(e)
        return { value: 1, labels: { provider: ev.provider } }
      },
    },
    {
      metricName: 'forge_vector_embedding_duration_seconds',
      type: 'histogram',
      description: 'Embedding generation duration in seconds',
      labelKeys: ['provider'],
      extract: (e) => {
        const ev = asEvent<'vector:embedding_completed'>(e)
        return { value: ev.latencyMs / 1000, labels: { provider: ev.provider } }
      },
    },
  ],

  'vector:error': [
    {
      metricName: 'forge_vector_errors_total',
      type: 'counter',
      description: 'Total vector store errors',
      labelKeys: ['provider', 'collection', 'operation'],
      extract: (e) => {
        const ev = asEvent<'vector:error'>(e)
        return { value: 1, labels: { provider: ev.provider, collection: ev.collection, operation: ev.operation } }
      },
    },
  ],

} satisfies MetricMapFragment
