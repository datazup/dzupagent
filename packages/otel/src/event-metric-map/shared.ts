import type { DzupEvent } from '@dzupagent/core'

import type { MetricMapping } from './types.js'
export { asEvent } from './types.js'

function createMetricMapping(
  type: MetricMapping['type'],
  metricName: string,
  description: string,
  labelKeys: readonly string[],
  extract: MetricMapping['extract'],
): MetricMapping {
  return {
    metricName,
    type,
    description,
    labelKeys: [...labelKeys],
    extract,
  }
}

export function counter(
  metricName: string,
  description: string,
  labelKeys: readonly string[],
  extract: MetricMapping['extract'],
): MetricMapping {
  return createMetricMapping('counter', metricName, description, labelKeys, extract)
}

export function histogram(
  metricName: string,
  description: string,
  labelKeys: readonly string[],
  extract: MetricMapping['extract'],
): MetricMapping {
  return createMetricMapping('histogram', metricName, description, labelKeys, extract)
}

export function gauge(
  metricName: string,
  description: string,
  labelKeys: readonly string[],
  extract: MetricMapping['extract'],
): MetricMapping {
  return createMetricMapping('gauge', metricName, description, labelKeys, extract)
}

export function getAllMetricNames(map: Record<DzupEvent['type'], MetricMapping[]>): string[] {
  const names = new Set<string>()
  for (const mappings of Object.values(map)) {
    for (const mapping of mappings) {
      names.add(mapping.metricName)
    }
  }
  return [...names]
}
