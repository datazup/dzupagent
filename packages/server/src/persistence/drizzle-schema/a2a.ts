/**
 * Drizzle ORM schema — agent-to-agent (A2A) protocol tables.
 */
import {
  pgTable,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// A2A Tasks
// ---------------------------------------------------------------------------

export const a2aTasks = pgTable("a2a_tasks", {
  id: text("id").primaryKey(),
  agentName: varchar("agent_name", { length: 255 }).notNull(),
  state: varchar("state", { length: 30 }).notNull().default("submitted"),
  input: jsonb("input"),
  output: jsonb("output"),
  error: text("error"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  pushNotificationConfig: jsonb("push_notification_config").$type<{
    url: string;
    token?: string;
    events?: string[];
  }>(),
  artifacts: jsonb("artifacts")
    .$type<
      Array<{
        parts: Array<{
          type: string;
          text?: string;
          data?: Record<string, unknown>;
        }>;
        name?: string;
        index?: number;
      }>
    >()
    .default([]),
  // RF-SEC-05: owner + tenant scope so the API key that submitted a task is
  // the only caller that can read, list, or cancel it (cross-owner reads
  // surface as 404 to prevent enumeration).
  ownerId: text("owner_id"),
  tenantId: text("tenant_id").notNull().default("default"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// A2A Task Messages
// ---------------------------------------------------------------------------

export const a2aTaskMessages = pgTable(
  "a2a_task_messages",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    taskId: text("task_id")
      .references(() => a2aTasks.id, { onDelete: "cascade" })
      .notNull(),
    role: varchar("role", { length: 20 }).notNull(),
    parts: jsonb("parts")
      .$type<
        Array<{ type: string; text?: string; data?: Record<string, unknown> }>
      >()
      .notNull(),
    /** S4: Tenant scope. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("a2a_task_messages_task_id_idx").on(table.taskId),
    index("a2a_task_messages_tenant_id_idx").on(table.tenantId),
  ]
);

// SDK v1 tasks are deliberately separate from the legacy A2A dialect.
export const a2aV1Tasks = pgTable(
  "a2a_v1_tasks",
  {
    tenantId: text("tenant_id").notNull(),
    ownerKey: text("owner_key").notNull(),
    id: text("id").notNull(),
    contextId: text("context_id").notNull(),
    state: varchar("state", { length: 40 }).notNull(),
    statusTimestamp: timestamp("status_timestamp", { withTimezone: true }),
    task: jsonb("task").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.ownerKey, table.id] }),
    index("a2a_v1_tasks_scope_context_idx").on(table.tenantId, table.ownerKey, table.contextId),
    index("a2a_v1_tasks_scope_status_idx").on(
      table.tenantId, table.ownerKey, table.statusTimestamp.desc(), table.id.desc()
    ),
  ]
);

/**
 * A2A v1 operation ledger (M3a). One row per executor invocation of a task:
 * `generation` counts invocations, `operation_key` is the Worker-visible dedupe key.
 */
export const a2aV1Operations = pgTable(
  "a2a_v1_operations",
  {
    tenantId: text("tenant_id").notNull(),
    ownerKey: text("owner_key").notNull(),
    taskId: text("task_id").notNull(),
    generation: integer("generation").notNull(),
    operationKey: text("operation_key").notNull(),
    messageId: text("message_id").notNull(),
    bootId: text("boot_id").notNull(),
    state: varchar("state", { length: 16 }).notNull().default("started"),
    recoveryState: varchar("recovery_state", { length: 24 }),
    claimKind: varchar("claim_kind", { length: 8 }),
    claimToken: text("claim_token"),
    recoveryReceipt: text("recovery_receipt"),
    recoveryUpdatedAt: timestamp("recovery_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.ownerKey, table.taskId, table.generation] }),
    uniqueIndex("a2a_v1_operations_key_uidx").on(table.operationKey),
    uniqueIndex("a2a_v1_operations_message_uidx").on(table.tenantId, table.ownerKey, table.taskId, table.messageId),
    index("a2a_v1_operations_scan_idx").on(table.bootId, table.state, table.recoveryState),
  ]
);
