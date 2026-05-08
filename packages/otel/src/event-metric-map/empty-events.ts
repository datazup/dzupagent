import { emptyAgentMetricMap } from './empty-events-agent.js'
import { emptyRuntimeMetricMap } from './empty-events-runtime.js'
import type { MetricMapFragment } from './types.js'

export const emptyEventMetricMap = {
  ...emptyAgentMetricMap,
  ...emptyRuntimeMetricMap,
} satisfies MetricMapFragment
