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

// --- Persistence ---
export { PostgresRunStore, PostgresAgentStore } from './persistence/postgres-stores.js'
export { forgeAgents, forgeRuns, forgeRunLogs } from './persistence/drizzle-schema.js'

// --- Middleware ---
export { authMiddleware } from './middleware/auth.js'
export type { AuthConfig } from './middleware/auth.js'
export { rateLimiterMiddleware, TokenBucketLimiter } from './middleware/rate-limiter.js'
export type { RateLimiterConfig } from './middleware/rate-limiter.js'

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
export type { WSClient, ClientFilter } from './ws/event-bridge.js'

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

// --- Version ---
export const FORGEAGENT_SERVER_VERSION = '0.1.0'
