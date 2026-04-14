import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const toolLifecycleMetricMap = {
  // --- Tool lifecycle ---
  'tool:called': [
    {
      metricName: 'forge_tool_calls_total',
      type: 'counter',
      description: 'Total tool invocations',
      labelKeys: ['tool_name'],
      extract: (e) => {
        const ev = asEvent<'tool:called'>(e)
        return { value: 1, labels: { tool_name: ev.toolName } }
      },
    },
  ],

  'tool:result': [
    {
      metricName: 'forge_tool_duration_seconds',
      type: 'histogram',
      description: 'Tool execution duration in seconds',
      labelKeys: ['tool_name'],
      extract: (e) => {
        const ev = asEvent<'tool:result'>(e)
        return { value: ev.durationMs / 1000, labels: { tool_name: ev.toolName } }
      },
    },
  ],

  'tool:error': [
    {
      metricName: 'forge_tool_errors_total',
      type: 'counter',
      description: 'Total tool execution errors',
      labelKeys: ['tool_name', 'error_code'],
      extract: (e) => {
        const ev = asEvent<'tool:error'>(e)
        return { value: 1, labels: { tool_name: ev.toolName, error_code: ev.errorCode } }
      },
    },
  ],

} satisfies MetricMapFragment
