/**
 * @dzupagent/server/extensions — optional extension / plugin planes.
 *
 * This subpath bundles the feature planes that should not silently widen the
 * default server contract: quota primitives, retrieval-feedback hooks,
 * learning APIs, deploy gating, marketplace, triggers/schedules, personas,
 * prompts, reflections, memory feature routes, security incident response,
 * notifications, registry, A2A, and the marketplace catalog.
 *
 * Hosts that adopt one of these planes import them here; the root entrypoint
 * keeps deprecated re-exports for the migration compatibility window.
 */

// --- Quota primitives ---
export { InMemoryQuotaManager } from './runtime/memory-quota-manager.js'
export { QuotaExceededError } from './runtime/resource-quota.js'
export type {
  ResourceDimensions,
  ResourceQuota,
  ResourceReservation,
  ResourceQuotaManager,
  QuotaCheckResult,
} from './runtime/resource-quota.js'

// --- Retrieval feedback hooks ---
export { reportRetrievalFeedback, mapScoreToQuality } from './runtime/retrieval-feedback-hook.js'
export type {
  RetrievalFeedbackSink,
  RetrievalFeedbackHookConfig,
} from './runtime/retrieval-feedback-hook.js'

// --- Sleep consolidation tasks ---
export { createSleepConsolidationTask } from './runtime/sleep-consolidation-task.js'
export type {
  SleepConsolidationTaskConfig,
  SleepConsolidatorLike,
  SleepConsolidationReportLike,
} from './runtime/sleep-consolidation-task.js'

// --- Learning routes ---
export { createLearningRoutes } from './routes/learning.js'
export type { LearningRouteConfig } from './routes/learning.js'

// --- Memory feature routes ---
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

// --- Benchmarks / evals ---
export { createBenchmarkRoutes } from './routes/benchmarks.js'
export type { BenchmarkRouteConfig, BenchmarkOrchestratorFactory } from './routes/benchmarks.js'
export { createEvalRoutes } from './routes/evals.js'
export type { EvalRouteConfig, EvalOrchestratorFactory } from './routes/evals.js'

// --- Routing stats / playground ---
export { createRoutingStatsRoutes } from './routes/routing-stats.js'
export type { RoutingStatsConfig } from './routes/routing-stats.js'
export { createPlaygroundRoutes } from './routes/playground.js'
export type { PlaygroundRouteConfig } from './routes/playground.js'

// --- Notifications ---
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

// --- A2A ---
export {
  buildAgentCard,
  InMemoryA2ATaskStore,
  DrizzleA2ATaskStore,
  createA2ARoutes,
} from './a2a/index.js'
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

// --- Triggers / schedules ---
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

// --- Personas / prompts / presets / reflections ---
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

// --- Cluster workspaces ---
export { createClusterRoutes } from './routes/clusters.js'
export type { ClusterRouteConfig } from './routes/clusters.js'

// --- Deploy gating ---
export { generateDockerfile, generateDockerCompose, generateDockerignore } from './deploy/docker-generator.js'
export type { DockerConfig } from './deploy/docker-generator.js'
export { checkHealth } from './deploy/health-checker.js'
export type { HealthCheckResult } from './deploy/health-checker.js'
export { DeployConfidenceCalculator } from './deploy/confidence-calculator.js'
export { DeployGate } from './deploy/deploy-gate.js'
export {
  DeploymentHistory,
  generateDeploymentId,
  resetIdCounter,
} from './deploy/deployment-history.js'
export type {
  GateDecision,
  ConfidenceSignal,
  DeployConfidence,
  ConfidenceThresholds,
  DeployConfidenceConfig,
  DeploymentRecord,
} from './deploy/confidence-types.js'
export {
  PostgresDeploymentHistoryStore,
  InMemoryDeploymentHistoryStore,
} from './deploy/deployment-history-store.js'
export type {
  DeploymentHistoryStoreInterface,
  DeploymentHistoryRecord,
  DeploymentHistoryInput,
  DeploymentOutcome,
  SuccessRateResult,
} from './deploy/deployment-history-store.js'
export {
  checkRecoveryCopilotConfigured,
  checkRollbackAvailable,
  computeAllSignals,
} from './deploy/signal-checkers.js'
export type {
  AgentConfigLike,
  RollbackCheckResult,
  RollbackChecker,
  SignalComputationResult,
  SignalComputationConfig,
} from './deploy/signal-checkers.js'
export { createDeployRoutes } from './routes/deploy.js'
export type { DeployRouteConfig } from './routes/deploy.js'

// --- Security incident response (optional plane) ---
export {
  IncidentResponseEngine,
  clearIncidentFlags,
  isAgentKilled,
  isToolDisabled,
  isNamespaceQuarantined,
} from './security/incident-response.js'
export type {
  IncidentAction,
  IncidentTrigger,
  PlaybookAction,
  IncidentPlaybook,
  IncidentActionResult,
  IncidentRecord,
  IncidentResponseConfig,
} from './security/incident-response.js'

// --- Registry ---
export { HealthMonitor } from './registry/health-monitor.js'
export type { HealthMonitorConfig, ProbeResult } from './registry/health-monitor.js'
export { createRegistryRoutes } from './routes/registry.js'
export type { RegistryRouteConfig } from './routes/registry.js'
