import type { DzupEvent, DzupEventOf } from '@dzupagent/core'

/**
 * A single metric mapping rule: defines how a DzupEvent translates
 * to a metric observation (counter increment or histogram record).
 */
export interface MetricMapping {
  /** Metric name (e.g. 'dzip_agent_runs_total') */
  metricName: string
  /** Metric type */
  type: 'counter' | 'histogram' | 'gauge'
  /** Human-readable description for the metric */
  description: string
  /** Label keys used by this metric */
  labelKeys: string[]
  /**
   * Extract metric value and labels from an event.
   * For counters, value defaults to 1 if not specified.
   */
  extract: (event: DzupEvent) => { value: number; labels: Record<string, string> }
}

export type MetricMapFragment = Partial<Record<DzupEvent['type'], MetricMapping[]>>

/** Helper to safely narrow event types. */
export function asEvent<T extends DzupEvent['type']>(event: DzupEvent): DzupEventOf<T> {
  return event as DzupEventOf<T>
}
