# Server API Surface Index

Date: 2026-07-03

Generated from `packages/server/src/index.ts` and `config/server-api-tiers.json`.

## Summary

- Unique export sources in root index: `43`
- Tier counts: stable=`31`, secondary=`12`, experimental=`0`, internal=`0`
- Recommended root exposure: keep-root=`43`, candidate-subpath=`0`, remove-root=`0`

## Current Direct Root Imports

No direct `@dzupagent/server` root imports found in scanned workspace code.

## Root Export Inventory

| Source Module | Tier | Area | Root Exposure | Export Count | Sample Exports |
| --- | --- | --- | --- | ---: | --- |
| `./app.js` | `stable` | `app` | `keep-root` | 15 | `createForgeApp`, `buildForgeApp`, `startForgeRuntime`, `RuntimeHandle` |
| `./route-plugin.js` | `stable` | `extensibility` | `keep-root` | 5 | `ServerRoutePlugin`, `ServerRoutePluginContext`, `ServerRouteMountable`, `ServerDeclaredServices` |
| `./routes/runs.js` | `stable` | `routes-core` | `keep-root` | 1 | `createRunRoutes` |
| `./routes/agents.js` | `stable` | `routes-core` | `keep-root` | 2 | `createAgentDefinitionRoutes`, `createAgentRoutes` |
| `./routes/approval.js` | `stable` | `routes-core` | `keep-root` | 1 | `createApprovalRoutes` |
| `./routes/health.js` | `stable` | `routes-core` | `keep-root` | 1 | `createHealthRoutes` |
| `./routes/events.js` | `stable` | `realtime` | `keep-root` | 2 | `createEventRoutes`, `EventRouteConfig` |
| `./routes/cost-attributor.routes.js` | `secondary` | `routes-core` | `keep-root` | 2 | `createCostAttributorRoutes`, `CostAttributorRouteConfig` |
| `./services/cost-attributor.js` | `secondary` | `runtime` | `keep-root` | 5 | `DrizzleCostAttributor`, `CostAttributor`, `CostAttributorQuery`, `CostAttributorDatabase` |
| `./middleware/auth.js` | `stable` | `middleware` | `keep-root` | 2 | `authMiddleware`, `AuthConfig` |
| `./middleware/rate-limiter.js` | `stable` | `middleware` | `keep-root` | 3 | `rateLimiterMiddleware`, `TokenBucketLimiter`, `RateLimiterConfig` |
| `./middleware/identity.js` | `stable` | `middleware` | `keep-root` | 4 | `identityMiddleware`, `getForgeIdentity`, `getForgeCapabilities`, `IdentityMiddlewareConfig` |
| `./middleware/capability-guard.js` | `stable` | `middleware` | `keep-root` | 1 | `capabilityGuard` |
| `./middleware/rbac.js` | `stable` | `middleware` | `keep-root` | 14 | `rbacMiddleware`, `rbacGuard`, `hasPermission`, `resolveRoutePermission` |
| `./middleware/tenant-scope.js` | `stable` | `middleware` | `keep-root` | 3 | `tenantScopeMiddleware`, `getTenantId`, `TenantScopeConfig` |
| `./queue/run-queue.js` | `stable` | `queue` | `keep-root` | 7 | `InMemoryRunQueue`, `RunQueue`, `RunJob`, `RunQueueConfig` |
| `./queue/bullmq-run-queue.js` | `stable` | `queue` | `keep-root` | 2 | `BullMQRunQueue`, `BullMQRunQueueConfig` |
| `./queue/postgres-run-queue.js` | `stable` | `queue` | `keep-root` | 3 | `PostgresRunQueue`, `PostgresRunQueueConfig`, `PostgresRunQueueDatabase` |
| `./metrics/queue-gauge.js` | `secondary` | `runtime` | `keep-root` | 2 | `registerQueueGauges`, `updateQueueGauges` |
| `./lifecycle/graceful-shutdown.js` | `stable` | `lifecycle` | `keep-root` | 3 | `GracefulShutdown`, `ShutdownConfig`, `ShutdownState` |
| `./ws/event-bridge.js` | `stable` | `realtime` | `keep-root` | 6 | `EventBridge`, `WSClient`, `ClientFilter`, `EventBridgeConfig` |
| `./ws/control-protocol.js` | `stable` | `realtime` | `keep-root` | 6 | `createWsControlHandler`, `WSControlClientMessage`, `WSControlServerMessage`, `WSControlHandlerOptions` |
| `./ws/authorization.js` | `stable` | `realtime` | `keep-root` | 3 | `createScopedAuthorizeFilter`, `WSClientScope`, `ScopedAuthorizeFilterOptions` |
| `./ws/scope-registry.js` | `stable` | `realtime` | `keep-root` | 1 | `WSClientScopeRegistry` |
| `./ws/scoped-control-handler.js` | `stable` | `realtime` | `keep-root` | 2 | `createScopedWsControlHandler`, `ScopedWsControlHandlerOptions` |
| `./ws/session-manager.js` | `stable` | `realtime` | `keep-root` | 2 | `WSSessionManager`, `WSSessionManagerOptions` |
| `./ws/node-adapter.js` | `stable` | `realtime` | `keep-root` | 3 | `attachNodeWsSession`, `NodeWSLike`, `AttachNodeWsSessionOptions` |
| `./ws/node-upgrade-handler.js` | `stable` | `realtime` | `keep-root` | 4 | `createNodeWsUpgradeHandler`, `createPathUpgradeGuard`, `NodeWebSocketServerLike`, `NodeWsUpgradeHandlerOptions` |
| `./events/event-gateway.js` | `stable` | `realtime` | `keep-root` | 8 | `InMemoryEventGateway`, `EventGateway`, `EventEnvelope`, `EventSubscription` |
| `./streaming/sse-streaming-adapter.js` | `stable` | `realtime` | `keep-root` | 3 | `streamRunHandleToSSE`, `SSEStreamLike`, `StreamRunHandleToSSEOptions` |
| `./platforms/lambda.js` | `stable` | `platforms` | `keep-root` | 1 | `toLambdaHandler` |
| `./platforms/vercel.js` | `stable` | `platforms` | `keep-root` | 1 | `toVercelHandler` |
| `./platforms/cloudflare.js` | `stable` | `platforms` | `keep-root` | 1 | `toCloudflareHandler` |
| `./security/input-guard.js` | `stable` | `security` | `keep-root` | 5 | `createInputGuard`, `DEFAULT_MAX_INPUT_LENGTH`, `InputGuard`, `InputGuardConfig` |
| `./security/tenant-run-quota.js` | `secondary` | `runtime` | `keep-root` | 4 | `InMemoryTenantRunQuota`, `DrizzleTenantRunQuota`, `TenantRunQuota`, `TenantRunQuotaResult` |
| `./guardrails/redis-guardrail-client.js` | `secondary` | `security` | `keep-root` | 3 | `RedisGuardrailClient`, `createRedisGuardrailClientFromConnection`, `RedisLikeConnection` |
| `./persistence/create-node-ledger.js` | `secondary` | `persistence` | `keep-root` | 1 | `createPostgresNodeLedger` |
| `./persistence/flow-artifact-store.js` | `secondary` | `persistence` | `keep-root` | 4 | `InMemoryFlowArtifactStore`, `PostgresFlowArtifactStore`, `FlowArtifact`, `FlowArtifactStore` |
| `./persistence/flow-approval-store.js` | `secondary` | `persistence` | `keep-root` | 5 | `InMemoryFlowApprovalStore`, `PostgresFlowApprovalStore`, `FlowApproval`, `FlowApprovalStatus` |
| `./runtime/adapter-meta-store.js` | `secondary` | `runtime` | `keep-root` | 4 | `InMemoryAdapterMetaStore`, `DrizzleAdapterMetaStore`, `AdapterMeta`, `AdapterMetaStore` |
| `./runtime/event-store.js` | `secondary` | `runtime` | `keep-root` | 6 | `InMemoryEventStore`, `DrizzleEventStore`, `EventStore`, `FlowEvent` |
| `./runtime/event-cursor.js` | `secondary` | `runtime` | `keep-root` | 1 | `EventCursor` |
| `./runtime/event-history-runtime.js` | `secondary` | `runtime` | `keep-root` | 1 | `EventHistoryRuntime` |

## Notes

- `stable` means keep in the root package unless a strong compatibility reason appears.
- `secondary` means supported, but a candidate for subpath exports to keep the root surface smaller.
- `experimental` means feature-rich or optional planes that should not silently define the default server contract.
- `internal` means the symbol source is currently exposed from the root index but should be treated as a root-surface leak and moved or hidden over time.

Regenerate with `yarn docs:server-api-surface`.
