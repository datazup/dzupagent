/**
 * Drizzle ORM schema — durable flow-runtime tables: node ledger, adapter meta,
 * worker fleet, content-addressed artifacts, event log, and approvals.
 */
import {
  pgTable,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Durable Node Ledger (P2 — crash-safe per-node leasing + fencing)
// ---------------------------------------------------------------------------

export const forgeNodeLedger = pgTable(
  "forge_node_ledger",
  {
    /** Unique per node attempt-chain — the spec's idempotency key. */
    idempotencyKey: text("idempotency_key").primaryKey(),
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    /** S4: now NOT NULL. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
    attempt: integer("attempt").notNull().default(1),
    /** Monotonic fence token — bumped on every (re)acquire. */
    fenceToken: integer("fence_token").notNull().default(1),
    owner: text("owner").notNull(),
    status: text("status").notNull(),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }).notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }),
    outputRef: text("output_ref"),
    output: jsonb("output").$type<unknown>(),
    durationMs: integer("duration_ms"),
    error: text("error"),
  },
  (table) => [
    index("forge_node_ledger_run_id_idx").on(table.runId),
    index("forge_node_ledger_status_lease_idx").on(
      table.status,
      table.leaseExpiresAt
    ),
  ]
);

// ---------------------------------------------------------------------------
// Node Adapter Meta (OQ-3 — provider-specific resume tokens, side table)
// ---------------------------------------------------------------------------

/**
 * Adapter-owned execution metadata, kept out of the framework-clean
 * {@link forgeNodeLedger}. Holds provider-specific resume state (Claude session
 * ids, Codex thread refs, etc.) keyed by `(run_id, node_id, adapter_id)`.
 *
 * Framework-internal side table shared between adapter and ledger.
 * Deliberately NO `tenant_id`: `run_id` already scopes to a tenant via
 * `forge_runs.tenant_id`, so a redundant column would only invite drift.
 * Timestamps are epoch milliseconds (bigint), matching the ledger.
 */
export const flowNodeAdapterMeta = pgTable(
  "flow_node_adapter_meta",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    adapterId: text("adapter_id").notNull(),
    sessionRef: text("session_ref"),
    resumeToken: text("resume_token"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.nodeId, table.adapterId] }),
    index("idx_node_adapter_meta_run").on(table.runId),
  ]
);

// ---------------------------------------------------------------------------
// Worker Fleet Registry (P1 — stable node identity + heartbeat + fleet view)
// ---------------------------------------------------------------------------

/**
 * Registered worker nodes in the fleet (spec P1). Each run worker registers a
 * stable per-process id, heartbeats its in-flight count, and is reaped when its
 * heartbeat goes stale. Timestamps are epoch milliseconds (bigint) so reaping
 * is deterministic under the injected-clock contract of {@link WorkerNodeStore}.
 *
 * `id` is caller-supplied (a stable per-process id, not a UUID sequence), so a
 * worker restart upserts onto the same row. No foreign keys — the fleet view is
 * standalone observability state.
 */
export const workerNodes = pgTable(
  "worker_nodes",
  {
    id: text("id").primaryKey(),
    tenantScope: text("tenant_scope").notNull().default("shared"),
    status: text("status").notNull().default("starting"),
    capacity: integer("capacity").notNull().default(1),
    inFlight: integer("in_flight").notNull().default(0),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    lastHeartbeatAt: bigint("last_heartbeat_at", { mode: "number" }).notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    /** S4-H: Provider IDs this worker serves (null/absent = all providers). */
    providers: jsonb("providers").$type<string[]>(),
    /** S4: Tenant scope. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
  },
  (table) => [
    index("worker_nodes_status_idx").on(table.status),
    index("worker_nodes_tenant_scope_idx").on(table.tenantScope),
    index("worker_nodes_tenant_id_idx").on(table.tenantId),
  ]
);

// ---------------------------------------------------------------------------
// Flow Artifacts
// ---------------------------------------------------------------------------

/**
 * Content-addressed artifact store for durable node outputs (spec §11).
 * Large outputs reference external storage via storage_uri; small outputs
 * are stored inline in content (content_type + schema_ref for validation).
 */
export const flowArtifacts = pgTable(
  "flow_artifacts",
  {
    artifactRef: text("artifact_ref").primaryKey(),
    tenantId: text("tenant_id").notNull().default("default"),
    contentDigest: text("content_digest").notNull(),
    contentType: text("content_type").notNull(),
    content: jsonb("content").$type<unknown>(),
    storageUri: text("storage_uri"),
    schemaRef: text("schema_ref"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("flow_artifacts_tenant_id_idx").on(table.tenantId),
    index("flow_artifacts_content_digest_idx").on(table.contentDigest),
  ]
);

// ---------------------------------------------------------------------------
// Flow Events (Stage 5 — append-only event log for event-history replay)
// ---------------------------------------------------------------------------

/**
 * Append-only event log backing the event-history replay runtime (Stage 5).
 * Each orchestrator decision is recorded as a discrete, typed, sequenced event
 * before it takes effect. On process restart the orchestrator re-runs from the
 * top in replay mode: a recorded `node_completed` event short-circuits node
 * execution by returning the stored output.
 *
 * `sequence` is monotonic per run (1-based). `UNIQUE (run_id, sequence)` gives
 * idempotent appends and a stable replay order. Timestamps are epoch
 * milliseconds (bigint) for parity with the other crash-safe tables.
 */
export const flowEvents = pgTable(
  "flow_events",
  {
    eventId: text("event_id").primaryKey(),
    runId: text("run_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    nodeId: text("node_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** Stage 5: Tenant scope. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("flow_events_run_seq_unique").on(table.runId, table.sequence),
    index("idx_flow_events_run_seq").on(table.runId, table.sequence),
    index("idx_flow_events_tenant_id").on(table.tenantId),
  ]
);

// ---------------------------------------------------------------------------
// Flow Approvals
// ---------------------------------------------------------------------------

/**
 * Durable approval / clarification records (spec §11 + §6.6).
 * Idempotent by (run_id, approval_id). Status: pending → approved | rejected.
 */
export const flowApprovals = pgTable(
  "flow_approvals",
  {
    tenantId: text("tenant_id").notNull().default("default"),
    runId: text("run_id").notNull(),
    approvalId: text("approval_id").notNull(),
    status: text("status").notNull().default("pending"),
    requestPayload: jsonb("request_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    responsePayload: jsonb("response_payload").$type<Record<string, unknown>>(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.approvalId] }),
    index("flow_approvals_tenant_id_idx").on(table.tenantId),
    index("flow_approvals_run_id_idx").on(table.runId),
  ]
);
