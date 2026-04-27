/**
 * @dzupagent/server/persistence — Drizzle store and schema facade.
 *
 * Concrete persistence implementations (Postgres stores, Drizzle schema,
 * vector helpers, mailbox / DLQ / reflection / cluster stores) live behind
 * this subpath so the root `@dzupagent/server` entrypoint can stay focused on
 * the hosting contract.
 *
 * The root entrypoint continues to re-export these symbols (deprecated) during
 * the migration compatibility window.
 */

// --- Postgres / Drizzle agent + run stores ---
export {
  PostgresRunStore,
  PostgresAgentStore,
  DrizzleVectorStore,
} from './persistence/postgres-stores.js'
export type {
  VectorDistanceMetric,
  VectorEntry as DrizzleVectorEntry,
  VectorSearchResult as DrizzleVectorSearchResult,
  VectorSearchOptions as DrizzleVectorSearchOptions,
} from './persistence/postgres-stores.js'

// --- Drizzle schema ---
export {
  dzipAgents,
  forgeRuns,
  forgeRunLogs,
  forgeVectors,
  deploymentHistory,
  a2aTasks,
  a2aTaskMessages,
  triggerConfigs,
  scheduleConfigs,
  runReflections,
  agentMailbox,
  agentClusters,
  clusterRoles,
  agentCatalog,
  runTraces,
  traceSteps,
  apiKeys,
} from './persistence/drizzle-schema.js'

// --- API key persistence ---
export {
  PostgresApiKeyStore,
  hashApiKey,
  generateRawApiKey,
} from './persistence/api-key-store.js'
export type { ApiKeyRecord, CreateApiKeyResult } from './persistence/api-key-store.js'

// --- pgvector helpers ---
export { vectorColumn } from './persistence/vector-column.js'
export { cosineDistance, l2Distance, innerProduct, toVector } from './persistence/vector-ops.js'

// --- Run trace persistence ---
export { InMemoryRunTraceStore, computeStepDistribution } from './persistence/run-trace-store.js'
export { DrizzleRunTraceStore } from './persistence/drizzle-run-trace-store.js'
export type {
  TraceStep,
  RunTrace,
  TraceStepDistribution,
  RunTraceStore,
  InMemoryRunTraceStoreOptions,
} from './persistence/run-trace-store.js'

// --- Benchmark / eval persistence ---
export { InMemoryBenchmarkRunStore } from './persistence/benchmark-run-store.js'
export { InMemoryEvalRunStore } from './persistence/eval-run-store.js'
export type {
  BenchmarkRunRecord,
  BenchmarkBaselineRecord,
  BenchmarkCompareRecord,
  BenchmarkRunStore,
} from './persistence/benchmark-run-store.js'
export type {
  EvalRunErrorRecord,
  EvalRunAttemptRecord,
  EvalRunRecord,
  EvalRunRecoveryRecord,
  EvalRunStatus,
  EvalRunListFilter,
  EvalRunStore,
} from './persistence/eval-run-store.js'

// --- DLQ / mailbox / reflection / cluster Drizzle stores ---
export {
  DrizzleDlqStore,
  DLQ_INITIAL_BACKOFF_MS,
  MAX_DLQ_ATTEMPTS,
  computeNextRetryDelayMs,
  dlqRowToMessage,
} from './persistence/drizzle-dlq-store.js'
export type { DlqRow } from './persistence/drizzle-dlq-store.js'
export { DrizzleMailboxStore } from './persistence/drizzle-mailbox-store.js'
export type { DrizzleMailboxStoreOptions } from './persistence/drizzle-mailbox-store.js'
export { DrizzleReflectionStore } from './persistence/drizzle-reflection-store.js'
export {
  InMemoryClusterStore,
  DrizzleClusterStore,
} from './persistence/drizzle-cluster-store.js'
export type {
  ClusterStore,
  ClusterRecord,
  CreateClusterInput,
} from './persistence/drizzle-cluster-store.js'

// --- Registry persistence ---
export { PostgresRegistry, InMemoryRegistryStore } from './persistence/postgres-registry.js'
export type { PostgresRegistryConfig, RegistryStore, AgentRow } from './persistence/postgres-registry.js'
