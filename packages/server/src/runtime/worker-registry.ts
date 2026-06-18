/**
 * P1 — Worker Fleet Registry.
 *
 * Gives every run worker a stable identity, a heartbeat, and a place in a
 * queryable fleet so the platform can observe capacity and detect dead nodes.
 * This is the foundation for P2 (the `WorkerNode.id` is the durable node
 * ledger's lease owner) and P4 (node identity = claim-tick `claimerId`).
 *
 * Interface + in-memory implementation live here (server-scoped). A Drizzle/
 * Postgres implementation is a follow-up; the interface is the seam.
 *
 * See workspace-docs/repos/dzupagent/docs/architecture/plans/P1-worker-fleet-registry.md
 */

/** A registered worker node in the fleet. */
export interface WorkerNode {
  /** Stable per-process id (generated at startup). */
  id: string;
  /** `'shared'` or a dedicated tenant id. */
  tenantScope: string;
  status: "starting" | "active" | "draining" | "dead";
  /** Max concurrent runs this node accepts. */
  capacity: number;
  /** Current active runs. */
  inFlight: number;
  /** ms-epoch of the last heartbeat. */
  lastHeartbeatAt: number;
  /** ms-epoch when the node registered. */
  startedAt: number;
  /** Free-form node metadata (version, host, region). */
  meta?: Record<string, unknown>;
  /** Provider IDs this worker can serve (e.g. ['claude', 'openai']). Empty/undefined = all providers. */
  providers?: string[];
}

export interface WorkerNodeStore {
  register(
    node: Omit<WorkerNode, "lastHeartbeatAt" | "status">,
    now: number
  ): Promise<WorkerNode>;
  heartbeat(id: string, inFlight: number, now: number): Promise<void>;
  setStatus(id: string, status: WorkerNode["status"]): Promise<void>;
  list(filter?: { status?: WorkerNode["status"] }): Promise<WorkerNode[]>;
  /** Mark nodes whose heartbeat is older than `ttlMs` as dead and return their ids. */
  reapExpired(now: number, ttlMs: number): Promise<string[]>;
  deregister(id: string): Promise<void>;
}

/**
 * In-memory worker registry for single-process deployments, dev, and tests.
 * Time is injected (`now` arg) so reaping is deterministic under test.
 */
export class InMemoryWorkerNodeStore implements WorkerNodeStore {
  private readonly nodes = new Map<string, WorkerNode>();

  async register(
    node: Omit<WorkerNode, "lastHeartbeatAt" | "status">,
    now: number
  ): Promise<WorkerNode> {
    const record: WorkerNode = {
      ...node,
      status: "active",
      lastHeartbeatAt: now,
    };
    this.nodes.set(node.id, record);
    return record;
  }

  async heartbeat(id: string, inFlight: number, now: number): Promise<void> {
    const node = this.nodes.get(id);
    if (node === undefined) return;
    node.inFlight = inFlight;
    node.lastHeartbeatAt = now;
    // A heartbeat from a node previously marked dead resurrects it.
    if (node.status === "dead") node.status = "active";
  }

  async setStatus(id: string, status: WorkerNode["status"]): Promise<void> {
    const node = this.nodes.get(id);
    if (node !== undefined) node.status = status;
  }

  async list(filter?: {
    status?: WorkerNode["status"];
  }): Promise<WorkerNode[]> {
    const all = [...this.nodes.values()];
    if (filter?.status === undefined) return all;
    return all.filter((n) => n.status === filter.status);
  }

  async reapExpired(now: number, ttlMs: number): Promise<string[]> {
    const reaped: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.status !== "dead" && now - node.lastHeartbeatAt > ttlMs) {
        node.status = "dead";
        reaped.push(node.id);
      }
    }
    return reaped;
  }

  async deregister(id: string): Promise<void> {
    this.nodes.delete(id);
  }
}
