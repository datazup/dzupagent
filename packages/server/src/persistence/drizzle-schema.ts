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
} from 'drizzle-orm/pg-core'

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
