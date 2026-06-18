/**
 * S4-F — run-queue depth gauges.
 *
 * Reads a snapshot of the run queue and publishes three Prometheus gauges
 * describing queue depth and backlog health:
 *
 *   - `forge_queue_jobs_pending`     — jobs awaiting a worker
 *   - `forge_queue_jobs_active`      — jobs currently in-flight
 *   - `forge_queue_jobs_dead_letter` — jobs that exhausted retries
 *
 * The collector pulls (rather than the queue pushing) so values are fresh on
 * each Prometheus scrape: call {@link updateQueueGauges} from the `/metrics`
 * route handler just before `render()`.
 *
 * For durable backends (e.g. {@link PostgresRunQueue}) the synchronous
 * `stats()` only reflects the local in-flight snapshot. When the queue exposes
 * an async `statsAsync()` we prefer it for authoritative DB-aggregated counts.
 */
import type { PrometheusMetricsCollector } from "./prometheus-collector.js";
import type { QueueStats, RunQueue } from "../queue/run-queue.js";

/** Gauge metric names exposed for the run queue. */
export const QUEUE_GAUGE_PENDING = "forge_queue_jobs_pending";
export const QUEUE_GAUGE_ACTIVE = "forge_queue_jobs_active";
export const QUEUE_GAUGE_DEAD_LETTER = "forge_queue_jobs_dead_letter";

/**
 * Register help text + type for the three queue gauges. Idempotent; safe to
 * call at bootstrap so the metrics render with documentation even before the
 * first snapshot is taken.
 */
export function registerQueueGauges(
  collector: PrometheusMetricsCollector
): void {
  collector.register(
    QUEUE_GAUGE_PENDING,
    "gauge",
    "Run-queue jobs awaiting a worker (pending)"
  );
  collector.register(
    QUEUE_GAUGE_ACTIVE,
    "gauge",
    "Run-queue jobs currently in-flight (active)"
  );
  collector.register(
    QUEUE_GAUGE_DEAD_LETTER,
    "gauge",
    "Run-queue jobs that exhausted retries (dead-letter)"
  );
}

/**
 * Pull a queue snapshot from `queue` and set the three gauges on `collector`.
 *
 * Prefers `statsAsync()` (authoritative durable counts) when the queue exposes
 * it; otherwise falls back to the synchronous in-flight `stats()` snapshot.
 */
export async function updateQueueGauges(
  queue: RunQueue,
  collector: PrometheusMetricsCollector
): Promise<void> {
  let stats: QueueStats;
  const maybeAsync = queue as RunQueue & {
    statsAsync?: () => Promise<QueueStats>;
  };
  if (typeof maybeAsync.statsAsync === "function") {
    stats = await maybeAsync.statsAsync();
  } else {
    stats = queue.stats();
  }

  collector.gauge(QUEUE_GAUGE_PENDING, stats.pending);
  collector.gauge(QUEUE_GAUGE_ACTIVE, stats.active);
  collector.gauge(QUEUE_GAUGE_DEAD_LETTER, stats.deadLetter);
}
