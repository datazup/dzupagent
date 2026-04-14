/**
 * Prometheus-compatible MetricsCollector implementation.
 *
 * Extends the core MetricsCollector to add `render()` which serializes
 * all tracked metrics in the Prometheus text exposition format.
 *
 * Usage:
 * ```ts
 * const collector = new PrometheusMetricsCollector()
 * collector.increment('forge_routing_total', { tier: 'chat' })
 * collector.observe('forge_run_duration_ms', 123, { tier: 'chat' })
 * console.log(collector.render())
 * ```
 */
import { MetricsCollector } from '@dzupagent/core'

/** Default histogram bucket boundaries (in ms). */
const DEFAULT_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000] as const

/**
 * Internal representation of a single label-set for a counter metric.
 */
interface CounterSeries {
  value: number
}

/**
 * Internal representation of a single label-set for a gauge metric.
 */
interface GaugeSeries {
  value: number
}

/**
 * Internal representation of a single label-set for a histogram metric.
 * Stores cumulative bucket counts plus sum/count so render stays O(buckets)
 * without retaining raw observations.
 */
interface HistogramSeries {
  bucketCounts: number[]
  sum: number
  count: number
}

/**
 * Metadata about a metric (shared across all label-sets).
 */
interface MetricMeta {
  type: 'counter' | 'histogram' | 'gauge'
  help: string
}

/**
 * Build a unique map key from sorted labels.
 */
function labelsKey(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return ''
  const sorted = Object.keys(labels).sort()
  return sorted.map(k => `${k}="${labels[k]!}"`).join(',')
}

/**
 * PrometheusMetricsCollector extends the core MetricsCollector and adds
 * the ability to render metrics in Prometheus text exposition format.
 *
 * It maintains its own internal state (separate from the parent) so that
 * histogram bucket boundaries can be computed correctly.
 */
export class PrometheusMetricsCollector extends MetricsCollector {
  private counters = new Map<string, Map<string, CounterSeries>>()
  private histograms = new Map<string, Map<string, HistogramSeries>>()
  private gauges = new Map<string, Map<string, GaugeSeries>>()
  private meta = new Map<string, MetricMeta>()

  /**
   * Register help text and type for a metric.
   * If not called, defaults are generated automatically.
   */
  register(name: string, type: 'counter' | 'histogram' | 'gauge', help: string): void {
    this.meta.set(name, { type, help })
  }

  /**
   * Increment a counter. Delegates to the parent class and also tracks
   * internally for Prometheus rendering.
   */
  override increment(name: string, labels?: Record<string, string>, amount = 1): void {
    super.increment(name, labels, amount)

    if (!this.meta.has(name)) {
      this.meta.set(name, { type: 'counter', help: name })
    }
    let series = this.counters.get(name)
    if (!series) {
      series = new Map<string, CounterSeries>()
      this.counters.set(name, series)
    }
    const key = labelsKey(labels)
    const existing = series.get(key)
    if (existing) {
      existing.value += amount
    } else {
      series.set(key, { value: amount })
    }
  }

  /**
   * Record a histogram observation. Delegates to the parent class and also
   * tracks internally for Prometheus rendering (with bucket support).
   */
  override observe(name: string, value: number, labels?: Record<string, string>): void {
    super.observe(name, value, labels)

    if (!this.meta.has(name)) {
      this.meta.set(name, { type: 'histogram', help: name })
    }
    let series = this.histograms.get(name)
    if (!series) {
      series = new Map<string, HistogramSeries>()
      this.histograms.set(name, series)
    }
    const key = labelsKey(labels)
    const existing = series.get(key)
    if (existing) {
      this.recordHistogramObservation(existing, value)
    } else {
      const histogram = this.createHistogramSeries()
      this.recordHistogramObservation(histogram, value)
      series.set(key, histogram)
    }
  }

  /**
   * Set a gauge to an absolute value. Delegates to the parent class and
   * also tracks internally for Prometheus rendering.
   */
  override gauge(name: string, value: number, labels?: Record<string, string>): void {
    super.gauge(name, value, labels)

    if (!this.meta.has(name)) {
      this.meta.set(name, { type: 'gauge', help: name })
    }
    let series = this.gauges.get(name)
    if (!series) {
      series = new Map<string, GaugeSeries>()
      this.gauges.set(name, series)
    }
    const key = labelsKey(labels)
    const existing = series.get(key)
    if (existing) {
      existing.value = value
    } else {
      series.set(key, { value })
    }
  }

  /**
   * Render all metrics in Prometheus text exposition format (text/plain).
   *
   * Output groups metrics by name, with `# HELP` and `# TYPE` headers,
   * followed by one line per label-set. Histograms include `_bucket`,
   * `_sum`, and `_count` suffixed lines.
   *
   * Returns an empty string when no metrics have been recorded.
   */
  render(): string {
    const lines: string[] = []

    // Render counters
    for (const [name, series] of this.counters) {
      const meta = this.meta.get(name)
      lines.push(`# HELP ${name} ${meta?.help ?? name}`)
      lines.push(`# TYPE ${name} counter`)
      for (const [key, s] of series) {
        const labelStr = key ? `{${key}}` : ''
        lines.push(`${name}${labelStr} ${s.value}`)
      }
      lines.push('')
    }

    // Render histograms
    for (const [name, series] of this.histograms) {
      const meta = this.meta.get(name)
      lines.push(`# HELP ${name} ${meta?.help ?? name}`)
      lines.push(`# TYPE ${name} histogram`)
      for (const [key, s] of series) {
        const labelStr = key ? `{${key}}` : ''
        const labelPrefix = key ? `${key},` : ''

        // Bucket lines
        for (let i = 0; i < DEFAULT_BUCKETS.length; i++) {
          lines.push(`${name}_bucket{${labelPrefix}le="${DEFAULT_BUCKETS[i]}"} ${s.bucketCounts[i] ?? 0}`)
        }
        // +Inf bucket (always equals count)
        lines.push(`${name}_bucket{${labelPrefix}le="+Inf"} ${s.count}`)

        // Sum and count
        lines.push(`${name}_sum${labelStr} ${s.sum}`)
        lines.push(`${name}_count${labelStr} ${s.count}`)
      }
      lines.push('')
    }

    // Render gauges
    for (const [name, series] of this.gauges) {
      const meta = this.meta.get(name)
      lines.push(`# HELP ${name} ${meta?.help ?? name}`)
      lines.push(`# TYPE ${name} gauge`)
      for (const [key, s] of series) {
        const labelStr = key ? `{${key}}` : ''
        lines.push(`${name}${labelStr} ${s.value}`)
      }
      lines.push('')
    }

    // Remove trailing empty line and return
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop()
    }

    return lines.join('\n')
  }

  /**
   * Reset all metrics (both parent and Prometheus internal state).
   */
  override reset(): void {
    super.reset()
    this.counters.clear()
    this.histograms.clear()
    this.gauges.clear()
    this.meta.clear()
  }

  private createHistogramSeries(): HistogramSeries {
    return {
      bucketCounts: Array.from({ length: DEFAULT_BUCKETS.length }, () => 0),
      sum: 0,
      count: 0,
    }
  }

  private recordHistogramObservation(series: HistogramSeries, value: number): void {
    for (let i = 0; i < DEFAULT_BUCKETS.length; i++) {
      const boundary = DEFAULT_BUCKETS[i]
      if (boundary !== undefined && value <= boundary) {
        series.bucketCounts[i] = (series.bucketCounts[i] ?? 0) + 1
      }
    }
    series.sum += value
    series.count += 1
  }
}
