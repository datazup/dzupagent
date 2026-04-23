/**
 * @dzupagent/server — Optional HTTP/WS runtime for DzupAgent.
 *
 * Provides: Hono REST API, run/agent persistence (Postgres + Drizzle),
 * approval management, SSE streaming, WebSocket event bridge,
 * API key authentication, rate limiting, background job queue,
 * graceful shutdown, and health/metrics endpoints.
 */

// --- App ---
export { createForgeApp } from './app.js'
export type { ForgeServerConfig, ConsolidationConfig, MailDeliveryConfig } from './app.js'
export type { ServerRoutePlugin } from './route-plugin.js'

// --- Routes ---
export { createRunRoutes } from './routes/runs.js'
export { createRunContextRoutes } from './routes/run-context.js'
export type { TokenLifecycleLike, TokenLifecycleRegistry } from './routes/run-context.js'
export { createAgentRoutes } from './routes/agents.js'
export { createApprovalRoutes } from './routes/approval.js'
export { createHumanContactRoutes } from './routes/human-contact.js'
export { createHealthRoutes } from './routes/health.js'
export { createMemoryRoutes } from './routes/memory.js'
export type { MemoryRouteConfig } from './routes/memory.js'
export { createMemoryBrowseRoutes } from './routes/memory-browse.js'
export type { MemoryBrowseRouteConfig } from './routes/memory-browse.js'
export { createLearningRoutes } from './routes/learning.js'
export type { LearningRouteConfig } from './routes/learning.js'
export { createBenchmarkRoutes } from './routes/benchmarks.js'
export type { BenchmarkRouteConfig } from './routes/benchmarks.js'
export { createEvalRoutes } from './routes/evals.js'
export type { EvalRouteConfig } from './routes/evals.js'
export { createMemoryHealthRoutes } from './routes/memory-health.js'
export type { MemoryHealthRouteConfig, HealthProvider } from './routes/memory-health.js'
export { createRoutingStatsRoutes } from './routes/routing-stats.js'
export type { RoutingStatsConfig } from './routes/routing-stats.js'
export { createPlaygroundRoutes } from './routes/playground.js'
export type { PlaygroundRouteConfig } from './routes/playground.js'
export { createEventRoutes } from './routes/events.js'
export type { EventRouteConfig } from './routes/events.js'
export { createWorkflowRoutes } from './routes/workflows.js'
export type { WorkflowRouteConfig } from './routes/workflows.js'
export { createMetricsRoute } from './routes/metrics.js'
export type { MetricsRouteConfig } from './routes/metrics.js'

// --- Metrics ---
export { PrometheusMetricsCollector } from './metrics/prometheus-collector.js'

// --- Persistence ---
export { PostgresRunStore, PostgresAgentStore, DrizzleVectorStore } from './persistence/postgres-stores.js'
export type {
  VectorDistanceMetric,
  VectorEntry as DrizzleVectorEntry,
  VectorSearchResult as DrizzleVectorSearchResult,
  VectorSearchOptions as DrizzleVectorSearchOptions,
} from './persistence/postgres-stores.js'
export { dzipAgents, forgeRuns, forgeRunLogs, forgeVectors, deploymentHistory, a2aTasks, a2aTaskMessages, triggerConfigs, scheduleConfigs, runReflections, agentMailbox, agentClusters, clusterRoles, agentCatalog, runTraces, traceSteps, apiKeys } from './persistence/drizzle-schema.js'
export { PostgresApiKeyStore, hashApiKey, generateRawApiKey } from './persistence/api-key-store.js'
export type { ApiKeyRecord, CreateApiKeyResult } from './persistence/api-key-store.js'
export { createApiKeyRoutes } from './routes/api-keys.js'
export type { ApiKeyRoutesConfig } from './routes/api-keys.js'

// --- Vector (pgvector) ---
export { vectorColumn } from './persistence/vector-column.js'
export { cosineDistance, l2Distance, innerProduct, toVector } from './persistence/vector-ops.js'
export { InMemoryRunTraceStore, computeStepDistribution } from './persistence/run-trace-store.js'
export { DrizzleRunTraceStore } from './persistence/drizzle-run-trace-store.js'
export { InMemoryBenchmarkRunStore } from './persistence/benchmark-run-store.js'
export { InMemoryEvalRunStore } from './persistence/eval-run-store.js'
export type {
  TraceStep,
  RunTrace,
  TraceStepDistribution,
  RunTraceStore,
  InMemoryRunTraceStoreOptions,
} from './persistence/run-trace-store.js'
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

// --- Run Trace Routes ---
export { createRunTraceRoutes } from './routes/run-trace.js'
export type { RunTraceRouteConfig } from './routes/run-trace.js'

// --- Middleware ---
export { authMiddleware } from './middleware/auth.js'
export type { AuthConfig } from './middleware/auth.js'
export { rateLimiterMiddleware, TokenBucketLimiter } from './middleware/rate-limiter.js'
export type { RateLimiterConfig } from './middleware/rate-limiter.js'

// --- Identity & Capability ---
export { identityMiddleware, getForgeIdentity, getForgeCapabilities } from './middleware/identity.js'
export type { IdentityMiddlewareConfig } from './middleware/identity.js'
export { capabilityGuard } from './middleware/capability-guard.js'

// --- RBAC ---
export { rbacMiddleware, rbacGuard, hasPermission, DEFAULT_ROLE_PERMISSIONS } from './middleware/rbac.js'
export type { ForgeRole, ForgePermission, RBACConfig } from './middleware/rbac.js'
export { tenantScopeMiddleware, getTenantId } from './middleware/tenant-scope.js'
export type { TenantScopeConfig } from './middleware/tenant-scope.js'

// --- Queue ---
export { InMemoryRunQueue } from './queue/run-queue.js'
export { BullMQRunQueue } from './queue/bullmq-run-queue.js'
export type { BullMQRunQueueConfig } from './queue/bullmq-run-queue.js'
export type { RunQueue, RunJob, RunQueueConfig, QueueStats, JobProcessor, DeadLetterEntry } from './queue/run-queue.js'

// --- Lifecycle ---
export { GracefulShutdown } from './lifecycle/graceful-shutdown.js'
export type { ShutdownConfig, ShutdownState } from './lifecycle/graceful-shutdown.js'
export { HumanContactTimeoutScheduler } from './lifecycle/human-contact-timeout.js'
export type { HumanContactTimeoutConfig } from './lifecycle/human-contact-timeout.js'

// --- Eval Orchestration ---
export { EvalOrchestrator, EvalExecutionUnavailableError, EvalRunInvalidStateError } from './services/eval-orchestrator.js'
export type { EvalOrchestratorConfig, EvalExecutionTarget, EvalExecutionContext, EvalQueueStats } from './services/eval-orchestrator.js'

// --- WebSocket ---
export { EventBridge } from './ws/event-bridge.js'
export type { WSClient, ClientFilter, EventBridgeConfig } from './ws/event-bridge.js'
export { createWsControlHandler } from './ws/control-protocol.js'
export { createScopedAuthorizeFilter } from './ws/authorization.js'
export { WSClientScopeRegistry } from './ws/scope-registry.js'
export { createScopedWsControlHandler } from './ws/scoped-control-handler.js'
export { WSSessionManager } from './ws/session-manager.js'
export { attachNodeWsSession } from './ws/node-adapter.js'
export { createNodeWsUpgradeHandler, createPathUpgradeGuard } from './ws/node-upgrade-handler.js'
export type {
  WSControlClientMessage,
  WSControlServerMessage,
  WSControlHandlerOptions,
  WSControlAuthorizeFilter,
  WSControlAuthorizeContext,
} from './ws/control-protocol.js'
export type {
  WSClientScope,
  ScopedAuthorizeFilterOptions,
} from './ws/authorization.js'
export type { ScopedWsControlHandlerOptions } from './ws/scoped-control-handler.js'
export type { WSSessionManagerOptions } from './ws/session-manager.js'
export type { NodeWSLike, AttachNodeWsSessionOptions } from './ws/node-adapter.js'
export type { NodeWebSocketServerLike, NodeWsUpgradeHandlerOptions } from './ws/node-upgrade-handler.js'
export { InMemoryEventGateway } from './events/event-gateway.js'
export type {
  EventGateway,
  EventEnvelope,
  EventSubscription,
  EventSubscriptionFilter,
  OverflowStrategy,
  EventSink,
  InMemoryEventGatewayConfig,
} from './events/event-gateway.js'

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
export {
  DrizzleDlqStore,
  DLQ_INITIAL_BACKOFF_MS,
  MAX_DLQ_ATTEMPTS,
  computeNextRetryDelayMs,
  dlqRowToMessage,
} from './persistence/drizzle-dlq-store.js'
export type { DlqRow } from './persistence/drizzle-dlq-store.js'
export type { DrizzleMailboxStoreOptions } from './persistence/drizzle-mailbox-store.js'

// --- A2A (Agent-to-Agent) Protocol ---
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

// --- Memory CRDT Sync ---
export { createMemorySyncRoutes, createMemorySyncHandler } from './routes/memory-sync.js'
export type {
  MemorySyncRouteConfig,
  SyncWebSocket,
  SyncConnectionHandle,
} from './routes/memory-sync.js'

// --- Triggers ---
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
export { createPersonaRoutes } from './routes/personas.js'
export { createPromptRoutes } from './routes/prompts.js'
export type { PromptRouteConfig } from './routes/prompts.js'
export { InMemoryPromptStore } from './prompts/prompt-store.js'
export type { PromptStore, PromptVersionRecord, PromptStatus } from './prompts/prompt-store.js'
export type { PersonaRouteConfig } from './routes/personas.js'
export { InMemoryPersonaStore } from './personas/persona-store.js'
export type { PersonaStore, PersonaRecord } from './personas/persona-store.js'
export { createPersonaStoreResolver } from './personas/persona-resolver.js'
export type { PersonaStoreResolver } from './personas/persona-resolver.js'
export { createPresetRoutes } from './routes/presets.js'
export type { PresetRouteConfig } from './routes/presets.js'
export { createReflectionRoutes } from './routes/reflections.js'
export type { ReflectionRouteConfig } from './routes/reflections.js'
export { DrizzleReflectionStore } from './persistence/drizzle-reflection-store.js'
export { DrizzleMailboxStore } from './persistence/drizzle-mailbox-store.js'
export { createMailboxRoutes } from './routes/mailbox.js'
export type { MailboxRouteConfig } from './routes/mailbox.js'

// --- Cluster Workspaces ---
export { InMemoryClusterStore, DrizzleClusterStore } from './persistence/drizzle-cluster-store.js'
export type { ClusterStore, ClusterRecord, CreateClusterInput } from './persistence/drizzle-cluster-store.js'
export { createClusterRoutes } from './routes/clusters.js'
export type { ClusterRouteConfig } from './routes/clusters.js'

// --- OpenAI-compatible API ---
export {
  OpenAICompletionMapper,
  createOpenAICompatCompletionsRoute,
  createModelsRoute,
  openaiAuthMiddleware,
  mapRequest,
  mapFinalStreamChunk,
  mapResponseWithTools,
  extractToolCallsFromMessages,
  validateCompletionRequest,
  generateCompletionId,
  badRequest,
  notFoundError,
  serverError,
} from './routes/openai-compat/index.js'
export type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ModelObject,
  ModelListResponse,
  OpenAIErrorResponse,
  GenerateOptions,
  MappedRequest,
  OpenAICompatCompletionsConfig,
  ModelsRouteConfig,
  OpenAIAuthConfig,
  EnhancedMappedRequest,
  ResponseToolCall,
} from './routes/openai-compat/index.js'

// --- Platform Adapters ---
export { toLambdaHandler } from './platforms/lambda.js'
export { toVercelHandler } from './platforms/vercel.js'
export { toCloudflareHandler } from './platforms/cloudflare.js'

// --- CLI ---
export { listPlugins, addPlugin, removePlugin } from './cli/plugins-command.js'
export type { PluginInfo } from './cli/plugins-command.js'
export { createDevCommand } from './cli/dev-command.js'
export type { DevCommandConfig, DevCommandHandle } from './cli/dev-command.js'
export { TracePrinter } from './cli/trace-printer.js'
export { configValidate, configShow } from './cli/config-command.js'
export { memoryBrowse, memorySearch } from './cli/memory-command.js'
export type { MemoryBrowseOptions, MemoryBrowseEntry, MemorySearchResult } from './cli/memory-command.js'
export { vectordbStatus, formatVectorDBStatus } from './cli/vectordb-command.js'
export type { VectorDBStatusResult } from './cli/vectordb-command.js'
export { runDoctor, formatDoctorReport, formatDoctorReportJSON } from './cli/doctor.js'
export type {
  CheckStatus,
  CheckResult,
  CheckCategory,
  DoctorReport,
  DoctorOptions,
  DoctorContext,
} from './cli/doctor.js'
export {
  searchMarketplace,
  filterByCategory,
  formatPluginTable,
  createSampleRegistry,
} from './cli/marketplace-command.js'
export type { MarketplacePlugin, MarketplaceRegistry } from './cli/marketplace-command.js'
export { runScorecard, parseScorecardArgs } from './cli/scorecard-command.js'
export type { ScorecardCommandOptions, ScorecardCommandResult } from './cli/scorecard-command.js'

// --- Scorecard ---
export { IntegrationScorecard } from './scorecard/index.js'
export type {
  ScorecardReport,
  ScorecardCategory,
  ScorecardCheck,
  ScorecardProbeInput,
  Recommendation,
  Grade,
  RecommendationPriority,
} from './scorecard/index.js'
export type { CheckStatus as ScorecardCheckStatus } from './scorecard/index.js'
export { ScorecardReporter, formatConsole, formatMarkdown, formatJSON } from './scorecard/index.js'
export type { ScorecardFormat } from './scorecard/index.js'

// --- Runtime ---
export { ConsolidationScheduler } from './runtime/consolidation-scheduler.js'
export { BenchmarkOrchestrator } from './services/benchmark-orchestrator.js'
export type { BenchmarkOrchestratorConfig } from './services/benchmark-orchestrator.js'
export type { ConsolidationTask, ConsolidationReport, ConsolidationSchedulerConfig } from './runtime/consolidation-scheduler.js'
export { createSleepConsolidationTask } from './runtime/sleep-consolidation-task.js'
export type {
  SleepConsolidationTaskConfig,
  SleepConsolidatorLike,
  SleepConsolidationReportLike,
} from './runtime/sleep-consolidation-task.js'
export { InMemoryQuotaManager } from './runtime/memory-quota-manager.js'
export { startRunWorker } from './runtime/run-worker.js'
export { createDefaultRunExecutor } from './runtime/default-run-executor.js'
export { createDzupAgentRunExecutor } from './runtime/dzip-agent-run-executor.js'
export { QuotaExceededError } from './runtime/resource-quota.js'
export type {
  ResourceDimensions,
  ResourceQuota,
  ResourceReservation,
  ResourceQuotaManager,
  QuotaCheckResult,
} from './runtime/resource-quota.js'
export type { RunExecutionContext, RunExecutor, StartRunWorkerOptions } from './runtime/run-worker.js'
export type { RunExecutorResult } from './runtime/run-worker.js'
export type {
  RunReflectorLike,
  ReflectionInput,
  ReflectionScore,
  ReflectionDimensions,
} from './runtime/run-worker.js'
export type { DzupAgentRunExecutorOptions } from './runtime/dzip-agent-run-executor.js'
export { reportRetrievalFeedback, mapScoreToQuality } from './runtime/retrieval-feedback-hook.js'
export type { RetrievalFeedbackSink, RetrievalFeedbackHookConfig } from './runtime/retrieval-feedback-hook.js'
export { resolveAgentTools, ToolResolutionError, getToolProfileConfig } from './runtime/tool-resolver.js'
export type {
  ToolResolverContext,
  ToolResolverResult,
  ToolResolverOptions,
  ToolSource,
  CustomToolResolver,
  ToolProfile,
  ToolProfileConfig,
} from './runtime/tool-resolver.js'
export { isStructuredResult } from './runtime/utils.js'

// --- Deploy ---
export { generateDockerfile, generateDockerCompose, generateDockerignore } from './deploy/docker-generator.js'
export type { DockerConfig } from './deploy/docker-generator.js'
export { checkHealth } from './deploy/health-checker.js'
export type { HealthCheckResult } from './deploy/health-checker.js'

// --- Deploy Confidence ---
export { DeployConfidenceCalculator } from './deploy/confidence-calculator.js'
export { DeployGate } from './deploy/deploy-gate.js'
export { DeploymentHistory, generateDeploymentId, resetIdCounter } from './deploy/deployment-history.js'
export type {
  GateDecision,
  ConfidenceSignal,
  DeployConfidence,
  ConfidenceThresholds,
  DeployConfidenceConfig,
  DeploymentRecord,
} from './deploy/confidence-types.js'

// --- Deploy History Store ---
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

// --- Deploy Signal Checkers ---
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

// --- Deploy Routes ---
export { createDeployRoutes } from './routes/deploy.js'
export type { DeployRouteConfig } from './routes/deploy.js'

// --- Security / Incident Response ---
export { IncidentResponseEngine, clearIncidentFlags, isAgentKilled, isToolDisabled, isNamespaceQuarantined } from './security/incident-response.js'
export type {
  IncidentAction,
  IncidentTrigger,
  PlaybookAction,
  IncidentPlaybook,
  IncidentActionResult,
  IncidentRecord,
  IncidentResponseConfig,
} from './security/incident-response.js'

// --- Documentation Generation (ECO-178) ---
export { DocGenerator } from './docs/doc-generator.js'
export type { DocGeneratorConfig, DocGeneratorContext } from './docs/doc-generator.js'
export { renderAgentDoc } from './docs/agent-doc.js'
export type { AgentDocInput } from './docs/agent-doc.js'
export { renderToolDoc } from './docs/tool-doc.js'
export type { ToolDocInput } from './docs/tool-doc.js'
export { renderPipelineDoc } from './docs/pipeline-doc.js'
export type { PipelineDocInput, PipelineDocNode, PipelineDocEdge } from './docs/pipeline-doc.js'

// --- PostgresRegistry (ECO-048/049) ---
export { PostgresRegistry, InMemoryRegistryStore } from './persistence/postgres-registry.js'
export type { PostgresRegistryConfig, RegistryStore, AgentRow } from './persistence/postgres-registry.js'

// --- Health Monitor (ECO-051) ---
export { HealthMonitor } from './registry/health-monitor.js'
export type { HealthMonitorConfig, ProbeResult } from './registry/health-monitor.js'

// --- Registry Routes (ECO-052) ---
export { createRegistryRoutes } from './routes/registry.js'
export type { RegistryRouteConfig } from './routes/registry.js'

// --- Streaming ---
export { streamRunHandleToSSE } from './streaming/sse-streaming-adapter.js'
export type { SSEStreamLike, StreamRunHandleToSSEOptions } from './streaming/sse-streaming-adapter.js'

// --- Version ---
export const dzupagent_SERVER_VERSION = '0.1.0'
