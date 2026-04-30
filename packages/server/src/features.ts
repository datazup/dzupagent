/**
 * @dzupagent/server/features — opt-in feature-plane server APIs.
 *
 * These routes, stores, and helpers are framework capabilities, but they are
 * intentionally outside the stable root hosting contract.
 */

// --- Human Contact ---
export { createHumanContactRoutes } from './routes/human-contact.js'
export { HumanContactTimeoutScheduler } from './lifecycle/human-contact-timeout.js'
export type { HumanContactTimeoutConfig } from './lifecycle/human-contact-timeout.js'

// --- Memory / Learning ---
export { createMemoryRoutes } from './routes/memory.js'
export type { MemoryRouteConfig } from './routes/memory.js'
export { createMemoryBrowseRoutes } from './routes/memory-browse.js'
export type { MemoryBrowseRouteConfig } from './routes/memory-browse.js'
export { createMemoryHealthRoutes } from './routes/memory-health.js'
export type { MemoryHealthRouteConfig, HealthProvider } from './routes/memory-health.js'
export { createMemorySyncRoutes, createMemorySyncHandler } from './routes/memory-sync.js'
export type {
  MemorySyncRouteConfig,
  SyncWebSocket,
  SyncConnectionHandle,
} from './routes/memory-sync.js'
export { createLearningRoutes } from './routes/learning.js'
export type { LearningRouteConfig } from './routes/learning.js'

// --- Benchmark / Eval Routes ---
export { createBenchmarkRoutes } from './routes/benchmarks.js'
export type { BenchmarkRouteConfig, BenchmarkOrchestratorFactory } from './routes/benchmarks.js'
export { createEvalRoutes } from './routes/evals.js'
export type { EvalRouteConfig, EvalOrchestratorFactory } from './routes/evals.js'
export type {
  EvalOrchestratorLike,
  BenchmarkOrchestratorLike,
  EvalExecutionTarget,
  EvalExecutionContext,
  EvalQueueStats,
  BenchmarkRunSuiteInput,
  BenchmarkCompareResult,
} from '@dzupagent/eval-contracts'

// --- Workflow / Trace / Observability Routes ---
export { createRunContextRoutes } from './routes/run-context.js'
export type { TokenLifecycleLike, TokenLifecycleRegistry } from './routes/run-context.js'
export { createWorkflowRoutes } from './routes/workflows.js'
export type { WorkflowRouteConfig } from './routes/workflows.js'
export { createRunTraceRoutes } from './routes/run-trace.js'
export type { RunTraceRouteConfig } from './routes/run-trace.js'
export { createRoutingStatsRoutes } from './routes/routing-stats.js'
export type { RoutingStatsConfig } from './routes/routing-stats.js'
export { createMetricsRoute } from './routes/metrics.js'
export type { MetricsAccessControl, MetricsRouteConfig } from './routes/metrics.js'

// --- Notifications / Mailbox ---
export { Notifier, classifyEvent } from './notifications/notifier.js'
export type {
  Notification,
  NotificationChannel,
  NotifierConfig,
  NotificationTier,
  NotificationPriority,
} from './notifications/notifier.js'
export { WebhookChannel } from './notifications/channels/webhook-channel.js'
export type { WebhookChannelConfig } from './notifications/channels/webhook-channel.js'
export { ConsoleChannel } from './notifications/channels/console-channel.js'
export { SlackNotificationChannel } from './notifications/channels/slack-channel.js'
export type { SlackNotificationChannelConfig } from './notifications/channels/slack-channel.js'
export { EmailWebhookNotificationChannel } from './notifications/channels/email-webhook-channel.js'
export type { EmailWebhookNotificationChannelConfig } from './notifications/channels/email-webhook-channel.js'
export {
  MailRateLimiter,
  MailRateLimitError,
  DEFAULT_CAPACITY as DEFAULT_MAIL_BUCKET_CAPACITY,
  DEFAULT_REFILL_PER_MINUTE as DEFAULT_MAIL_REFILL_PER_MINUTE,
} from './notifications/mail-rate-limiter.js'
export type { MailRateLimiterConfig } from './notifications/mail-rate-limiter.js'
export {
  MailDlqWorker,
  DEFAULT_DLQ_WORKER_INTERVAL_MS,
  DEFAULT_DLQ_WORKER_BATCH_SIZE,
} from './notifications/mail-dlq-worker.js'
export type { MailDlqWorkerConfig } from './notifications/mail-dlq-worker.js'
export { createMailboxRoutes } from './routes/mailbox.js'
export type { MailboxRouteConfig } from './routes/mailbox.js'

// --- A2A Protocol ---
export { buildAgentCard, InMemoryA2ATaskStore, DrizzleA2ATaskStore, createA2ARoutes } from './a2a/index.js'
export type {
  AgentCard,
  AgentCapability,
  AgentCardConfig,
  A2ATask,
  A2ATaskState,
  A2ATaskStore,
  A2ARoutesConfig,
  A2AMessagePart,
  A2ATaskMessage,
  A2ATaskArtifact,
  A2ATaskPushConfig,
} from './a2a/index.js'

// --- Marketplace ---
export { createMarketplaceRoutes } from './routes/marketplace.js'
export type { MarketplaceRouteConfig } from './routes/marketplace.js'
export {
  InMemoryCatalogStore,
  DrizzleCatalogStore,
  CatalogNotFoundError,
  CatalogSlugConflictError,
} from './marketplace/index.js'
export type {
  CatalogEntry,
  CatalogEntryCreate,
  CatalogEntryPatch,
  CatalogSearchQuery,
  CatalogSearchResult,
  CatalogStore,
} from './marketplace/index.js'

// --- Triggers / Schedules ---
export { TriggerManager } from './triggers/index.js'
export type {
  TriggerType,
  TriggerConfig,
  CronTriggerConfig,
  WebhookTriggerConfig,
  ChainTriggerConfig,
} from './triggers/index.js'
export { InMemoryTriggerStore, DrizzleTriggerStore } from './triggers/trigger-store.js'
export type { TriggerStore, TriggerConfigRecord } from './triggers/trigger-store.js'
export { createTriggerRoutes } from './routes/triggers.js'
export type { TriggerRouteConfig } from './routes/triggers.js'
export { createScheduleRoutes } from './routes/schedules.js'
export type { ScheduleRouteConfig } from './routes/schedules.js'
export { InMemoryScheduleStore, DrizzleScheduleStore } from './schedules/schedule-store.js'
export type { ScheduleStore, ScheduleRecord } from './schedules/schedule-store.js'

// --- Personas / Prompts / Presets / Reflections ---
export { createPersonaRoutes } from './routes/personas.js'
export type { PersonaRouteConfig } from './routes/personas.js'
export { InMemoryPersonaStore } from './personas/persona-store.js'
export type { PersonaStore, PersonaRecord } from './personas/persona-store.js'
export { createPersonaStoreResolver } from './personas/persona-resolver.js'
export type { PersonaStoreResolver } from './personas/persona-resolver.js'
export { createPromptRoutes } from './routes/prompts.js'
export type { PromptRouteConfig } from './routes/prompts.js'
export { InMemoryPromptStore } from './prompts/prompt-store.js'
export type { PromptStore, PromptVersionRecord, PromptStatus } from './prompts/prompt-store.js'
export { createPresetRoutes } from './routes/presets.js'
export type { PresetRouteConfig } from './routes/presets.js'
export { createReflectionRoutes } from './routes/reflections.js'
export type { ReflectionRouteConfig } from './routes/reflections.js'
export { DrizzleReflectionStore } from './persistence/drizzle-reflection-store.js'

// --- Clusters ---
export { InMemoryClusterStore, DrizzleClusterStore } from './persistence/drizzle-cluster-store.js'
export type { ClusterStore, ClusterRecord, CreateClusterInput } from './persistence/drizzle-cluster-store.js'
export { createClusterRoutes } from './routes/clusters.js'
export type { ClusterRouteConfig } from './routes/clusters.js'
