/**
 * Drizzle/Postgres-backed {@link WorkerNodeStore} (P1 — worker fleet registry).
 *
 * Mirrors {@link InMemoryWorkerNodeStore} semantics over a shared `worker_nodes`
 * table so multiple worker processes register into one queryable fleet. Time is
 * injected (`now` arg) so reaping stays deterministic under test, matching the
 * interface contract.
 *
 * `register` upserts (ON CONFLICT DO UPDATE) so a worker restart resumes onto
 * its stable per-process id rather than orphaning the prior row. All other
 * operations are single-row/single-statement; no transactions required.
 *
 * See workspace-docs/repos/dzupagent/docs/architecture/plans/P1-worker-fleet-registry.md
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { workerNodes } from "../persistence/drizzle-schema.js";
import type { DrizzleWorkerNodeDatabase } from "../persistence/drizzle-store-types.js";
import type { WorkerNode, WorkerNodeStore } from "./worker-registry.js";

/** Row shape matching {@link workerNodes}. */
interface WorkerNodeRow {
  id: string;
  tenantScope: string;
  status: WorkerNode["status"];
  capacity: number;
  inFlight: number;
  startedAt: number;
  lastHeartbeatAt: number;
  meta: Record<string, unknown> | null;
}

function rowToNode(row: WorkerNodeRow): WorkerNode {
  const node: WorkerNode = {
    id: row.id,
    tenantScope: row.tenantScope,
    status: row.status,
    capacity: row.capacity,
    inFlight: row.inFlight,
    startedAt: row.startedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
  };
  if (row.meta !== null && row.meta !== undefined) node.meta = row.meta;
  return node;
}

/**
 * Drizzle-backed worker fleet registry. Construct with a Drizzle client whose
 * `insert`/`update` builders support `.returning()` and `.onConflictDoUpdate()`
 * (see {@link DrizzleWorkerNodeDatabase}).
 */
export class DrizzleWorkerNodeStore implements WorkerNodeStore {
  constructor(private readonly db: DrizzleWorkerNodeDatabase) {}

  /**
   * Register (or re-register) a node. Inserts the row marked `active`; on a
   * conflicting `id` (worker restart) updates the mutable fields in place and
   * resets status to `active`.
   */
  async register(
    node: Omit<WorkerNode, "lastHeartbeatAt" | "status">,
    now: number
  ): Promise<WorkerNode> {
    const values = {
      id: node.id,
      tenantScope: node.tenantScope,
      status: "active" as const,
      capacity: node.capacity,
      inFlight: node.inFlight,
      startedAt: node.startedAt,
      lastHeartbeatAt: now,
      meta: node.meta ?? null,
    };
    const rows = (await this.db
      .insert(workerNodes)
      .values(values)
      .onConflictDoUpdate({
        target: workerNodes.id,
        set: {
          tenantScope: values.tenantScope,
          status: "active",
          capacity: values.capacity,
          inFlight: values.inFlight,
          startedAt: values.startedAt,
          lastHeartbeatAt: now,
          meta: values.meta,
        },
      })
      .returning()) as WorkerNodeRow[];
    const row = rows[0];
    // Defensive: a driver that does not echo the row still yields a faithful
    // record from the values we just wrote.
    return row ? rowToNode(row) : rowToNode(values as WorkerNodeRow);
  }

  /**
   * Record a heartbeat: update in-flight count and last-heartbeat timestamp. A
   * heartbeat from a node previously marked `dead` resurrects it to `active`.
   */
  async heartbeat(id: string, inFlight: number, now: number): Promise<void> {
    await this.db
      .update(workerNodes)
      .set({
        inFlight,
        lastHeartbeatAt: now,
        // CASE: resurrect dead nodes, otherwise preserve current status.
        status: sql`CASE WHEN ${workerNodes.status} = 'dead' THEN 'active' ELSE ${workerNodes.status} END`,
      })
      .where(eq(workerNodes.id, id));
  }

  /** Set a node's status explicitly. */
  async setStatus(id: string, status: WorkerNode["status"]): Promise<void> {
    await this.db
      .update(workerNodes)
      .set({ status })
      .where(eq(workerNodes.id, id));
  }

  /** List nodes, optionally filtered by status. */
  async list(filter?: {
    status?: WorkerNode["status"];
  }): Promise<WorkerNode[]> {
    const query = this.db.select().from(workerNodes);
    const rows = (await (filter?.status !== undefined
      ? query.where(eq(workerNodes.status, filter.status))
      : query)) as WorkerNodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Mark every non-dead node whose heartbeat is older than `ttlMs` as `dead`
   * and return their ids.
   */
  async reapExpired(now: number, ttlMs: number): Promise<string[]> {
    const rows = (await this.db
      .update(workerNodes)
      .set({ status: "dead" })
      .where(
        and(
          ne(workerNodes.status, "dead"),
          sql`${now} - ${workerNodes.lastHeartbeatAt} > ${ttlMs}`
        )
      )
      .returning()) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Remove a node from the fleet. */
  async deregister(id: string): Promise<void> {
    await this.db.delete(workerNodes).where(eq(workerNodes.id, id));
  }
}
