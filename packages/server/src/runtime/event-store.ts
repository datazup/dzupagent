/**
 * Stage 5 — append-only event store for the event-history replay runtime.
 *
 * The {@link EventStore} is the source of truth for activity *results*. Each
 * orchestrator decision is recorded as a sequenced {@link FlowEvent} before it
 * takes effect; on process restart the orchestrator re-runs from the top and a
 * recorded `node_completed` event short-circuits node execution by returning
 * the stored output (replay mode).
 *
 * `sequence` is monotonic per run (1-based). The Drizzle impl appends with
 * `INSERT ... ON CONFLICT DO NOTHING` on `(run_id, sequence)`, so a retried
 * append is idempotent. `loadForRun` returns events ordered by sequence ASC.
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { flowEvents } from "../persistence/drizzle-schema.js";
import type { DrizzleConflictInsertDatabase } from "../persistence/drizzle-store-types.js";

/** Typed orchestrator event categories (spec §5). */
export type EventType =
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "node_scheduled"
  | "node_started"
  | "node_completed"
  | "node_failed"
  | "sleep_scheduled"
  | "signal_received";

/** One row in the append-only flow event log. */
export interface FlowEvent {
  eventId: string;
  runId: string;
  /** Monotonic per run, 1-based. */
  sequence: number;
  eventType: EventType;
  nodeId?: string;
  payload?: Record<string, unknown>;
  tenantId: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

/** Fields a caller supplies on append; identity/sequence/time are assigned. */
export type AppendableFlowEvent = Omit<
  FlowEvent,
  "eventId" | "sequence" | "createdAt"
>;

export interface EventStore {
  /** Append an event, assigning eventId, the next per-run sequence, and createdAt. */
  append(event: AppendableFlowEvent): Promise<FlowEvent>;
  /** Load all events for a run, ordered by sequence ASC. */
  loadForRun(runId: string): Promise<FlowEvent[]>;
  /** Delete all events for a run (run cleanup / compaction). */
  deleteForRun(runId: string): Promise<void>;
}

/**
 * In-memory {@link EventStore} for dev/test. Keeps a per-run array; the next
 * sequence is `events.length + 1` so appends are 1-based and contiguous.
 */
export class InMemoryEventStore implements EventStore {
  private readonly byRun = new Map<string, FlowEvent[]>();

  async append(event: AppendableFlowEvent): Promise<FlowEvent> {
    const list = this.byRun.get(event.runId) ?? [];
    const record: FlowEvent = {
      eventId: randomUUID(),
      runId: event.runId,
      sequence: list.length + 1,
      eventType: event.eventType,
      tenantId: event.tenantId,
      createdAt: Date.now(),
    };
    if (event.nodeId !== undefined) record.nodeId = event.nodeId;
    if (event.payload !== undefined) record.payload = event.payload;
    list.push(record);
    this.byRun.set(event.runId, list);
    return record;
  }

  async loadForRun(runId: string): Promise<FlowEvent[]> {
    // Defensive copy ordered by sequence (already insertion-ordered = ASC).
    return [...(this.byRun.get(runId) ?? [])].sort(
      (a, b) => a.sequence - b.sequence
    );
  }

  async deleteForRun(runId: string): Promise<void> {
    this.byRun.delete(runId);
  }
}

/** Row shape matching {@link flowEvents}. */
interface FlowEventRow {
  eventId: string;
  runId: string;
  sequence: number;
  eventType: string;
  nodeId: string | null;
  payload: Record<string, unknown> | null;
  tenantId: string;
  createdAt: number;
}

function rowToEvent(row: FlowEventRow): FlowEvent {
  const out: FlowEvent = {
    eventId: row.eventId,
    runId: row.runId,
    sequence: Number(row.sequence),
    eventType: row.eventType as EventType,
    tenantId: row.tenantId,
    createdAt: Number(row.createdAt),
  };
  if (row.nodeId !== null && row.nodeId !== undefined) out.nodeId = row.nodeId;
  if (row.payload !== null && row.payload !== undefined)
    out.payload = row.payload;
  return out;
}

/**
 * Drizzle/Postgres-backed {@link EventStore} over `flow_events`.
 *
 * `append` reads the current max sequence for the run, then inserts at
 * `max + 1` with `ON CONFLICT DO NOTHING` on `(run_id, sequence)` so a retried
 * append (e.g. after a crash mid-call) is idempotent rather than a duplicate.
 * `loadForRun` selects ordered by `sequence ASC`.
 */
export class DrizzleEventStore implements EventStore {
  private readonly db: DrizzleConflictInsertDatabase;

  constructor(
    config:
      | { db: DrizzleConflictInsertDatabase }
      | DrizzleConflictInsertDatabase
  ) {
    this.db = "db" in config ? config.db : config;
  }

  async append(event: AppendableFlowEvent): Promise<FlowEvent> {
    const existing = (await this.db
      .select()
      .from(flowEvents)
      .where(eq(flowEvents.runId, event.runId))
      .orderBy(asc(flowEvents.sequence))) as FlowEventRow[];

    const sequence =
      existing.length === 0
        ? 1
        : Number(existing[existing.length - 1]!.sequence) + 1;

    const record: FlowEvent = {
      eventId: randomUUID(),
      runId: event.runId,
      sequence,
      eventType: event.eventType,
      tenantId: event.tenantId,
      createdAt: Date.now(),
    };
    if (event.nodeId !== undefined) record.nodeId = event.nodeId;
    if (event.payload !== undefined) record.payload = event.payload;

    await this.db
      .insert(flowEvents)
      .values({
        eventId: record.eventId,
        runId: record.runId,
        sequence: record.sequence,
        eventType: record.eventType,
        nodeId: record.nodeId ?? null,
        payload: record.payload ?? null,
        tenantId: record.tenantId,
        createdAt: record.createdAt,
      })
      .onConflictDoNothing();

    return record;
  }

  async loadForRun(runId: string): Promise<FlowEvent[]> {
    const rows = (await this.db
      .select()
      .from(flowEvents)
      .where(eq(flowEvents.runId, runId))
      .orderBy(asc(flowEvents.sequence))) as FlowEventRow[];
    return rows.map(rowToEvent);
  }

  async deleteForRun(runId: string): Promise<void> {
    await this.db.delete(flowEvents).where(eq(flowEvents.runId, runId));
  }
}
