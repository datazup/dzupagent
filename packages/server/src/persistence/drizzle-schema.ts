/**
 * Drizzle ORM schema for ForgeAgent server persistence.
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

// ---------------------------------------------------------------------------
// Agent Definitions
// ---------------------------------------------------------------------------

export const forgeAgents = pgTable('forge_agents', {
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
  agentId: uuid('agent_id').references(() => forgeAgents.id).notNull(),
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
