/**
 * P1 — fleet gauge metrics.
 *
 * Reads a snapshot of the worker fleet from a {@link WorkerNodeStore} and
 * publishes four Prometheus gauges describing fleet capacity and health:
 *
 *   - `forge_fleet_workers_total`  — all registered nodes
 *   - `forge_fleet_workers_active` — nodes with status `active`
 *   - `forge_fleet_workers_idle`   — active nodes with zero in-flight runs
 *   - `forge_fleet_workers_dead`   — nodes reaped for a stale heartbeat
 *
 * The collector pulls (rather than the worker pushing) so values are fresh on
 * each Prometheus scrape: call {@link updateFleetGauges} from the `/metrics`
 * route handler just before `render()`.
 */
import type { WorkerNodeStore } from "../runtime/worker-registry.js";
import type { PrometheusMetricsCollector } from "./prometheus-collector.js";

/** Gauge metric names exposed for the worker fleet. */
export const FLEET_GAUGE_TOTAL = "forge_fleet_workers_total";
export const FLEET_GAUGE_ACTIVE = "forge_fleet_workers_active";
export const FLEET_GAUGE_IDLE = "forge_fleet_workers_idle";
export const FLEET_GAUGE_DEAD = "forge_fleet_workers_dead";

/**
 * Register help text + type for the four fleet gauges. Idempotent; safe to call
 * at bootstrap so the metrics render with documentation even before the first
 * snapshot is taken.
 */
export function registerFleetGauges(
  collector: PrometheusMetricsCollector
): void {
  collector.register(
    FLEET_GAUGE_TOTAL,
    "gauge",
    "Total registered worker nodes in the fleet"
  );
  collector.register(
    FLEET_GAUGE_ACTIVE,
    "gauge",
    "Worker nodes with status=active"
  );
  collector.register(
    FLEET_GAUGE_IDLE,
    "gauge",
    "Active worker nodes with zero in-flight runs"
  );
  collector.register(
    FLEET_GAUGE_DEAD,
    "gauge",
    "Worker nodes reaped for a stale heartbeat (status=dead)"
  );
}

/**
 * Pull a fleet snapshot from `store` and set the four gauges on `collector`.
 *
 * `total` counts every node; `active`/`dead` count by status; `idle` is the
 * subset of active nodes whose `inFlight` is zero (spare capacity).
 */
export async function updateFleetGauges(
  store: WorkerNodeStore,
  collector: PrometheusMetricsCollector
): Promise<void> {
  const nodes = await store.list();

  let active = 0;
  let idle = 0;
  let dead = 0;
  for (const node of nodes) {
    if (node.status === "dead") {
      dead += 1;
    } else if (node.status === "active") {
      active += 1;
      if (node.inFlight === 0) idle += 1;
    }
  }

  collector.gauge(FLEET_GAUGE_TOTAL, nodes.length);
  collector.gauge(FLEET_GAUGE_ACTIVE, active);
  collector.gauge(FLEET_GAUGE_IDLE, idle);
  collector.gauge(FLEET_GAUGE_DEAD, dead);
}
