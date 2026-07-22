/**
 * Drizzle ORM schema — core agent & run tables.
 *
 * Tables are prefixed with `forge_` to avoid collision with application
 * tables when deployed alongside other Drizzle/Prisma schemas.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Agent Definitions
// ---------------------------------------------------------------------------

export const dzipAgents = pgTable("dzip_agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  instructions: text("instructions").notNull(),
  modelTier: varchar("model_tier", { length: 50 }).notNull(),
  tools: jsonb("tools").$type<string[]>().default([]),
  guardrails: jsonb("guardrails").$type<Record<string, unknown>>(),
  approval: varchar("approval", { length: 20 }).default("auto").notNull(),
  version: integer("version").default(1).notNull(),
  active: boolean("active").default(true).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  /** MC-S02: Tenant scope. Defaults to 'default'. */
  tenantId: text("tenant_id").notNull().default("default"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const forgeRuns = pgTable("forge_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentId: uuid("agent_id")
    .references(() => dzipAgents.id)
    .notNull(),
  status: varchar("status", { length: 30 }).notNull().default("queued"),
  input: jsonb("input"),
  output: jsonb("output"),
  plan: jsonb("plan"),
  tokenUsageInput: integer("token_usage_input").default(0),
  tokenUsageOutput: integer("token_usage_output").default(0),
  costCents: real("cost_cents").default(0),
  error: text("error"),
  /**
   * API key identifier that created this run. Populated from the
   * authenticated `apiKey` context variable; nullable for backward
   * compatibility with rows created before tenant scoping was enforced.
   * Consumed by server routes to reject cross-key reads/writes with 404.
   */
  ownerId: text("owner_id"),
  /** MC-S02: Tenant scope. Defaults to 'default'. */
  tenantId: text("tenant_id").notNull().default("default"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

// ---------------------------------------------------------------------------
// Run Logs
// ---------------------------------------------------------------------------

export const forgeRunLogs = pgTable(
  "forge_run_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => forgeRuns.id, { onDelete: "cascade" })
      .notNull(),
    level: varchar("level", { length: 10 }).notNull(),
    phase: varchar("phase", { length: 50 }),
    message: text("message").notNull(),
    data: jsonb("data"),
    /** S4: Tenant scope. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
  },
  (table) => [index("forge_run_logs_tenant_id_idx").on(table.tenantId)]
);

// ---------------------------------------------------------------------------
// Run Artifacts
// ---------------------------------------------------------------------------

/**
 * Artifacts produced by a run — files, URLs, or binary blobs surfaced through
 * the `/runs/:id/artifacts` endpoint. Rows are cascade-deleted when the parent
 * run is removed.
 */
export const runArtifacts = pgTable(
  "run_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => forgeRuns.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 255 }),
    size: integer("size"),
    url: text("url"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    /** S4: Tenant scope. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("run_artifacts_run_id_idx").on(table.runId),
    index("run_artifacts_tenant_id_idx").on(table.tenantId),
  ]
);
