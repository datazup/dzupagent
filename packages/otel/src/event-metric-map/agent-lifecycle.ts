import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const agentLifecycleMetricMap = {
  // --- Agent lifecycle ---
  'agent:started': [
    {
      metricName: 'dzip_agent_runs_total',
      type: 'counter',
      description: 'Total agent run starts',
      labelKeys: ['agent_id', 'status'],
      extract: (e) => {
        const ev = asEvent<'agent:started'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, status: 'started' } }
      },
    },
  ],

  'agent:completed': [
    {
      metricName: 'dzip_agent_runs_total',
      type: 'counter',
      description: 'Total agent run completions',
      labelKeys: ['agent_id', 'status'],
      extract: (e) => {
        const ev = asEvent<'agent:completed'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, status: 'completed' } }
      },
    },
    {
      metricName: 'dzip_agent_duration_seconds',
      type: 'histogram',
      description: 'Agent run duration in seconds',
      labelKeys: ['agent_id'],
      extract: (e) => {
        const ev = asEvent<'agent:completed'>(e)
        return { value: ev.durationMs / 1000, labels: { agent_id: ev.agentId } }
      },
    },
  ],

  'agent:failed': [
    {
      metricName: 'dzip_agent_errors_total',
      type: 'counter',
      description: 'Total agent run failures',
      labelKeys: ['agent_id', 'error_code'],
      extract: (e) => {
        const ev = asEvent<'agent:failed'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, error_code: ev.errorCode } }
      },
    },
  ],


  // --- Run lifecycle (pause / resume / cancel) ---
  'run:paused': [
    {
      metricName: 'dzip_run_paused_total',
      type: 'counter',
      description: 'Total runs paused',
      labelKeys: ['agent_id'],
      extract: (e) => {
        const ev = asEvent<'run:paused'>(e)
        return { value: 1, labels: { agent_id: ev.agentId } }
      },
    },
  ],

  'run:resumed': [
    {
      metricName: 'dzip_run_resumed_total',
      type: 'counter',
      description: 'Total runs resumed',
      labelKeys: ['agent_id'],
      extract: (e) => {
        const ev = asEvent<'run:resumed'>(e)
        return { value: 1, labels: { agent_id: ev.agentId } }
      },
    },
  ],

  'run:cancelled': [
    {
      metricName: 'dzip_run_cancelled_total',
      type: 'counter',
      description: 'Total runs cancelled',
      labelKeys: ['agent_id'],
      extract: (e) => {
        const ev = asEvent<'run:cancelled'>(e)
        return { value: 1, labels: { agent_id: ev.agentId } }
      },
    },
  ],

} satisfies MetricMapFragment
