import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const supervisorMetricMap = {
  // --- Supervisor ---
  'supervisor:delegating': [
    {
      metricName: 'forge_supervisor_delegations_total',
      type: 'counter',
      description: 'Total supervisor delegation events',
      labelKeys: ['specialist_id'],
      extract: (e) => {
        const ev = asEvent<'supervisor:delegating'>(e)
        return { value: 1, labels: { specialist_id: ev.specialistId } }
      },
    },
  ],

  'supervisor:delegation_complete': [
    {
      metricName: 'forge_supervisor_delegation_completions_total',
      type: 'counter',
      description: 'Total supervisor delegation completions',
      labelKeys: ['specialist_id', 'success'],
      extract: (e) => {
        const ev = asEvent<'supervisor:delegation_complete'>(e)
        return { value: 1, labels: { specialist_id: ev.specialistId, success: String(ev.success) } }
      },
    },
  ],

  'supervisor:plan_created': [
    {
      metricName: 'forge_supervisor_plans_created_total',
      type: 'counter',
      description: 'Total supervisor plan creation events',
      labelKeys: ['source'],
      extract: (e) => {
        const ev = asEvent<'supervisor:plan_created'>(e)
        return { value: 1, labels: { source: ev.source ?? 'unknown' } }
      },
    },
  ],

  'supervisor:llm_decompose_fallback': [
    {
      metricName: 'forge_supervisor_llm_fallbacks_total',
      type: 'counter',
      description: 'Total supervisor LLM decomposition fallback events',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

} satisfies MetricMapFragment
