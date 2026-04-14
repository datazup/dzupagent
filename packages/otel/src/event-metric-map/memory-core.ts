import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const memoryCoreMetricMap = {
  // --- Memory ---
  'memory:written': [
    {
      metricName: 'forge_memory_writes_total',
      type: 'counter',
      description: 'Total memory write operations',
      labelKeys: ['namespace'],
      extract: (e) => {
        const ev = asEvent<'memory:written'>(e)
        return { value: 1, labels: { namespace: ev.namespace } }
      },
    },
  ],

  'memory:searched': [
    {
      metricName: 'forge_memory_searches_total',
      type: 'counter',
      description: 'Total memory search operations',
      labelKeys: ['namespace'],
      extract: (e) => {
        const ev = asEvent<'memory:searched'>(e)
        return { value: 1, labels: { namespace: ev.namespace } }
      },
    },
  ],

  'memory:error': [
    {
      metricName: 'forge_memory_errors_total',
      type: 'counter',
      description: 'Total memory operation errors',
      labelKeys: ['namespace'],
      extract: (e) => {
        const ev = asEvent<'memory:error'>(e)
        return { value: 1, labels: { namespace: ev.namespace } }
      },
    },
  ],

} satisfies MetricMapFragment
