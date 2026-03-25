/**
 * @forgeagent/server — Optional HTTP/WS runtime for ForgeAgent.
 *
 * Provides: Hono REST API, run/agent persistence (Postgres + Drizzle),
 * approval management, SSE streaming, WebSocket event bridge,
 * API key authentication, rate limiting, background job queue,
 * graceful shutdown, and health/metrics endpoints.
 */

// --- App ---
export { createForgeApp } from './app.js'
export type { ForgeServerConfig } from './app.js'

// --- Routes ---
export { createRunRoutes } from './routes/runs.js'
export { createAgentRoutes } from './routes/agents.js'
export { createApprovalRoutes } from './routes/approval.js'
export { createHealthRoutes } from './routes/health.js'
export { createMemoryRoutes } from './routes/memory.js'
export type { MemoryRouteConfig } from './routes/memory.js'
export { createMemoryBrowseRoutes } from './routes/memory-browse.js'
export type { MemoryBrowseRouteConfig } from './routes/memory-browse.js'
export { createPlaygroundRoutes } from './routes/playground.js'
export type { PlaygroundRouteConfig } from './routes/playground.js'
export { createEventRoutes } from './routes/events.js'
export type { EventRouteConfig } from './routes/events.js'

// --- Persistence ---
export { PostgresRunStore, PostgresAgentStore } from './persistence/postgres-stores.js'
export { forgeAgents, forgeRuns, forgeRunLogs } from './persistence/drizzle-schema.js'

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
export type { RunQueue, RunJob, RunQueueConfig, QueueStats, JobProcessor } from './queue/run-queue.js'

// --- Lifecycle ---
export { GracefulShutdown } from './lifecycle/graceful-shutdown.js'
export type { ShutdownConfig, ShutdownState } from './lifecycle/graceful-shutdown.js'

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

// --- A2A (Agent-to-Agent) Protocol ---
export { buildAgentCard, InMemoryA2ATaskStore, createA2ARoutes } from './a2a/index.js'
export type {
  AgentCard,
  AgentCapability,
  AgentCardConfig,
  A2ATask,
  A2ATaskState,
  A2ATaskStore,
  A2ARoutesConfig,
} from './a2a/index.js'

// --- Triggers ---
export { TriggerManager } from './triggers/index.js'
export type {
  TriggerType,
  TriggerConfig,
  CronTriggerConfig,
  WebhookTriggerConfig,
  ChainTriggerConfig,
} from './triggers/index.js'

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
export {
  searchMarketplace,
  filterByCategory,
  formatPluginTable,
  createSampleRegistry,
} from './cli/marketplace-command.js'
export type { MarketplacePlugin, MarketplaceRegistry } from './cli/marketplace-command.js'

// --- Runtime ---
export { InMemoryQuotaManager } from './runtime/memory-quota-manager.js'
export { startRunWorker } from './runtime/run-worker.js'
export { createDefaultRunExecutor } from './runtime/default-run-executor.js'
export { createForgeAgentRunExecutor } from './runtime/forge-agent-run-executor.js'
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
export type { ForgeAgentRunExecutorOptions } from './runtime/forge-agent-run-executor.js'

// --- Deploy ---
export { generateDockerfile, generateDockerCompose, generateDockerignore } from './deploy/docker-generator.js'
export type { DockerConfig } from './deploy/docker-generator.js'
export { checkHealth } from './deploy/health-checker.js'
export type { HealthCheckResult } from './deploy/health-checker.js'

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

// --- Version ---
export const FORGEAGENT_SERVER_VERSION = '0.1.0'
