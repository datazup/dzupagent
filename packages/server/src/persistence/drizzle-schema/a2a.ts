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
