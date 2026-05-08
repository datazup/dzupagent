/**
 * Provider health tracking for the adaptive retriever.
 *
 * Maintains a sliding-window of success/failure/latency entries per provider
 * so callers can introspect retrieval reliability over time.
 */

import type { SourceName } from './adaptive-retriever-types.js';

/** Sliding-window health metrics for a single retrieval provider */
export interface ProviderHealthMetrics {
  source: SourceName;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  successRate: number;
  lastFailure?: { error: string; timestamp: Date } | undefined;
}

const DEFAULT_HEALTH_WINDOW_SIZE = 100;

export class ProviderHealthTracker {
  private readonly windowSize: number;
  private readonly entries: Array<{ ok: boolean; latencyMs: number; error?: string }> = [];

  constructor(windowSize = DEFAULT_HEALTH_WINDOW_SIZE) {
    this.windowSize = windowSize;
  }

  record(ok: boolean, latencyMs: number, error?: string): void {
    this.entries.push({ ok, latencyMs, ...(error !== undefined ? { error } : {}) });
    if (this.entries.length > this.windowSize) {
      this.entries.shift();
    }
  }

  metrics(source: SourceName): ProviderHealthMetrics {
    const successes = this.entries.filter(e => e.ok);
    const failures = this.entries.filter(e => !e.ok);
    const totalLatency = successes.reduce((sum, e) => sum + e.latencyMs, 0);
    const lastFail = failures.length > 0 ? failures[failures.length - 1] : undefined;

    return {
      source,
      successCount: successes.length,
      failureCount: failures.length,
      totalLatencyMs: totalLatency,
      avgLatencyMs: successes.length > 0 ? totalLatency / successes.length : 0,
      successRate: this.entries.length > 0 ? successes.length / this.entries.length : 1,
      lastFailure: lastFail ? { error: lastFail.error ?? 'unknown', timestamp: new Date() } : undefined,
    };
  }
}
