/**
 * @dzupagent/server — stable host/runtime primitives for DzupAgent.
 *
 * The package root is intentionally narrow. Advanced runtime helpers,
 * operational diagnostics, compatibility layers, and feature-plane APIs live
 * behind explicit subpaths:
 *
 * - @dzupagent/server/runtime
 * - @dzupagent/server/ops
 * - @dzupagent/server/compat
 * - @dzupagent/server/features
 */

// --- App ---
export { createForgeApp, buildForgeApp, startForgeRuntime } from "./app.js";
export type { RuntimeHandle } from "./app.js";
export type {
  ForgeServerConfig,
  ForgeHostRuntimeConfig,
  ForgeRouteFamiliesConfig,
  ForgeMemoryRouteFamilyConfig,
  ForgeCompatibilityRouteFamilyConfig,
  ForgeEvaluationRouteFamilyConfig,
  ForgeAdapterRouteFamilyConfig,
  ForgeAutomationRouteFamilyConfig,
  ForgeControlPlaneRouteFamilyConfig,
  ConsolidationConfig,
  MailDeliveryConfig,
} from "./app.js";

// Route plugins are the public server extension seam for app-owned product routes.
export type {
  ServerRoutePlugin,
  ServerRoutePluginContext,
} from "./route-plugin.js";

// --- Core Routes ---
export { createRunRoutes } from "./routes/runs.js";
export { createAgentDefinitionRoutes } from "./routes/agents.js";
/** @deprecated Use `createAgentDefinitionRoutes`. */
export { createAgentRoutes } from "./routes/agents.js";
export { createApprovalRoutes } from "./routes/approval.js";
export { createHealthRoutes } from "./routes/health.js";
export { createEventRoutes } from "./routes/events.js";
export type { EventRouteConfig } from "./routes/events.js";
export { createCostAttributorRoutes } from "./routes/cost-attributor.routes.js";
export type { CostAttributorRouteConfig } from "./routes/cost-attributor.routes.js";

// --- Cost Showback (S4-E) ---
export { DrizzleCostAttributor } from "./services/cost-attributor.js";
export type {
  CostAttributor,
  CostAttributorQuery,
  CostAttributorDatabase,
  TenantCostSummary,
} from "./services/cost-attributor.js";

// --- Middleware ---
export { authMiddleware } from "./middleware/auth.js";
export type { AuthConfig } from "./middleware/auth.js";
export {
  rateLimiterMiddleware,
  TokenBucketLimiter,
} from "./middleware/rate-limiter.js";
export type { RateLimiterConfig } from "./middleware/rate-limiter.js";
export {
  identityMiddleware,
  getForgeIdentity,
  getForgeCapabilities,
} from "./middleware/identity.js";
export type { IdentityMiddlewareConfig } from "./middleware/identity.js";
export { capabilityGuard } from "./middleware/capability-guard.js";
export {
  rbacMiddleware,
  rbacGuard,
  hasPermission,
  resolveRoutePermission,
  DEFAULT_ADMIN_ONLY_PATHS,
  DEFAULT_ROUTE_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
} from "./middleware/rbac.js";
export type {
  ForgeRole,
  ForgePermission,
  ForgePermissionAction,
  ForgePermissionResource,
  RBACConfig,
  ResolvedRoutePermission,
  RoutePermissionPolicy,
} from "./middleware/rbac.js";
export {
  tenantScopeMiddleware,
  getTenantId,
} from "./middleware/tenant-scope.js";
export type { TenantScopeConfig } from "./middleware/tenant-scope.js";

// --- Persistence ---
export {
  PostgresRunStore,
  PostgresAgentStore,
} from "./persistence/postgres-stores.js";

// --- Queue ---
export { InMemoryRunQueue } from "./queue/run-queue.js";
export { BullMQRunQueue } from "./queue/bullmq-run-queue.js";
export type { BullMQRunQueueConfig } from "./queue/bullmq-run-queue.js";
export { PostgresRunQueue } from "./queue/postgres-run-queue.js";
export type {
  PostgresRunQueueConfig,
  PostgresRunQueueDatabase,
} from "./queue/postgres-run-queue.js";
export type {
  RunQueue,
  RunJob,
  RunQueueConfig,
  QueueStats,
  JobProcessor,
  DeadLetterEntry,
} from "./queue/run-queue.js";

// --- Metrics (S4-F) ---
export {
  registerQueueGauges,
  updateQueueGauges,
} from "./metrics/queue-gauge.js";

// --- Lifecycle ---
export { GracefulShutdown } from "./lifecycle/graceful-shutdown.js";
export type {
  ShutdownConfig,
  ShutdownState,
} from "./lifecycle/graceful-shutdown.js";

// --- WebSocket ---
export { EventBridge } from "./ws/event-bridge.js";
export type {
  WSClient,
  ClientFilter,
  EventBridgeConfig,
} from "./ws/event-bridge.js";
export { createWsControlHandler } from "./ws/control-protocol.js";
export { createScopedAuthorizeFilter } from "./ws/authorization.js";
export { WSClientScopeRegistry } from "./ws/scope-registry.js";
export { createScopedWsControlHandler } from "./ws/scoped-control-handler.js";
export { WSSessionManager } from "./ws/session-manager.js";
export { attachNodeWsSession } from "./ws/node-adapter.js";
export {
  createNodeWsUpgradeHandler,
  createPathUpgradeGuard,
} from "./ws/node-upgrade-handler.js";
export type {
  WSControlClientMessage,
  WSControlServerMessage,
  WSControlHandlerOptions,
  WSControlAuthorizeFilter,
  WSControlAuthorizeContext,
} from "./ws/control-protocol.js";
export type {
  WSClientScope,
  ScopedAuthorizeFilterOptions,
} from "./ws/authorization.js";
export type { ScopedWsControlHandlerOptions } from "./ws/scoped-control-handler.js";
export type { WSSessionManagerOptions } from "./ws/session-manager.js";
export type {
  NodeWSLike,
  AttachNodeWsSessionOptions,
} from "./ws/node-adapter.js";
export type {
  NodeWebSocketServerLike,
  NodeWsUpgradeHandlerOptions,
} from "./ws/node-upgrade-handler.js";

// --- Events / Streaming ---
export { InMemoryEventGateway } from "./events/event-gateway.js";
export type {
  EventGateway,
  EventEnvelope,
  EventSubscription,
  EventSubscriptionFilter,
  OverflowStrategy,
  EventSink,
  InMemoryEventGatewayConfig,
} from "./events/event-gateway.js";
export { streamRunHandleToSSE } from "./streaming/sse-streaming-adapter.js";
export type {
  SSEStreamLike,
  StreamRunHandleToSSEOptions,
} from "./streaming/sse-streaming-adapter.js";

// --- Platform Adapters ---
export { toLambdaHandler } from "./platforms/lambda.js";
export { toVercelHandler } from "./platforms/vercel.js";
export { toCloudflareHandler } from "./platforms/cloudflare.js";

// --- Security / Input Guard ---
export {
  createInputGuard,
  DEFAULT_MAX_INPUT_LENGTH,
} from "./security/input-guard.js";
export type {
  InputGuard,
  InputGuardConfig,
  InputGuardResult,
} from "./security/input-guard.js";

// --- Security / Per-Tenant Concurrent-Run Quota (S4-D) ---
export {
  InMemoryTenantRunQuota,
  DrizzleTenantRunQuota,
} from "./security/tenant-run-quota.js";
export type {
  TenantRunQuota,
  TenantRunQuotaResult,
} from "./security/tenant-run-quota.js";

// --- Distributed Guardrails (P3) ---
export {
  RedisGuardrailClient,
  createRedisGuardrailClientFromConnection,
} from "./guardrails/redis-guardrail-client.js";
export type { RedisLikeConnection } from "./guardrails/redis-guardrail-client.js";

// --- Persistence Factories ---
export { createPostgresNodeLedger } from "./persistence/create-node-ledger.js";
export {
  InMemoryFlowArtifactStore,
  PostgresFlowArtifactStore,
} from "./persistence/flow-artifact-store.js";
export type {
  FlowArtifact,
  FlowArtifactStore,
} from "./persistence/flow-artifact-store.js";
export {
  InMemoryFlowApprovalStore,
  PostgresFlowApprovalStore,
} from "./persistence/flow-approval-store.js";
export type {
  FlowApproval,
  FlowApprovalStatus,
  FlowApprovalStore,
} from "./persistence/flow-approval-store.js";
export {
  InMemoryAdapterMetaStore,
  DrizzleAdapterMetaStore,
} from "./runtime/adapter-meta-store.js";
export type {
  AdapterMeta,
  AdapterMetaStore,
} from "./runtime/adapter-meta-store.js";

// --- Event-History Replay Runtime (Stage 5) ---
export {
  InMemoryEventStore,
  DrizzleEventStore,
} from "./runtime/event-store.js";
export type {
  EventStore,
  FlowEvent,
  EventType,
  AppendableFlowEvent,
} from "./runtime/event-store.js";
export { EventCursor } from "./runtime/event-cursor.js";
export { EventHistoryRuntime } from "./runtime/event-history-runtime.js";
