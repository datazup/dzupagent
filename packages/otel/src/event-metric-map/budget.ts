import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const budgetMetricMap = {
  // --- Budget ---
  'budget:warning': [
    {
      metricName: 'forge_budget_warnings_total',
      type: 'counter',
      description: 'Total budget warning events',
      labelKeys: ['level'],
      extract: (e) => {
        const ev = asEvent<'budget:warning'>(e)
        return { value: 1, labels: { level: ev.level } }
      },
    },
  ],

  'budget:exceeded': [
    {
      metricName: 'forge_budget_exceeded_total',
      type: 'counter',
      description: 'Total budget exceeded events',
      labelKeys: ['reason'],
      extract: (e) => {
        const ev = asEvent<'budget:exceeded'>(e)
        return { value: 1, labels: { reason: ev.reason } }
      },
    },
  ],

} satisfies MetricMapFragment
