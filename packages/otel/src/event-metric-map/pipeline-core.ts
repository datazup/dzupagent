import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const pipelineCoreMetricMap = {
  // --- Pipeline ---
  'pipeline:phase_changed': [
    {
      metricName: 'forge_pipeline_phase_transitions_total',
      type: 'counter',
      description: 'Total pipeline phase transitions',
      labelKeys: ['from', 'to'],
      extract: (e) => {
        const ev = asEvent<'pipeline:phase_changed'>(e)
        return { value: 1, labels: { from: ev.previousPhase, to: ev.phase } }
      },
    },
  ],

  'pipeline:validation_failed': [
    {
      metricName: 'forge_pipeline_validation_failures_total',
      type: 'counter',
      description: 'Total pipeline validation failures',
      labelKeys: ['phase'],
      extract: (e) => {
        const ev = asEvent<'pipeline:validation_failed'>(e)
        return { value: 1, labels: { phase: ev.phase } }
      },
    },
  ],

} satisfies MetricMapFragment
