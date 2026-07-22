/**
 * Drizzle ORM schema — observability & compliance tables: run reflections,
 * traces, the hash-chained audit log, and deployment history.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  real,
  boolean,
  bigint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ReflectionPattern } from "@dzupagent/agent/reflection";

// ---------------------------------------------------------------------------
// Deployment History
// ---------------------------------------------------------------------------

export const deploymentHistory = pgTable(
  "deployment_history",
  {
    id: text("id").primaryKey(),
    confidenceScore: real("confidence_score").notNull(),
    gateDecision: text("gate_decision").notNull(),
    signalsSnapshot:
      jsonb("signals_snapshot").$type<Record<string, unknown>[]>(),
    deployedAt: timestamp("deployed_at").defaultNow().notNull(),
    deployedBy: text("deployed_by"),
    environment: text("environment").notNull(),
    rollbackAvailable: boolean("rollback_available").default(false).notNull(),
    outcome: text("outcome"),
    completedAt: timestamp("completed_at"),
    notes: text("notes"),
    /** SEC-M-06: Tenant that owns this deployment record. S4: now NOT NULL. */
    tenantId: text("tenant_id").notNull().default("default"),
  },
  (table) => [
    index("deployment_history_environment_idx").on(table.environment),
    index("deployment_history_deployed_at_idx").on(table.deployedAt),
    index("deployment_history_tenant_id_idx").on(table.tenantId),
  ]
);

// ---------------------------------------------------------------------------
// Run Reflections
// ---------------------------------------------------------------------------

export const runReflections = pgTable(
  "run_reflections",
  {
    runId: varchar("run_id", { length: 255 }).primaryKey(),
    completedAt: timestamp("completed_at").notNull(),
    durationMs: integer("duration_ms").notNull(),
    totalSteps: integer("total_steps").notNull(),
    toolCallCount: integer("tool_call_count").notNull(),
    errorCount: integer("error_count").notNull(),
    patterns: jsonb("patterns")
      .$type<ReflectionPattern[]>()
      .notNull()
      .default([]),
    qualityScore: real("quality_score").notNull(),
    /**
     * RUN-REFLECTION-STORE-WIDEN: API key id that owns the originating run.
     * Nullable so legacy ownerless reflections remain visible under
     * `includeLegacyOwnerless` semantics at the route layer.
     */
    ownerId: text("owner_id"),
    /**
     * RUN-REFLECTION-STORE-WIDEN: Tenant scope stamped at save time. Defaults
     * to 'default' so pre-migration rows are filterable by single-tenant
     * deployments.
     */
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("run_reflections_tenant_id_idx").on(table.tenantId),
    index("run_reflections_owner_id_idx").on(table.ownerId),
  ]
);

// ---------------------------------------------------------------------------
// Run Traces
// ---------------------------------------------------------------------------

export const runTraces = pgTable(
  "run_traces",
  {
    runId: varchar("run_id", { length: 255 }).primaryKey(),
    agentId: varchar("agent_id", { length: 255 }).notNull(),
    startedAt: integer("started_at").notNull(), // epoch ms
    completedAt: integer("completed_at"), // epoch ms, nullable
    totalSteps: integer("total_steps").notNull().default(0),
    /** S4: Tenant scope. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
  },
  (table) => [index("run_traces_tenant_id_idx").on(table.tenantId)]
);

export const traceSteps = pgTable(
  "trace_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: varchar("run_id", { length: 255 })
      .notNull()
      .references(() => runTraces.runId, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    timestamp: integer("timestamp").notNull(), // epoch ms
    type: varchar("type", { length: 30 }).notNull(), // 'user_input'|'llm_request'|etc.
    content: jsonb("content").notNull(),
    metadata: jsonb("metadata"),
    durationMs: integer("duration_ms"),
    /** S4: Tenant scope. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
  },
  (table) => [
    index("trace_steps_run_id_idx").on(table.runId),
    index("trace_steps_run_step_idx").on(table.runId, table.stepIndex),
  ]
);

// ---------------------------------------------------------------------------
// Compliance Audit Log
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  "dzupagent_audit_log",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorName: text("actor_name"),
    action: text("action").notNull(),
    resource: text("resource"),
    result: text("result").notNull(),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    previousHash: text("previous_hash").notNull().default(""),
    hash: text("hash").notNull().default(""),
    traceId: text("trace_id"),
    spanId: text("span_id"),
    /** S4: Tenant scope. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
  },
  (table) => [
    // MC-1 (AGENT-H-02): durable hash-chain integrity. A unique index on `seq`
    // guarantees no two rows share a sequence number, so two concurrent
    // PostgresAuditStore instances that race on the last-row read + insert
    // surface a unique-constraint violation instead of silently forking the
    // chain with duplicate seq values. Mirrors `flow_events_run_seq_unique`.
    uniqueIndex("dzupagent_audit_log_seq_unique").on(table.seq),
    index("dzupagent_audit_log_action_idx").on(table.action),
    index("dzupagent_audit_log_actor_id_idx").on(table.actorId),
    index("dzupagent_audit_log_ts_idx").on(table.ts),
    index("dzupagent_audit_log_tenant_id_idx").on(table.tenantId),
  ]
);
