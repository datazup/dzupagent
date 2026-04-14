/**
 * Lightweight metrics collector for DzupAgent.
 *
 * Tracks counters, gauges, and histograms. Exposes data in a format
 * compatible with Prometheus text exposition (or JSON for REST endpoints).
 */

export type MetricType = 'counter' | 'gauge' | 'histogram'

interface MetricEntry {
  name: string
  type: MetricType
  help: string
  labels: Record<string, string>
  value: number
  buckets?: number[] // histogram only
  sum?: number       // histogram only
  count?: number     // histogram only
}

export class MetricsCollector {
  private metrics = new Map<string, MetricEntry>()

  /** Increment a counter by 1 (or custom amount) */
  increment(name: string, labels?: Record<string, string>, amount = 1): void {
    const key = this.key(name, labels)
    const existing = this.metrics.get(key)
    if (existing) {
      existing.value += amount
    } else {
      this.metrics.set(key, {
        name,
        type: 'counter',
        help: '',
        labels: labels ?? {},
        value: amount,
      })
    }
  }

  /** Set a gauge to an absolute value */
  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.key(name, labels)
    const existing = this.metrics.get(key)
    if (existing) {
      existing.value = value
    } else {
      this.metrics.set(key, {
        name,
        type: 'gauge',
        help: '',
        labels: labels ?? {},
        value,
      })
    }
  }

  /** Record a histogram observation */
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.key(name, labels)
    const existing = this.metrics.get(key)
    if (existing) {
      existing.sum = (existing.sum ?? 0) + value
      existing.count = (existing.count ?? 0) + 1
      existing.value = value // last observed
    } else {
      this.metrics.set(key, {
        name,
        type: 'histogram',
        help: '',
        labels: labels ?? {},
        value,
        sum: value,
        count: 1,
      })
    }
  }

  /** Get all metrics as JSON */
  toJSON(): Record<string, unknown>[] {
    return [...this.metrics.values()].map(m => ({
      name: m.name,
      type: m.type,
      labels: m.labels,
      value: m.value,
      ...(m.sum !== undefined ? { sum: m.sum, count: m.count } : {}),
    }))
  }

  /** Get a specific metric value */
  get(name: string, labels?: Record<string, string>): number | undefined {
    return this.metrics.get(this.key(name, labels))?.value
  }

  /** Reset all metrics */
  reset(): void {
    this.metrics.clear()
  }

  private key(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    return `${name}{${sorted.map(([k, v]) => `${k}="${v}"`).join(',')}}`
  }
}

/** Singleton metrics collector instance */
export const globalMetrics = new MetricsCollector()
