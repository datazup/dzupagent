/**
 * Drizzle ORM schema — agent clusters, roles, and mailbox (inter-agent mail).
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
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Agent Clusters
// ---------------------------------------------------------------------------

export const agentClusters = pgTable("agent_clusters", {
  id: text("id").primaryKey(),
  workspaceType: varchar("workspace_type", { length: 50 })
    .notNull()
    .default("local"),
  workspaceOptions: jsonb("workspace_options")
    .$type<Record<string, unknown>>()
    .default({}),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  tenantId: text("tenant_id").notNull().default("default"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const clusterRoles = pgTable(
  "cluster_roles",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    clusterId: text("cluster_id")
      .references(() => agentClusters.id, { onDelete: "cascade" })
      .notNull(),
    roleId: varchar("role_id", { length: 255 }).notNull(),
    agentId: text("agent_id").notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().default([]),
    /** S4: Tenant scope. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("cluster_roles_cluster_role_idx").on(
      table.clusterId,
      table.roleId
    ),
    index("cluster_roles_cluster_id_idx").on(table.clusterId),
  ]
);

// ---------------------------------------------------------------------------
// Agent Mailbox
// ---------------------------------------------------------------------------

export const agentMailbox = pgTable(
  "agent_mailbox",
  {
    id: text("id").primaryKey(),
    fromAgent: text("from_agent").notNull(),
    toAgent: text("to_agent").notNull(),
    subject: text("subject").notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at").notNull(),
    readAt: integer("read_at"),
    ttlSeconds: integer("ttl_seconds"),
    /** MC-S02: Tenant scope. Defaults to 'default'. */
    tenantId: text("tenant_id").notNull().default("default"),
  },
  (table) => [
    index("agent_mailbox_to_agent_created_at_idx").on(
      table.toAgent,
      table.createdAt
    ),
    index("agent_mailbox_tenant_id_idx").on(table.tenantId),
  ]
);

// ---------------------------------------------------------------------------
// Agent Mail Dead-Letter Queue
// ---------------------------------------------------------------------------

/**
 * Dead-letter queue for undeliverable/rate-limited agent mail messages.
 *
 * Rows are enqueued when `DrizzleMailboxStore.save()` fails (e.g. rate-limit
 * overflow). A background worker periodically `drain()`s due rows and attempts
 * redelivery. After {@link MAX_DLQ_ATTEMPTS} attempts, `deadAt` is set and the
 * row is skipped by `drain()` until manually redelivered or purged.
 *
 * All timestamps are epoch milliseconds (integer) for consistency with
 * {@link agentMailbox}.
 */
export const agentMailDlq = pgTable(
  "agent_mail_dlq",
  {
    id: text("id").primaryKey(),
    originalMessageId: text("original_message_id").notNull(),
    fromAgent: text("from_agent").notNull(),
    toAgent: text("to_agent").notNull(),
    subject: text("subject").notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    failReason: text("fail_reason").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: integer("next_retry_at").notNull(),
    createdAt: integer("created_at").notNull(),
    deadAt: integer("dead_at"),
  },
  (table) => [
    index("agent_mail_dlq_next_retry_at_idx").on(table.nextRetryAt),
    index("agent_mail_dlq_to_agent_idx").on(table.toAgent),
  ]
);
