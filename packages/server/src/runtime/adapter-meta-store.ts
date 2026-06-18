/**
 * OQ-3 — adapter-owned resume metadata store.
 *
 * The generic {@link DurableNodeLedger}/`forge_node_ledger` stays
 * provider-agnostic. Adapters that support resume (Claude session ids, Codex
 * thread refs, ...) persist their owned fields through this side store, keyed
 * by `(runId, nodeId, adapterId)`. Backed by the `flow_node_adapter_meta` table
 * for the Drizzle impl and a plain Map for the in-memory impl.
 *
 * No tenant scoping: `runId` already scopes to a tenant via
 * `forge_runs.tenant_id`.
 */
import { and, eq } from "drizzle-orm";
import { flowNodeAdapterMeta } from "../persistence/drizzle-schema.js";
import type { DrizzleStoreDatabase } from "../persistence/drizzle-store-types.js";

/** Provider-specific resume metadata for one durable node execution. */
export interface AdapterMeta {
  runId: string;
  nodeId: string;
  adapterId: string;
  sessionRef?: string;
  resumeToken?: string;
  meta?: Record<string, unknown>;
}

export interface AdapterMetaStore {
  /** Upsert adapter metadata for a (runId, nodeId, adapterId) triple. */
  upsert(entry: AdapterMeta): Promise<void>;
  /** Read adapter metadata, or null if not found. */
  get(
    runId: string,
    nodeId: string,
    adapterId: string
  ): Promise<AdapterMeta | null>;
  /** Delete all metadata for a run (called on run cleanup). */
  deleteForRun(runId: string): Promise<void>;
}

/** Composite key for the in-memory map. */
function keyOf(runId: string, nodeId: string, adapterId: string): string {
  return `${runId}:${nodeId}:${adapterId}`;
}

/** Drop undefined optional fields so round-trips compare cleanly. */
function normalize(entry: AdapterMeta): AdapterMeta {
  const out: AdapterMeta = {
    runId: entry.runId,
    nodeId: entry.nodeId,
    adapterId: entry.adapterId,
  };
  if (entry.sessionRef !== undefined) out.sessionRef = entry.sessionRef;
  if (entry.resumeToken !== undefined) out.resumeToken = entry.resumeToken;
  if (entry.meta !== undefined) out.meta = entry.meta;
  return out;
}

/**
 * In-memory {@link AdapterMetaStore} for dev/test. Keyed by
 * `${runId}:${nodeId}:${adapterId}`.
 */
export class InMemoryAdapterMetaStore implements AdapterMetaStore {
  private readonly entries = new Map<string, AdapterMeta>();

  async upsert(entry: AdapterMeta): Promise<void> {
    this.entries.set(
      keyOf(entry.runId, entry.nodeId, entry.adapterId),
      normalize(entry)
    );
  }

  async get(
    runId: string,
    nodeId: string,
    adapterId: string
  ): Promise<AdapterMeta | null> {
    return this.entries.get(keyOf(runId, nodeId, adapterId)) ?? null;
  }

  async deleteForRun(runId: string): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.runId === runId) this.entries.delete(key);
    }
  }
}

/** Row shape matching {@link flowNodeAdapterMeta}. */
interface AdapterMetaRow {
  runId: string;
  nodeId: string;
  adapterId: string;
  sessionRef: string | null;
  resumeToken: string | null;
  meta: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

function rowToMeta(row: AdapterMetaRow): AdapterMeta {
  const out: AdapterMeta = {
    runId: row.runId,
    nodeId: row.nodeId,
    adapterId: row.adapterId,
  };
  if (row.sessionRef !== null && row.sessionRef !== undefined)
    out.sessionRef = row.sessionRef;
  if (row.resumeToken !== null && row.resumeToken !== undefined)
    out.resumeToken = row.resumeToken;
  if (row.meta !== null && row.meta !== undefined) out.meta = row.meta;
  return out;
}

/**
 * Drizzle/Postgres-backed {@link AdapterMetaStore} over `flow_node_adapter_meta`.
 * `upsert` uses INSERT ... ON CONFLICT DO UPDATE on the composite primary key;
 * `get` is a single keyed SELECT; `deleteForRun` is a single DELETE WHERE
 * run_id. Time is read from `Date.now()` — these timestamps are observability
 * metadata, not part of any leasing/fencing contract.
 */
export class DrizzleAdapterMetaStore implements AdapterMetaStore {
  constructor(private readonly db: DrizzleStoreDatabase) {}

  async upsert(entry: AdapterMeta): Promise<void> {
    const now = Date.now();
    const values = {
      runId: entry.runId,
      nodeId: entry.nodeId,
      adapterId: entry.adapterId,
      sessionRef: entry.sessionRef ?? null,
      resumeToken: entry.resumeToken ?? null,
      meta: entry.meta ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await (
      this.db.insert(flowNodeAdapterMeta).values(values) as unknown as {
        onConflictDoUpdate(config: {
          target: unknown;
          set: unknown;
        }): PromiseLike<unknown>;
      }
    ).onConflictDoUpdate({
      target: [
        flowNodeAdapterMeta.runId,
        flowNodeAdapterMeta.nodeId,
        flowNodeAdapterMeta.adapterId,
      ],
      set: {
        sessionRef: values.sessionRef,
        resumeToken: values.resumeToken,
        meta: values.meta,
        updatedAt: now,
      },
    });
  }

  async get(
    runId: string,
    nodeId: string,
    adapterId: string
  ): Promise<AdapterMeta | null> {
    const rows = (await this.db
      .select()
      .from(flowNodeAdapterMeta)
      .where(
        and(
          eq(flowNodeAdapterMeta.runId, runId),
          eq(flowNodeAdapterMeta.nodeId, nodeId),
          eq(flowNodeAdapterMeta.adapterId, adapterId)
        )
      )) as AdapterMetaRow[];
    const row = rows[0];
    return row ? rowToMeta(row) : null;
  }

  async deleteForRun(runId: string): Promise<void> {
    await this.db
      .delete(flowNodeAdapterMeta)
      .where(eq(flowNodeAdapterMeta.runId, runId));
  }
}
