import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const delegationMetricMap = {
  // --- Delegation ---
  'delegation:started': [
    {
      metricName: 'forge_delegation_started_total',
      type: 'counter',
      description: 'Total delegation start events',
      labelKeys: ['target_agent_id'],
      extract: (e) => {
        const ev = asEvent<'delegation:started'>(e)
        return { value: 1, labels: { target_agent_id: ev.targetAgentId } }
      },
    },
  ],

  'delegation:completed': [
    {
      metricName: 'forge_delegation_completed_total',
      type: 'counter',
      description: 'Total delegation completion events',
      labelKeys: ['target_agent_id', 'success'],
      extract: (e) => {
        const ev = asEvent<'delegation:completed'>(e)
        return { value: 1, labels: { target_agent_id: ev.targetAgentId, success: String(ev.success) } }
      },
    },
    {
      metricName: 'forge_delegation_duration_ms',
      type: 'histogram',
      description: 'Delegation duration in milliseconds',
      labelKeys: ['target_agent_id'],
      extract: (e) => {
        const ev = asEvent<'delegation:completed'>(e)
        return { value: ev.durationMs, labels: { target_agent_id: ev.targetAgentId } }
      },
    },
  ],

  'delegation:failed': [
    {
      metricName: 'forge_delegation_failed_total',
      type: 'counter',
      description: 'Total delegation failure events',
      labelKeys: ['target_agent_id'],
      extract: (e) => {
        const ev = asEvent<'delegation:failed'>(e)
        return { value: 1, labels: { target_agent_id: ev.targetAgentId } }
      },
    },
  ],

  'delegation:timeout': [
    {
      metricName: 'forge_delegation_timeout_total',
      type: 'counter',
      description: 'Total delegation timeout events',
      labelKeys: ['target_agent_id'],
      extract: (e) => {
        const ev = asEvent<'delegation:timeout'>(e)
        return { value: 1, labels: { target_agent_id: ev.targetAgentId } }
      },
    },
  ],

  'delegation:cancelled': [
    {
      metricName: 'forge_delegation_cancelled_total',
      type: 'counter',
      description: 'Total delegation cancellation events',
      labelKeys: ['target_agent_id'],
      extract: (e) => {
        const ev = asEvent<'delegation:cancelled'>(e)
        return { value: 1, labels: { target_agent_id: ev.targetAgentId } }
      },
    },
  ],

} satisfies MetricMapFragment
