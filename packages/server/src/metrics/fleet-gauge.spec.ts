/**
 * Unit tests for {@link updateFleetGauges}.
 *
 * Uses the real {@link InMemoryWorkerNodeStore} and
 * {@link PrometheusMetricsCollector} so the test exercises the actual snapshot
 * → gauge translation and the rendered Prometheus exposition.
 */
import { describe, it, expect } from "vitest";
import { PrometheusMetricsCollector } from "./prometheus-collector.js";
import {
  updateFleetGauges,
  registerFleetGauges,
  FLEET_GAUGE_TOTAL,
  FLEET_GAUGE_ACTIVE,
  FLEET_GAUGE_IDLE,
  FLEET_GAUGE_DEAD,
} from "./fleet-gauge.js";
import { InMemoryWorkerNodeStore } from "../runtime/worker-registry.js";

describe("updateFleetGauges", () => {
  it("gauge values match the store snapshot", async () => {
    const store = new InMemoryWorkerNodeStore();
    const now = 1_000_000;
    // active + idle (inFlight 0), fresh heartbeat so it survives reaping
    await store.register(
      {
        id: "idle",
        tenantScope: "shared",
        capacity: 5,
        inFlight: 0,
        startedAt: 0,
      },
      now
    );
    // active + busy (inFlight > 0), fresh heartbeat
    await store.register(
      {
        id: "busy",
        tenantScope: "shared",
        capacity: 5,
        inFlight: 0,
        startedAt: 0,
      },
      now
    );
    await store.heartbeat("busy", 2, now);
    // stale node — registered long ago, never heartbeats, so it reaps to dead
    await store.register(
      {
        id: "stale",
        tenantScope: "shared",
        capacity: 5,
        inFlight: 0,
        startedAt: 0,
      },
      0
    );
    // ttl 1ms: only `stale` (heartbeat at 0) exceeds it; live nodes survive.
    await store.reapExpired(now + 1, 1);

    const collector = new PrometheusMetricsCollector();
    await updateFleetGauges(store, collector);

    const rendered = collector.render();
    expect(rendered).toContain(`${FLEET_GAUGE_TOTAL} 3`);
    expect(rendered).toContain(`${FLEET_GAUGE_ACTIVE} 2`);
    expect(rendered).toContain(`${FLEET_GAUGE_IDLE} 1`);
    expect(rendered).toContain(`${FLEET_GAUGE_DEAD} 1`);
  });

  it("registers the four gauges with gauge-typed help labels", async () => {
    const store = new InMemoryWorkerNodeStore();
    const collector = new PrometheusMetricsCollector();
    registerFleetGauges(collector);
    await updateFleetGauges(store, collector);

    const rendered = collector.render();
    for (const name of [
      FLEET_GAUGE_TOTAL,
      FLEET_GAUGE_ACTIVE,
      FLEET_GAUGE_IDLE,
      FLEET_GAUGE_DEAD,
    ]) {
      expect(rendered).toContain(`# TYPE ${name} gauge`);
      expect(rendered).toContain(`# HELP ${name} `);
      // Empty fleet ⇒ every gauge reports zero.
      expect(rendered).toContain(`${name} 0`);
    }
  });
});
