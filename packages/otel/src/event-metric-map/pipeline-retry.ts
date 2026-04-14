import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const pipelineRetryMetricMap = {
  // --- Pipeline Retry ---
  'pipeline:node_retry': [
    {
      metricName: 'forge_pipeline_node_retries_total',
      type: 'counter',
      description: 'Total pipeline node retry attempts',
      labelKeys: ['pipeline_id', 'node_id', 'attempt'],
      extract: (e) => {
        const ev = asEvent<'pipeline:node_retry'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, node_id: ev.nodeId, attempt: String(ev.attempt) } }
      },
    },
  ],

} satisfies MetricMapFragment
