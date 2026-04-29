import { asEvent, counter } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const providerRunMetricMap = {
  'provider:run_attempt': [
    counter(
      'dzip_provider_run_events_total',
      'Total provider run attempt events',
      ['agent_id', 'provider', 'model', 'phase', 'status'],
      (e) => {
        const ev = asEvent<'provider:run_attempt'>(e)
        return {
          value: 1,
          labels: {
            agent_id: ev.agentId,
            provider: ev.provider,
            model: ev.model,
            phase: ev.phase,
            status: 'attempt',
          },
        }
      },
    ),
  ],

  'provider:run_failure': [
    counter(
      'dzip_provider_run_events_total',
      'Total provider run failure events',
      ['agent_id', 'provider', 'model', 'phase', 'status'],
      (e) => {
        const ev = asEvent<'provider:run_failure'>(e)
        return {
          value: 1,
          labels: {
            agent_id: ev.agentId,
            provider: ev.provider,
            model: ev.model,
            phase: ev.phase,
            status: ev.retrying ? 'failure_retrying' : 'failure_final',
          },
        }
      },
    ),
  ],

  'provider:run_selected': [
    counter(
      'dzip_provider_run_events_total',
      'Total provider run selection events',
      ['agent_id', 'provider', 'model', 'phase', 'status'],
      (e) => {
        const ev = asEvent<'provider:run_selected'>(e)
        return {
          value: 1,
          labels: {
            agent_id: ev.agentId,
            provider: ev.provider,
            model: ev.model,
            phase: ev.phase,
            status: 'selected',
          },
        }
      },
    ),
  ],
} satisfies MetricMapFragment
