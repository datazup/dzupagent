/**
 * Drizzle ORM schema — triggers, schedules, and the durable run queue.
 */
import {
  pgTable,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Trigger Configs
// ---------------------------------------------------------------------------

export const triggerConfigs = pgTable("trigger_configs", {
  id: text("id").primaryKey(),
  type: varchar("type", { length: 20 }).notNull(),
  agentId: text("agent_id").notNull(),
  schedule: text("schedule"),
  webhookSecret: text("webhook_secret"),
  afterAgentId: text("after_agent_id"),
  enabled: boolean("enabled").default(true).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  /** MC-S02: Tenant scope. Defaults to 'default'. */
  tenantId: text("tenant_id").notNull().default("default"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Schedule Configs
// ---------------------------------------------------------------------------

export const scheduleConfigs = pgTable("schedule_configs", {
  id: text("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  cronExpression: text("cron_expression").notNull(),
  workflowText: text("workflow_text").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  /** MC-S02: Tenant scope. Defaults to 'default'. */
  tenantId: text("tenant_id").notNull().default("default"),
  /** P4 HA: next occurrence due to fire (claim-tick driver). */
  nextRunAt: timestamp("next_run_at"),
  /** P4 HA: true while a fired run is still in flight (skip-if-running). */
  running: boolean("running").default(false).notNull(),
  /** P4 HA: node id that won the most recent claim. */
  claimedBy: text("claimed_by"),
  /** P4 HA: timestamp of the most recent successful claim. */
  lastClaimedAt: timestamp("last_claimed_at"),
  /** P4 HA: timestamp of the most recent fired occurrence. */
  lastFiredAt: timestamp("last_fired_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Flow Jobs (P2 Queue — Postgres-native run queue, Option C)
// ---------------------------------------------------------------------------

/**
 * Durable run-queue table backing {@link PostgresRunQueue}. Decouples run
 * creation from execution without requiring Redis. Workers poll `pending` rows
 * ordered by (priority ASC, created_at ASC) and claim them atomically with
 * `FOR UPDATE SKIP LOCKED`, so concurrent workers never grab the same job.
 *
 * `id` is caller-supplied (uuid). Lower `priority` = higher priority. Status
 * transitions: pending → claimed → completed | failed; or pending → cancelled.
 */
export const flowJobs = pgTable(
  "flow_jobs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    agentId: text("agent_id").notNull(),
    input: jsonb("input").$type<unknown>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    /** Lower = higher priority. */
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    /** pending | claimed | completed | failed | cancelled */
    status: text("status").notNull().default("pending"),
    claimedAt: timestamp("claimed_at"),
    claimedBy: text("claimed_by"),
    error: text("error"),
    /** S4: Tenant scope. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("flow_jobs_status_priority_created_at_idx").on(
      table.status,
      table.priority,
      table.createdAt
    ),
    index("flow_jobs_run_id_idx").on(table.runId),
    index("flow_jobs_tenant_id_idx").on(table.tenantId),
  ]
);
