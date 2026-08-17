
import type { MetricMapFragment, MetricMapping } from './types.js'
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

/**
 * Collect the distinct metric names declared by a map.
 *
 * Takes a fragment (partial map) rather than a complete
 * `Record<DzupEvent['type'], MetricMapping[]>`: the body only iterates the
 * values present, and every map in this package — including the assembled
 * `EVENT_METRIC_MAP` — is built from partial fragments, so the stricter
 * signature rejected its own callers.
 */
export function getAllMetricNames(map: MetricMapFragment): string[] {
  const names = new Set<string>()
  for (const mappings of Object.values(map)) {
    if (!mappings) continue
    for (const mapping of mappings) {
      names.add(mapping.metricName)
    }
  }
  return [...names]
}
