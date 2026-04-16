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


  'supervisor:circuit_breaker_filtered': [
    {
      metricName: 'dzip_supervisor_circuit_breaker_filtered_total',
      type: 'counter',
      description: 'Total agents filtered by circuit breaker',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  'supervisor:routing_decision': [
    {
      metricName: 'dzip_supervisor_routing_decisions_total',
      type: 'counter',
      description: 'Total routing decisions made by supervisor',
      labelKeys: ['strategy'],
      extract: (e) => {
        const ev = asEvent<'supervisor:routing_decision'>(e)
        return { value: 1, labels: { strategy: ev.strategy } }
      },
    },
  ],

  'supervisor:merge_complete': [
    {
      metricName: 'dzip_supervisor_merge_completions_total',
      type: 'counter',
      description: 'Total merge operations completed by supervisor',
      labelKeys: ['merge_status'],
      extract: (e) => {
        const ev = asEvent<'supervisor:merge_complete'>(e)
        return { value: 1, labels: { merge_status: ev.mergeStatus } }
      },
    },
  ],

} satisfies MetricMapFragment
