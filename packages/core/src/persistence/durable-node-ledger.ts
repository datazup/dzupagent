/**
 * P2 — Durable Node Ledger (ledger + leasing + fencing slice).
 *
 * The canonical per-node lease + idempotency store for crash-safe, distributed
 * execution. Guarantees **effectively-once outcomes**: a node executes its side
 * effect at most once visibly, a dead worker's node is safely re-leased, and a
 * zombie worker's stale write is rejected by a monotonic fencing token.
 *
 * This module ships the interface + in-memory implementation + node lifecycle
 * statuses. Runtime integration (PipelineRuntime per-node acquire/heartbeat/
 * complete + replay-skip) and the Postgres implementation are follow-ups; this
 * is the seam they build on.
 *
 * See workspace-docs/repos/dzupagent/docs/architecture/plans/P2-run-leasing-and-fencing.md
 * (crash-safe spec §6.1 node lifecycle, §6.2 replay rules, §11 flow_node_ledger,
 * §14 failure matrix).
 */

/** Replay governance, shared with `@dzupagent/flow-ast` `NodeIdempotencyMode`. */
export type LedgerIdempotencyMode =
  | "idempotent"
  | "at-least-once"
  | "exactly-once-required";

/** Durable node status (crash-safe spec §6.1). */
export type DurableNodeStatus =
  | "leased"
  | "running"
  | "completed"
  | "failed_retryable"
  | "failed_terminal"
  | "cancelled";

/** A held lease handle returned by {@link DurableNodeLedger.acquire}. */
export interface DurableNodeLease {
  runId: string;
  nodeId: string;
  idempotencyKey: string;
  owner: string;
  /** Monotonic fence token — bumped on every (re)acquire. The load-bearing
   * safety mechanism: a write carrying a fence < current is rejected. */
  fenceToken: number;
  attempt: number;
  status: DurableNodeStatus;
  leaseExpiresAt: number;
  startedAt: number;
}

/** A completed node record (the durable, replayable result). */
export interface DurableNodeCompletion {
  runId: string;
  nodeId: string;
  idempotencyKey: string;
  fenceToken: number;
  /** Opaque reference to the validated output (e.g. a flow_artifacts row id). */
  outputRef?: string;
  output?: unknown;
  durationMs?: number;
}

/** A node failure record. */
export interface DurableNodeFailure {
  runId: string;
  nodeId: string;
  idempotencyKey: string;
  fenceToken: number;
  error: string;
  /** `true` ⇒ the node returns to `failed_retryable` (re-leasable); `false` ⇒
   * `failed_terminal`. */
  retryable: boolean;
}

/**
 * Canonical lease + idempotency store. All time-sensitive methods take an
 * explicit `now` (ms-epoch) so leasing/fencing/reclaim are deterministic under
 * test and clock-source-agnostic in production (DB-authoritative `now()` for
 * the Postgres impl).
 */
export interface DurableNodeLedger {
  /**
   * Acquire a lease for `(runId, nodeId)`, keyed by `idempotencyKey`. Bumps the
   * fence on (re)acquire. Returns `null` when the node is already `completed`
   * (caller should replay via {@link getByIdempotencyKey}) or actively held by
   * a fresh lease.
   */
  acquire(
    runId: string,
    nodeId: string,
    idempotencyKey: string,
    owner: string,
    ttlMs: number,
    now: number,
  ): Promise<DurableNodeLease | null>;

  /**
   * Renew the lease for `(runId, nodeId)`. Returns `false` when the caller has
   * been fenced out (a newer lease exists) — the runtime must abort that node.
   */
  heartbeat(
    runId: string,
    nodeId: string,
    owner: string,
    fenceToken: number,
    ttlMs: number,
    now: number,
  ): Promise<boolean>;

  /** Fence-gated completion write. Throws {@link FencedOutError} when stale. */
  complete(record: DurableNodeCompletion): Promise<void>;

  /** Fence-gated failure write. Throws {@link FencedOutError} when stale. */
  fail(record: DurableNodeFailure): Promise<void>;

  /** Lease/running nodes whose lease has expired — candidates for reclaim. */
  findStale(now: number, limit: number): Promise<DurableNodeLease[]>;

  /** Replay lookup — returns the completion when a node already finished. */
  getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<DurableNodeCompletion | undefined>;
}

/** Thrown by `complete`/`fail` when the caller's fence token is stale (a newer
 * lease has superseded it). The runtime treats this as a split-brain signal. */
export class FencedOutError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly presentedFence: number,
    readonly currentFence: number,
  ) {
    super(
      `Fenced out for "${idempotencyKey}": presented fence ${presentedFence} < current ${currentFence}`,
    );
    this.name = "FencedOutError";
  }
}

interface LedgerRow {
  lease: DurableNodeLease;
  completion?: DurableNodeCompletion;
}

/**
 * In-memory durable node ledger for dev/test and single-process deployments.
 * The reference semantics for the Postgres implementation.
 */
export class InMemoryDurableNodeLedger implements DurableNodeLedger {
  /** Keyed by idempotencyKey (unique per the spec's `flow_node_ledger`). */
  private readonly rows = new Map<string, LedgerRow>();

  async acquire(
    runId: string,
    nodeId: string,
    idempotencyKey: string,
    owner: string,
    ttlMs: number,
    now: number,
  ): Promise<DurableNodeLease | null> {
    const existing = this.rows.get(idempotencyKey);

    if (existing === undefined) {
      const lease: DurableNodeLease = {
        runId,
        nodeId,
        idempotencyKey,
        owner,
        fenceToken: 1,
        attempt: 1,
        status: "leased",
        leaseExpiresAt: now + ttlMs,
        startedAt: now,
      };
      this.rows.set(idempotencyKey, { lease });
      return lease;
    }

    const { lease } = existing;
    // Completed → no lease; caller replays the prior result.
    if (lease.status === "completed" || lease.status === "failed_terminal") {
      return null;
    }
    // Held & fresh → someone else owns it.
    const expired = lease.leaseExpiresAt <= now;
    if ((lease.status === "leased" || lease.status === "running") && !expired) {
      return null;
    }
    // Re-leasable: expired lease/running, or failed_retryable. Bump the fence.
    const released: DurableNodeLease = {
      ...lease,
      owner,
      fenceToken: lease.fenceToken + 1,
      attempt: lease.attempt + 1,
      status: "leased",
      leaseExpiresAt: now + ttlMs,
      startedAt: now,
    };
    existing.lease = released;
    return released;
  }

  async heartbeat(
    runId: string,
    nodeId: string,
    owner: string,
    fenceToken: number,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    // The map is keyed by idempotencyKey; resolve the live lease for this
    // (runId, nodeId) by scan. There is one live row per node.
    const match = this.findRow(runId, nodeId);
    if (match === undefined) return false;
    const { lease } = match;
    // Fenced out: a newer lease exists, or a different owner holds it.
    if (lease.fenceToken !== fenceToken || lease.owner !== owner) return false;
    lease.status = lease.status === "leased" ? "running" : lease.status;
    lease.leaseExpiresAt = now + ttlMs;
    return true;
  }

  async complete(record: DurableNodeCompletion): Promise<void> {
    const row = this.rows.get(record.idempotencyKey);
    if (row === undefined) {
      throw new FencedOutError(record.idempotencyKey, record.fenceToken, -1);
    }
    if (record.fenceToken < row.lease.fenceToken) {
      throw new FencedOutError(
        record.idempotencyKey,
        record.fenceToken,
        row.lease.fenceToken,
      );
    }
    row.lease.status = "completed";
    row.completion = record;
  }

  async fail(record: DurableNodeFailure): Promise<void> {
    const row = this.rows.get(record.idempotencyKey);
    if (row === undefined) {
      throw new FencedOutError(record.idempotencyKey, record.fenceToken, -1);
    }
    if (record.fenceToken < row.lease.fenceToken) {
      throw new FencedOutError(
        record.idempotencyKey,
        record.fenceToken,
        row.lease.fenceToken,
      );
    }
    row.lease.status = record.retryable
      ? "failed_retryable"
      : "failed_terminal";
  }

  async findStale(now: number, limit: number): Promise<DurableNodeLease[]> {
    const stale: DurableNodeLease[] = [];
    for (const { lease } of this.rows.values()) {
      if (
        (lease.status === "leased" || lease.status === "running") &&
        lease.leaseExpiresAt <= now
      ) {
        stale.push(lease);
        if (stale.length >= limit) break;
      }
    }
    return stale;
  }

  async getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<DurableNodeCompletion | undefined> {
    const row = this.rows.get(idempotencyKey);
    if (row?.lease.status === "completed") return row.completion;
    return undefined;
  }

  private findRow(runId: string, nodeId: string): LedgerRow | undefined {
    for (const row of this.rows.values()) {
      if (row.lease.runId === runId && row.lease.nodeId === nodeId) return row;
    }
    return undefined;
  }
}
