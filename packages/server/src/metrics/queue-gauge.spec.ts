/**
 * Unit tests for {@link updateQueueGauges} and {@link registerQueueGauges}.
 *
 * Uses the real {@link PrometheusMetricsCollector} so the test exercises the
 * actual stats → gauge translation and the rendered Prometheus exposition.
 */
import { describe, it, expect } from "vitest";
import { PrometheusMetricsCollector } from "./prometheus-collector.js";
import {
  registerQueueGauges,
  updateQueueGauges,
  QUEUE_GAUGE_PENDING,
  QUEUE_GAUGE_ACTIVE,
  QUEUE_GAUGE_DEAD_LETTER,
} from "./queue-gauge.js";
import type { QueueStats, RunQueue } from "../queue/run-queue.js";

function stubQueue(
  stats: QueueStats,
  asyncStats?: QueueStats
): RunQueue & { statsAsync?: () => Promise<QueueStats> } {
  const queue: Partial<RunQueue> & {
    statsAsync?: () => Promise<QueueStats>;
  } = {
    stats: () => stats,
  };
  if (asyncStats) {
    queue.statsAsync = async () => asyncStats;
  }
  return queue as RunQueue & { statsAsync?: () => Promise<QueueStats> };
}

describe("updateQueueGauges", () => {
  it("sets gauges from the synchronous stats() snapshot", async () => {
    const collector = new PrometheusMetricsCollector();
    const queue = stubQueue({
      pending: 7,
      active: 3,
      completed: 100,
      failed: 2,
      deadLetter: 4,
    });

    await updateQueueGauges(queue, collector);

    const rendered = collector.render();
    expect(rendered).toContain(`${QUEUE_GAUGE_PENDING} 7`);
    expect(rendered).toContain(`${QUEUE_GAUGE_ACTIVE} 3`);
    expect(rendered).toContain(`${QUEUE_GAUGE_DEAD_LETTER} 4`);
  });

  it("prefers statsAsync() when the queue exposes it", async () => {
    const collector = new PrometheusMetricsCollector();
    const queue = stubQueue(
      // sync snapshot (in-flight only; would report wrong pending/dead-letter)
      { pending: 0, active: 1, completed: 0, failed: 0, deadLetter: 0 },
      // authoritative DB counts
      { pending: 12, active: 5, completed: 50, failed: 9, deadLetter: 9 }
    );

    await updateQueueGauges(queue, collector);

    const rendered = collector.render();
    expect(rendered).toContain(`${QUEUE_GAUGE_PENDING} 12`);
    expect(rendered).toContain(`${QUEUE_GAUGE_ACTIVE} 5`);
    expect(rendered).toContain(`${QUEUE_GAUGE_DEAD_LETTER} 9`);
  });

  it("registers all three gauge names with gauge-typed help metadata", async () => {
    const collector = new PrometheusMetricsCollector();

    registerQueueGauges(collector);
    // Snapshot an empty queue so each registered gauge renders a value line.
    await updateQueueGauges(
      stubQueue({
        pending: 0,
        active: 0,
        completed: 0,
        failed: 0,
        deadLetter: 0,
      }),
      collector
    );

    const rendered = collector.render();
    for (const name of [
      QUEUE_GAUGE_PENDING,
      QUEUE_GAUGE_ACTIVE,
      QUEUE_GAUGE_DEAD_LETTER,
    ]) {
      expect(rendered).toContain(`# TYPE ${name} gauge`);
      expect(rendered).toContain(`# HELP ${name} `);
      // Empty queue ⇒ every gauge reports zero.
      expect(rendered).toContain(`${name} 0`);
    }
  });
});
