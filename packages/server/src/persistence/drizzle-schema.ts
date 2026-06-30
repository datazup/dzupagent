/**
 * Drizzle ORM schema for DzupAgent server persistence.
 *
 * Tables are prefixed with `forge_` to avoid collision with application
 * tables when deployed alongside other Drizzle/Prisma schemas.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ReflectionPattern } from "@dzupagent/agent/reflection";

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
// Agent Catalog (Marketplace)
// ---------------------------------------------------------------------------

export const agentCatalog = pgTable(
  "agent_catalog",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    version: text("version").notNull(),
    tags: text("tags").array().default([]).notNull(),
    author: text("author"),
    readme: text("readme"),
    publishedAt: timestamp("published_at"),
    isPublic: boolean("is_public").default(true).notNull(),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agent_catalog_tenant_slug_idx").on(table.tenantId, table.slug),
    index("agent_catalog_author_idx").on(table.author),
    index("agent_catalog_tenant_id_idx").on(table.tenantId),
  ]
);

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
// API Keys
// ---------------------------------------------------------------------------

/**
 * API keys used for authenticating clients against the server.
 *
 * The raw key is never stored — only the SHA-256 hex digest. The raw value is
 * returned exactly once at creation time; callers are responsible for storing
 * it securely. Keys can be scoped to an owner, time-limited via `expiresAt`,
 * and revoked by setting `revokedAt`.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** SHA-256 hex digest of the raw key (64 chars). */
    keyHash: varchar("key_hash", { length: 64 }).notNull().unique(),
    /** The user/agent id that owns this key. */
    ownerId: varchar("owner_id", { length: 255 }).notNull(),
    /** Human-readable label for the key. */
    name: varchar("name", { length: 255 }),
    /** Rate-limit tier, consumed by the rate-limiter middleware. */
    rateLimitTier: varchar("rate_limit_tier", { length: 50 })
      .default("standard")
      .notNull(),
    /**
     * MC-S02: RBAC role. Defaults to 'user'. Admin-only endpoints (MCP
     * registration, cluster management) require 'admin'.
     */
    role: text("role").notNull().default("user"),
    /**
     * MC-S02: Tenant scope carried by this key. Downstream records stamped
     * with this key inherit the value; list queries filter by tenantId so
     * keys from different tenants cannot observe each other's data.
     */
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    lastUsedAt: timestamp("last_used_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  },
  (table) => [
    index("api_keys_owner_id_idx").on(table.ownerId),
    index("api_keys_key_hash_idx").on(table.keyHash),
    index("api_keys_tenant_id_idx").on(table.tenantId),
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
