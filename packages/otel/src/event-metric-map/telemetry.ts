import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const telemetryMetricMap = {
  // --- Telemetry ---
  'tool:latency': [
    {
      metricName: 'forge_tool_latency_ms',
      type: 'histogram',
      description: 'Tool execution latency in milliseconds',
      labelKeys: ['tool_name'],
      extract: (e) => {
        const ev = asEvent<'tool:latency'>(e)
        return { value: ev.durationMs, labels: { tool_name: ev.toolName } }
      },
    },
  ],

  'agent:stop_reason': [
    {
      metricName: 'dzip_agent_stop_total',
      type: 'counter',
      description: 'Total agent stop events by reason',
      labelKeys: ['agent_id', 'reason'],
      extract: (e) => {
        const ev = asEvent<'agent:stop_reason'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, reason: ev.reason } }
      },
    },
  ],

  'agent:stuck_detected': [
    {
      metricName: 'dzip_agent_stuck_detected_total',
      type: 'counter',
      description: 'Total agent stuck detection events',
      labelKeys: ['agent_id', 'reason'],
      extract: (e) => {
        const ev = asEvent<'agent:stuck_detected'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, reason: ev.reason } }
      },
    },
  ],

} satisfies MetricMapFragment
