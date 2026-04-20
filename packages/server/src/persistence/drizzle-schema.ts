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
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { vectorColumn } from './vector-column.js'
import type { ReflectionPattern } from '@dzupagent/agent'

// ---------------------------------------------------------------------------
// Agent Definitions
// ---------------------------------------------------------------------------

export const dzipAgents = pgTable('dzip_agents', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  instructions: text('instructions').notNull(),
  modelTier: varchar('model_tier', { length: 50 }).notNull(),
  tools: jsonb('tools').$type<string[]>().default([]),
  guardrails: jsonb('guardrails').$type<Record<string, unknown>>(),
  approval: varchar('approval', { length: 20 }).default('auto').notNull(),
  version: integer('version').default(1).notNull(),
  active: boolean('active').default(true).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  /** Optional pgvector embedding of agent instructions for semantic search. */
  instructionEmbedding: vectorColumn('instruction_embedding', { dimensions: 1536 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const forgeRuns = pgTable('forge_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id').references(() => dzipAgents.id).notNull(),
  status: varchar('status', { length: 30 }).notNull().default('queued'),
  input: jsonb('input'),
  output: jsonb('output'),
  plan: jsonb('plan'),
  tokenUsageInput: integer('token_usage_input').default(0),
  tokenUsageOutput: integer('token_usage_output').default(0),
  costCents: real('cost_cents').default(0),
  error: text('error'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  /** Optional pgvector embedding of run input for semantic search. */
  inputEmbedding: vectorColumn('input_embedding', { dimensions: 1536 }),
  /** Optional pgvector embedding of run output for semantic search. */
  outputEmbedding: vectorColumn('output_embedding', { dimensions: 1536 }),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
})

// ---------------------------------------------------------------------------
// Run Logs
// ---------------------------------------------------------------------------

export const forgeRunLogs = pgTable('forge_run_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').references(() => forgeRuns.id, { onDelete: 'cascade' }).notNull(),
  level: varchar('level', { length: 10 }).notNull(),
  phase: varchar('phase', { length: 50 }),
  message: text('message').notNull(),
  data: jsonb('data'),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Deployment History
// ---------------------------------------------------------------------------

export const deploymentHistory = pgTable(
  'deployment_history',
  {
    id: text('id').primaryKey(),
    confidenceScore: real('confidence_score').notNull(),
    gateDecision: text('gate_decision').notNull(),
    signalsSnapshot: jsonb('signals_snapshot').$type<Record<string, unknown>[]>(),
    deployedAt: timestamp('deployed_at').defaultNow().notNull(),
    deployedBy: text('deployed_by'),
    environment: text('environment').notNull(),
    rollbackAvailable: boolean('rollback_available').default(false).notNull(),
    outcome: text('outcome'),
    completedAt: timestamp('completed_at'),
    notes: text('notes'),
  },
  (table) => [
    index('deployment_history_environment_idx').on(table.environment),
    index('deployment_history_deployed_at_idx').on(table.deployedAt),
  ],
)

// ---------------------------------------------------------------------------
// General-Purpose Vector Storage
// ---------------------------------------------------------------------------

/**
 * General-purpose vector storage table for Drizzle-native pgvector queries.
 *
 * Stores vectors organised by `collection` with an application-defined `key`
 * for upsert semantics. The `embedding` column uses pgvector's `vector(1536)`
 * type and supports cosine distance, L2 distance, and inner product operators.
 *
 * An HNSW index on the embedding column accelerates approximate
 * nearest-neighbor searches. A unique constraint on (collection, key)
 * enables upsert-on-conflict.
 */
// ---------------------------------------------------------------------------
// A2A Tasks
// ---------------------------------------------------------------------------

export const a2aTasks = pgTable('a2a_tasks', {
  id: text('id').primaryKey(),
  agentName: varchar('agent_name', { length: 255 }).notNull(),
  state: varchar('state', { length: 30 }).notNull().default('submitted'),
  input: jsonb('input'),
  output: jsonb('output'),
  error: text('error'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  pushNotificationConfig: jsonb('push_notification_config').$type<{
    url: string
    token?: string
    events?: string[]
  }>(),
  artifacts: jsonb('artifacts').$type<Array<{ parts: Array<{ type: string; text?: string; data?: Record<string, unknown> }>; name?: string; index?: number }>>().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// A2A Task Messages
// ---------------------------------------------------------------------------

export const a2aTaskMessages = pgTable(
  'a2a_task_messages',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    taskId: text('task_id').references(() => a2aTasks.id, { onDelete: 'cascade' }).notNull(),
    role: varchar('role', { length: 20 }).notNull(),
    parts: jsonb('parts').$type<Array<{ type: string; text?: string; data?: Record<string, unknown> }>>().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('a2a_task_messages_task_id_idx').on(table.taskId),
  ],
)

// ---------------------------------------------------------------------------
// Trigger Configs
// ---------------------------------------------------------------------------

export const triggerConfigs = pgTable('trigger_configs', {
  id: text('id').primaryKey(),
  type: varchar('type', { length: 20 }).notNull(),
  agentId: text('agent_id').notNull(),
  schedule: text('schedule'),
  webhookSecret: text('webhook_secret'),
  afterAgentId: text('after_agent_id'),
  enabled: boolean('enabled').default(true).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Schedule Configs
// ---------------------------------------------------------------------------

export const scheduleConfigs = pgTable('schedule_configs', {
  id: text('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  cronExpression: text('cron_expression').notNull(),
  workflowText: text('workflow_text').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Run Reflections
// ---------------------------------------------------------------------------

export const runReflections = pgTable('run_reflections', {
  runId: varchar('run_id', { length: 255 }).primaryKey(),
  completedAt: timestamp('completed_at').notNull(),
  durationMs: integer('duration_ms').notNull(),
  totalSteps: integer('total_steps').notNull(),
  toolCallCount: integer('tool_call_count').notNull(),
  errorCount: integer('error_count').notNull(),
  patterns: jsonb('patterns').$type<ReflectionPattern[]>().notNull().default([]),
  qualityScore: real('quality_score').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// General-Purpose Vector Storage
// ---------------------------------------------------------------------------

export const forgeVectors = pgTable(
  'forge_vectors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Logical grouping (e.g. "agent-instructions", "run-outputs"). */
    collection: varchar('collection', { length: 255 }).notNull(),
    /** Application-defined key, unique within a collection. */
    key: varchar('key', { length: 512 }).notNull(),
    /** pgvector embedding (1536 dimensions, matching OpenAI ada-002/text-embedding-3-small). */
    embedding: vectorColumn('embedding', { dimensions: 1536 }),
    /** Arbitrary JSON metadata for filtering. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    /** Original text that was embedded (for retrieval display). */
    text: text('text'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('forge_vectors_collection_key_idx').on(table.collection, table.key),
    index('forge_vectors_collection_idx').on(table.collection),
  ],
)

// ---------------------------------------------------------------------------
// Agent Catalog (Marketplace)
// ---------------------------------------------------------------------------

export const agentCatalog = pgTable(
  'agent_catalog',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    version: text('version').notNull(),
    tags: text('tags').array().default([]).notNull(),
    author: text('author'),
    readme: text('readme'),
    publishedAt: timestamp('published_at'),
    isPublic: boolean('is_public').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('agent_catalog_slug_idx').on(table.slug),
    index('agent_catalog_author_idx').on(table.author),
  ],
)

// ---------------------------------------------------------------------------
// Agent Clusters
// ---------------------------------------------------------------------------

export const agentClusters = pgTable('agent_clusters', {
  id: text('id').primaryKey(),
  workspaceType: varchar('workspace_type', { length: 50 }).notNull().default('local'),
  workspaceOptions: jsonb('workspace_options').$type<Record<string, unknown>>().default({}),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const clusterRoles = pgTable(
  'cluster_roles',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    clusterId: text('cluster_id').references(() => agentClusters.id, { onDelete: 'cascade' }).notNull(),
    roleId: varchar('role_id', { length: 255 }).notNull(),
    agentId: text('agent_id').notNull(),
    capabilities: jsonb('capabilities').$type<string[]>().default([]),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('cluster_roles_cluster_role_idx').on(table.clusterId, table.roleId),
    index('cluster_roles_cluster_id_idx').on(table.clusterId),
  ],
)

// ---------------------------------------------------------------------------
// Agent Mailbox
// ---------------------------------------------------------------------------

export const agentMailbox = pgTable(
  'agent_mailbox',
  {
    id: text('id').primaryKey(),
    fromAgent: text('from_agent').notNull(),
    toAgent: text('to_agent').notNull(),
    subject: text('subject').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    createdAt: integer('created_at').notNull(),
    readAt: integer('read_at'),
    ttlSeconds: integer('ttl_seconds'),
  },
  (table) => [
    index('agent_mailbox_to_agent_created_at_idx').on(table.toAgent, table.createdAt),
  ],
)

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
  'agent_mail_dlq',
  {
    id: text('id').primaryKey(),
    originalMessageId: text('original_message_id').notNull(),
    fromAgent: text('from_agent').notNull(),
    toAgent: text('to_agent').notNull(),
    subject: text('subject').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    failReason: text('fail_reason').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextRetryAt: integer('next_retry_at').notNull(),
    createdAt: integer('created_at').notNull(),
    deadAt: integer('dead_at'),
  },
  (table) => [
    index('agent_mail_dlq_next_retry_at_idx').on(table.nextRetryAt),
    index('agent_mail_dlq_to_agent_idx').on(table.toAgent),
  ],
)
