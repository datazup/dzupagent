import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const memoryRetrievalSourcesMetricMap = {
  // --- Memory Retrieval Sources ---
  'memory:retrieval_source_failed': [
    {
      metricName: 'forge_memory_retrieval_source_failures_total',
      type: 'counter',
      description: 'Total memory retrieval source failures',
      labelKeys: ['source'],
      extract: (e) => {
        const ev = asEvent<'memory:retrieval_source_failed'>(e)
        return { value: 1, labels: { source: ev.source } }
      },
    },
    {
      metricName: 'forge_memory_retrieval_source_duration_ms',
      type: 'histogram',
      description: 'Memory retrieval source duration in milliseconds',
      labelKeys: ['source'],
      extract: (e) => {
        const ev = asEvent<'memory:retrieval_source_failed'>(e)
        return { value: ev.durationMs, labels: { source: ev.source } }
      },
    },
  ],

  'memory:retrieval_source_succeeded': [
    {
      metricName: 'forge_memory_retrieval_source_successes_total',
      type: 'counter',
      description: 'Total memory retrieval source successes',
      labelKeys: ['source'],
      extract: (e) => {
        const ev = asEvent<'memory:retrieval_source_succeeded'>(e)
        return { value: 1, labels: { source: ev.source } }
      },
    },
    {
      metricName: 'forge_memory_retrieval_source_duration_ms',
      type: 'histogram',
      description: 'Memory retrieval source duration in milliseconds',
      labelKeys: ['source'],
      extract: (e) => {
        const ev = asEvent<'memory:retrieval_source_succeeded'>(e)
        return { value: ev.durationMs, labels: { source: ev.source } }
      },
    },
  ],

} satisfies MetricMapFragment
